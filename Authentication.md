# Authentication and Authorization Review

This document describes the current authentication and authorization workflows in `cmd/next-app` for:
- Site login against Tesla Fleet API
- Trmnl plugin installation, rendering, and management

It is a code-driven review of current behavior on the current branch, not an aspirational design.

## Scope and Sources

Primary implementation files:
- `cmd/next-app/src/app/login/route.ts`
- `cmd/next-app/src/app/auth/tesla-callback/route.ts`
- `cmd/next-app/src/lib/auth-jwt.ts`
- `cmd/next-app/src/lib/auth-checks.ts`
- `cmd/next-app/src/lib/site-service.ts`
- `cmd/next-app/src/lib/tesla-client.ts`
- `cmd/next-app/src/lib/energy-repo.ts`
- `cmd/next-app/src/app/api/trmnl/setup/route.ts`
- `cmd/next-app/src/app/api/trmnl/manage/route.ts`
- `cmd/next-app/src/app/api/trmnl/markup/route.ts`
- `cmd/next-app/src/app/api/trmnl/webhook/route.ts`
- `cmd/next-app/src/app/api/trmnl/uninstall/route.ts`
- `cmd/next-app/src/lib/trmnl-auth.ts`
- `cmd/next-app/src/lib/trmnl-service.ts`

Reviewed on: February 16, 2026.

## Identity and Secrets Model

Three auth artifacts are used for different concerns:

1. `site_auth` cookie (HTTP-only JWT)
- Purpose: app session and site authorization.
- Claims: `sub` (user id), `sites` (authorized site ids), `roles`.
- Created during Tesla OAuth callback.

2. Tesla tokens in DB (`User.access_token`, `User.refresh_token`)
- Purpose: backend calls to Tesla Fleet API.
- Not set in browser cookies in the current callback flow.
- Resolved server-side from `sub`/site ownership.

3. Trmnl installation token (`TrmnlInstallation.access_token`)
- Purpose: verify plugin/device calls (markup and uninstall).
- Scoped to a Trmnl installation UUID.

## Workflow 1: Site Login via Tesla OAuth

### 1. Login entry
Route: `GET /login`
- Production login requests on another origin redirect to `https://pwusage.fm.rodeo`
  before writing cookies. Production OAuth callbacks use that same fixed origin.
  Preview/local environments retain their configured origin.
- Ignores speculative prefetch requests without issuing cookies or starting OAuth.
  Login links and client redirects use full document navigation.
- Generates a `v2.<random>` OAuth state and a random nonce. Stores each attempt in
  its own host-only, HttpOnly, SameSite=Lax cookie (`auth_attempt_<random>`), with
  Secure on HTTPS and a 10-minute lifetime. The cookie contains the nonce,
  optional return destination, and that attempt's mobile PKCE/handoff metadata.
- Multiple tabs can start and finish independent attempts in either order. New
  attempts never overwrite or clear an existing attempt. Eight pending cookies
  prevent further starts until one finishes or expires (a browser-local bound,
  not a server-side rate limiter or an atomic limit across concurrent requests).
- Redirects to Tesla authorize endpoint with required scopes.

Requested Fleet API scopes (`src/app/login/route.ts`): `openid`, `energy_device_data`,
`offline_access`, `user_data`, `energy_cmds`.

Energy scope split (read vs. write):
- `energy_device_data` ("Energy Product Information") — **read-only**: history, live
  status, `site_info`, tariff. Powers all current dashboard/Trmnl features.
- `energy_cmds` ("Energy Product Commands") — **write commands**: backup reserve
  (`POST /api/1/energy_sites/{id}/backup`), storm mode, off-grid reserve, operation mode.

A requested scope is only granted if it is also enabled for the app's domain in the
Tesla developer dashboard; Tesla silently drops scopes the app isn't registered for.
Scope additions are picked up by sending the user through `/authorize` with
`prompt_missing_scopes=true`. This replaced a long-standing `prompt=login`
parameter, which forced a full Tesla re-authentication on **every** login even
when nothing had changed. Tesla prompts only for scopes the user has not
already granted, so an unchanged login is silent.

A newly-granted scope still requires a fresh authorize redirect: our existing
refresh tokens are not retroactively upgraded. That is our token handling, not a
claim about Tesla internals — do not word it as if it were.

### 2. OAuth callback processing
Route: `GET /auth/tesla-callback`
- Validates `code` and `state`.
- For v2 state, requires the matching, unexpired attempt cookie. Never borrows
  legacy cookies or another attempt's mobile state. Clears only the matching
  attempt cookie, including on errors or Tesla denial. A missing state cannot
  identify an attempt; unrelated attempts remain untouched until expiry.
- Retains the old `auth_state`/`auth_nonce`/mobile-cookie reader for legacy logins
  already in flight during deployment. New logins never write those shared cookies.
- Verifies `state` against the saved attempt and then checks the ID-token nonce.
- Exchanges authorization code for Tesla tokens.
  The exchange `audience` is the documented Fleet host
  (`DEFAULT_FLEET_BASE_URL`), not an environment variable. Refresh grants omit
  `audience`; they send `client_id`, `client_secret`, `refresh_token`, and scope.
- Decodes `id_token` and validates `nonce`.

User and site provisioning:
- Builds stable user id from ID token `sub` (fallback email).
- Upserts `User` row with Tesla tokens.
- Calls Tesla `getProducts()` and ensures each energy site exists.
- Links each site to the user (`Site.user_id`).
- Persists latest Tesla tokens on user.

Session issuance:
- Signs `site_auth` JWT with `sites`, `roles`, `sub`, and `sv` (the user's
  `session_version`). Fresh logins (web callback and mobile exchange) stamp the
  current DB value so a login after a sign-out-everywhere bump is not treated as
  a revoked session.
- Sets `site_auth` cookie.
- Clears only this attempt's one-time cookie (legacy callbacks clear legacy cookies).
- Redirects to saved callback (or `/`).

Important implementation note:
- `auth-checks.ts` treats `site_auth` as a cache only: after verifying the JWT
  it resolves active status, `session_version`, roles, and site memberships from
  the DB on every request. Stale `sites`/`roles` claims cannot outlive the DB
  state they were derived from. Legacy `access_token` cookie fallback was removed.

Login diagnostics:
- `tesla.sign-in.started` and `tesla.sign-in.callback` share an independent,
  non-secret `loginId` and report the login kind, pending count or attempt age.
- `tesla.sign-in.continuity-rejected` distinguishes missing, invalid/expired,
  and legacy-mismatched cookies. Hostnames are logged without URLs or queries.
- State, nonce, authorization codes, PKCE values, cookie contents, and return
  destinations are never included in these events. `requestId` still correlates
  events within one request; `loginId` correlates the two requests for an attempt.
- Cookies are browser continuity checks, not an atomic server-side replay ledger.
  Tesla's authorization code and the database-backed mobile handoff keep their
  existing one-use checks.

### ID token signature verification

Tesla publishes two OIDC issuers, and each serves a **different** signing key
set:

| Issuer | JWKS |
| --- | --- |
| `https://auth.tesla.com/oauth2/v3/nts` | `/oauth2/v3/discovery/thirdparty/keys` |
| `https://auth.tesla.com/oauth2/v3` | `/oauth2/v3/discovery/keys` |

Tesla issues `/nts` tokens. We resolve the JWKS URI from the token issuer's own
discovery document and cache it for **one hour**. On a discovery failure the
resolution order is: a previously cached URI first, then a fallback keyed by the
token's issuer. The fallback defaults to the `/nts` URI for an issuer outside the
map — unreachable today, because both allowed issuers are in it and
`verifyTeslaIdToken` rejects anything else before key lookup.

Key lookup is delegated entirely to `jwks-rsa`, which memoizes per `kid` and
already refetches the full key set on an unknown `kid`, rate-limited. **Do not
add a manual JWKS refetch** — it would bypass the rate limiter and can only ever
look at the cached URI.

Attempts to validate the well-known key set directly have run into the published
keys and issued-token `kid`s being out of sync. Do not revive that approach
without a reproduced live mismatch and the revisit evidence recorded in
`TODO.md`.

The key cache is fresh for **10 minutes**, with a further **60 minutes** of
stale-serving tolerance while the JWKS endpoint is unreachable. That 70-minute
total is a deliberate bound on how long we will verify against a key set we
cannot currently refresh, not an accident of configuration; stale use is logged
loudly.

There is a degraded path (`tesla-auth-service.ts`) that completes login when
`jwks-rsa` reports `SigningKeyNotFoundError`: it bypasses signature verification
and validates the claims plus an authenticated TLS `getUserInfo` call instead.
An unreachable or rate-limited endpoint must never map to that error; those fail
closed as `invalid-id-token`.

One correction to the stronger reading of that rule: `SigningKeyNotFoundError` is
thrown from **two** sites, not one. The first ("Unable to find a signing key that
matches '\<kid\>'") is the intended case — the authoritative key set was fetched
successfully and did not contain the key. The second ("No KID specified and JWKS
endpoint returned more than 1 key") means only that the token's JOSE header
carried no `kid`, so no key could be selected; it says nothing about the key set
at all. Both map to the same error and therefore to the same bypass, which is
acceptable **only while** the second is unreachable. It is today, because the
`id_token` is minted by Tesla over TLS during a real authorization-code exchange,
so an attacker cannot strip its `kid` — but that is a property of a distant code
path, not a local invariant. It is tracked for narrowing in `TODO.md`.

### Token endpoint hosts

Tesla's documentation requires `/token` calls from application servers to use
`https://fleet-auth.prd.vn.cloud.tesla.com`, which carries different rate limits
than the browser-facing host. The OIDC discovery document still declares
`auth.tesla.com`, so `src/lib/tesla-token-endpoint.ts` tries `fleet-auth` first
and falls back to `auth.tesla.com` on transport failure or 5xx **only**.

Two cases are deliberately *not* retried against the second host:

- **4xx** — a genuine authentication failure. Retrying would mask the real error
  and re-send `client_secret` to a second origin.
- **3xx** — thrown as `TeslaTokenEndpointError`. Redirects are followed with
  `redirect: 'manual'` because a 307/308 preserves the method and body, which
  would hand `client_secret` to whatever origin the redirect names. This was
  verified against a real local server: default redirect handling re-POSTed the
  secret to the redirect target.

### Email uniqueness

`User.email` is unique case-insensitively (partial index `idx_user_email_lower`
on `LOWER(email) WHERE email IS NOT NULL`; rows with NULL email are exempt).
Both OAuth paths (verified and degraded) reconcile logins to an existing
account by email before upserting, and the upsert retries once on a unique
violation to handle concurrent first logins. This prevents the account
splitting that previously occurred when the degraded path keyed a User row by
email and a later verified login keyed a second row by Tesla `sub`.


### 3. Runtime authorization checks

Common checks (all DB-derived after JWT verification):
- `verifySiteAccess(siteId)` in `auth-checks.ts`: verifies the `site_auth` JWT,
  then checks the user is active, that the token's `sv` is not behind the DB
  `session_version`, and authorizes against DB site memberships and roles.
- `SiteService.validateSiteAccess(siteId)`: same checks, then Tesla API fallback if client exists.

Protected surfaces include:
- Site pages (`/site/[id]`)
- Server actions for settings updates
- API routes like `/api/hourly-data`, `/api/site-live-data`, `/api/site/[id]/analysis`

### 4. Session refresh behavior

Middleware/proxy (`src/proxy.ts`):
- On each request with `site_auth`, checks token expiry window.
- If near expiry, re-signs and resets `site_auth` cookie (sliding session,
  7-day expiry with a 30-day absolute cap from `orig_iat`).
- Refresh re-derives roles and sites from the DB and refuses to refresh when:
  - the user is missing or not active, or
  - the token's `sv` is behind the DB `session_version` (revoked by
    sign-out-everywhere). Re-stamping the new `sv` here would auto-un-revoke a
    stolen session, so refusal is permanent until re-auth.
- Tokens without `sv` (legacy) are treated as `sv: 0`: they refresh and migrate
  to the current DB version only while the DB version is still 0.

Tesla token refresh behavior:
- `TeslaClient` retries once on Fleet API 401 when refresh token exists.
- `TeslaTokenRepo.getLockedRefreshHandler(siteId)` serializes refresh with DB lock fields on `User`.
- Refreshed Tesla tokens are written back to `User`.
- Terminal auth failures can mark user `auth_status='revoked'`.

### 5. Logout
Local logout — Route: `GET|POST /logout`
- Deletes `site_auth` cookie and redirects to `/`. Does not bump
  `session_version`; other devices stay signed in.

Sign out everywhere — Route: `POST /api/auth/sign-out-everywhere`
- Requires an authenticated user (with origin/`sec-fetch-site` checks as
  CSRF defense in depth).
- Increments `User.session_version`, which revokes every outstanding `site_auth`
  JWT on every device: each request blocks on the `sv` mismatch and the proxy
  refuses to renew the cookie. Re-authentication issues a token stamped with the
  new version. The caller's cookie is cleared in the same response.

### Troubleshooting: "passkey failed" on auth.tesla.com

Tesla supports passkeys as an account sign-in credential. A passkey that a
password manager offers for `auth.tesla.com` will be **rejected by Tesla** if it
was never enrolled through Tesla's own account security page — Tesla holds no
public key to verify it against. The symptom is a "passkey failed" error on
Tesla's page while the password manager insists the passkey is valid.

Resolution: enroll the passkey at
`https://accounts.tesla.com/account-settings/security`, then sign in normally.
Nothing in this app needs to change; the failure happens entirely on Tesla's
origin before our callback runs.

## Workflow 2: Trmnl Install and Configuration

### 1. Install page bootstrap
Page: `/trmnl/install`
- Reads Trmnl callback params (`code`, `installation_callback_url`, optional UUID hints).
- Calls `/api/sites` to list authorized sites.
- If unauthorized, redirects to `/login` with callback back to install URL.

### 2. Setup API (link site to Trmnl installation)
Route: `POST /api/trmnl/setup`
- Requires `{ code, site_id }`.
- Verifies user can access `site_id` via `verifySiteAccess`.
- Exchanges Trmnl OAuth code for Trmnl access token.
- Resolves device UUID via:
1. OAuth payload fields
2. JWT payload decode attempt
3. Trmnl `/api/me`
- Creates/updates `TrmnlInstallation` with `site_id`, `uuid` (if known), plugin setting id, and Trmnl token.

Pending flows:
- If UUID lookup fails, records a pending installation (with or without `plugin_setting_id`) for later claim by webhook.

### 3. Webhook finalization
Route: `POST /api/trmnl/webhook`
- Accepts webhook payload with `user.uuid` and `plugin_setting_id`.
- If installation exists by UUID, updates details.
- Else claims pending installation record (plugin-id match first, then latest loose pending).
- Also opportunistically backfills user email when possible.

### 4. Manage page and manage API
Page: `/trmnl/manage?uuid=...&token=...`
- Fetches current install plus sites via `/api/trmnl/manage` and `/api/sites`.
- If unauthorized, redirects to login with callback preserving UUID/token.

Route: `GET /api/trmnl/manage`
- Authorizes with either:
1. Valid Trmnl JWT (`token` query) for UUID, or
2. Valid `site_auth` ownership fallback for an existing installation (user must own the currently linked site, unless admin).
- Returns current linked `site_id` and `plugin_setting_id`.

Route: `POST /api/trmnl/manage`
- Requires `{ uuid, site_id }`.
- Primary auth: verify Trmnl JWT (`token`) for UUID.
- Fallback auth: if no valid Trmnl JWT, allow re-auth only for existing installation when `site_auth` user owns currently linked site.
- Always validates access to target `site_id` before relinking.
- Upserts `TrmnlInstallation(uuid, site_id)`.

### 5. Markup rendering and uninstall protection

Route: `GET /api/trmnl/markup`
- UUID mode:
1. Loads installation by UUID.
2. Verifies `Authorization: Bearer <token>` matches stored Trmnl installation token.
3. Renders markup using linked site data.
- Preview mode (`site_id` query):
1. Requires app auth via `verifySiteAccess(site_id)`.
2. Used by internal preview UI.

Route: `POST /api/trmnl/uninstall`
- Requires `user_uuid` in payload.
- Requires bearer token matching stored Trmnl installation token.
- Deletes installation (idempotent success if already missing).

## Workflow 3: Native iOS login handoff

The native iOS client uses the same `site_auth` JWT and the same site authorization
checks as the website. It does not receive Tesla tokens and does not depend on
cookies being shared between `ASWebAuthenticationSession` and the app's
`URLSession`.

1. The app creates a PKCE verifier, its SHA-256 challenge, and a random app state,
   then opens `/login?mobile_challenge=...&mobile_state=...` in
   `ASWebAuthenticationSession`.
2. `/login` validates the challenge/state formats and stores them in the isolated
   attempt cookie with a random handoff attempt UUID. It then uses the existing
   Tesla OAuth state and nonce flow.
3. The normal Tesla callback validates OAuth state and nonce and provisions the
   user/sites as it does for web login. For the mobile path only, it stores a
   five-minute handoff row containing the user/site/role claims, PKCE challenge,
   app state, attempt UUID, expiry, and a SHA-256 hash of a random opaque code.
   The browser is redirected only to the fixed `pwusage://auth/callback` scheme,
   host, and path. That URL contains the opaque code, attempt UUID, and app state;
   it never contains the site JWT or Tesla tokens. No `site_auth` cookie is issued
   to the browser for this mobile flow.
4. The app POSTs the code, attempt UUID, app state, and PKCE verifier to
   `/api/mobile/session` using its own `URLSession`. One conditional SQL UPDATE
   atomically consumes only a matching, unexpired, unconsumed handoff. The
   verifier is hashed and compared to the stored challenge. Replays, wrong state,
   wrong attempt, expired code, and wrong verifier fail closed. The route accepts
   only `application/json`; a supplied `Origin` must match the pwusage origin,
   and `Sec-Fetch-Site: cross-site` is rejected. It does not require `Origin`,
   since URLSession requests may omit it.
5. Before issuing a session, the exchange reloads the user and current site
   assignments. Inactive/missing accounts and sites no longer assigned to the
   account are rejected. The response sets the existing `site_auth` cookie with
   `HttpOnly`, `SameSite=Lax`, path `/`, and `Secure` on HTTPS (always in
   production). URLSession stores the cookie and sends it to existing APIs such as
   `/api/site-live-data` and `/api/mobile/bill-summary`; those routes continue to
   call `verifySiteAccess`.

The iOS app and its widget extension share the persistent `site_auth` cookie via
Foundation's App Group cookie store (separate Debug and Release groups). The app
migrates an existing app-private session once and removes the old copy, so logout
cannot restore it. On a fresh install, startup maintenance deletes any `site_auth`
cookie left in the shared jar before the app makes an authenticated request, so a
previous install's session is not adopted. Widget timeline requests use the same
site authorization checks as the app. The extension only requests the app-selected
site, discards in-flight results after that selection is cleared/changed, and hides
data on HTTP 401/403. Credentials remain in the system cookie store, outside the
presentation JSON files.

Handoff rows are used only during login. Creating a handoff deletes at most 100
expired rows, keeping cleanup bounded and preventing indefinite table growth
during normal login activity. Dashboard polls
do not query the handoff table. The migration enables RLS, revokes access from
`PUBLIC`, `anon`, and `authenticated`, and grants access to `service_role`.

The existing proxy still performs sliding JWT renewal. Renewal reloads active
user status, roles, and site assignments near token expiry. `/logout` clears the
same cookie and works from the app's URLSession. A connected server test passes
the exchange-issued cookie through `verifySiteAccess`, confirms site isolation,
then exercises proxy renewal after a site assignment changes, revoked-user
denial, and logout clearing. The test uses controlled handoff/repository
fixtures; it does not apply or connect the migration. Cookie persistence across
app launches, renewal, expiry, logout, and the custom URL callback still require
simulator and device verification in the native app implementation.

## Authorization Decision Summary

- Human user auth: `site_auth` JWT in cookie, verified per request against DB state (active status, `session_version`, roles, site memberships). Revocation via `POST /api/auth/sign-out-everywhere` bumps `session_version` and invalidates all outstanding JWTs.
- Human user site-level authorization: DB site memberships and roles (or `SiteService` Tesla API fallback on specific server paths that instantiate a Tesla client).
- Device/plugin auth: Trmnl JWT validation (`/api/trmnl/manage`) or installation bearer token (`/api/trmnl/markup`, `/api/trmnl/uninstall`).
- Tesla backend API auth: tokens from `User` table, auto-refreshed server-side.

## Current Open Gaps

No known auth gaps as of February 16, 2026.
