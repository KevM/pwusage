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
- Encrypted at rest (see "Tesla token encryption" below). Read and write them only
  through the repos (`UserRepo`, `SiteRepo`, `TeslaTokenRepo`), never with raw SQL.

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
- Builds stable user id from ID token `sub` (fallback email), and binds the
  login to that Tesla subject (see "Email uniqueness" below): an account keyed
  by a different subject is never adopted, even when the email matches.
- Looks up whether the `User` row already exists. A **new** account has its
  Fleet products fetched first: if the list loads but holds no energy product,
  nothing is stored (no `User` row, no tokens, no session) and the web callback
  redirects to `/no-sites?reason=no-products` (the native app gets `no_sites`).
  Existing users are always stored, so one who lost every product (for example
  after a change of ownership) can still sign in and manage or delete the
  account. A failed Fleet lookup is not "no products": the account is stored so
  the rotated refresh token survives, and the result is `fleet-api-failed`.
  The never-stored Tesla grant is simply dropped; nothing else depends on it.
- Upserts `User` row with Tesla tokens.
- Calls Tesla `getProducts()` (once; reused from the new-account check) and ensures each energy site exists.
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
- `tesla.sign-in.result` carries `outcome`, plus `reason` (`region`, `upstream`
  or `sites`) for `fleet-api-failed` and `statusCode` for `token-exchange-failed`.
  The step that failed has its own event: `tesla.sign-in.products-failed`,
  `tesla.sign-in.membership-sync-failed` and `tesla.sign-in.site-assign-failed`
  (with `siteId`) carry `errorName`, `errorCode`, `constraint` and `errorStatus`
  from `errorFields()`, never the error message. `tesla.sign-in.no-energy-products-not-stored` (a new product-less account was not stored), `tesla.sign-in.no-sites` and
  `tesla.sign-in.sites-resolved` report `productCount`, `importableCount`,
  `resolvedCount` and which path ran (`membershipEnabled`). All use the hashed
  `accountId`.
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

Tesla's documented server token host is
`https://fleet-auth.prd.vn.cloud.tesla.com`. Authorization-code exchange retains
fallback to `auth.tesla.com` on transport failure or 5xx. Refresh exchange does
**not** fall back or replay after invoking fetch: a lost response, 5xx, redirect,
or malformed/truncated success may conceal a consumed grant. Redirects remain
manual so secrets cannot be forwarded to a response-selected origin.

Refresh classification uses HTTP status and allowlisted OAuth codes, never
message substrings or arbitrary response text. Only 400/401 `invalid_grant` or
`login_required` confirms credential rejection. Client configuration codes such
as `invalid_client` and `unauthorized_client` are separate. Bare 401 and ambiguous
responses require reconnect without claiming Tesla revoked permission.

### Email uniqueness

`User.email` is unique case-insensitively (partial index `idx_user_email_lower`
on `LOWER(email) WHERE email IS NOT NULL`; rows with NULL email are exempt).
Both OAuth paths (verified and degraded) reconcile logins to an existing
account by email before upserting, and the upsert retries once on a unique
violation to handle concurrent first logins. This prevents the account
splitting that previously occurred when the degraded path keyed a User row by
email and a later verified login keyed a second row by Tesla `sub`.

Reconciliation is bound to the Tesla subject. `User.tesla_subject` (unique,
migration `20261118193518`) records the Tesla ID-token `sub` an account belongs
to; the migration backfills it from every subject-keyed id (ids without `@`).

A login's subject is **trusted** only when the ID-token signature verified, or,
on the unknown-signing-key path, when Fleet user info confirmed it (`sub`/`id`
or `vault_uuid`). An unconfirmed `sub` is never used to find, adopt or bind an
account. The ordinary lookup, the unknown-signing-key path and the
unique-violation retry all resolve the account the same way
(`reconcileAccount` / `mayAdoptAccountByEmail` in `tesla-auth-service.ts`):
- The account bound to the trusted subject wins, even if the Tesla email changed.
- Otherwise the account that owns the email is adopted only by a login with a
  trusted subject, and only if it is unbound and either a legacy row keyed by an
  email address (its id contains `@`; a Tesla `sub` never does), which is the
  intended migration of pre-fix accounts, or a row keyed by that same subject.
- A login without a trusted subject never adopts or writes an existing account,
  bound or not (an email alone cannot prove which Tesla account a row belongs
  to). It may only create a new account, which stays unbound until a trusted
  login binds it.
- `UserRepo.upsertOnTeslaAuth` enforces the same rules in the statement that
  writes the credentials: an unbound row takes the trusted subject, a bound row
  accepts only its own subject, and a login without a trusted subject can only
  insert a new row. So a legacy account is bound to the first trusted subject
  that migrates it, and every later login must present that subject.
- Anything else is two distinct Tesla subjects sharing an email (or a login that
  cannot prove its subject). The login fails closed with `identity-conflict`
  before any write: no credentials stored, no memberships or sites changed, no
  session or mobile handoff issued. The web callback answers 409; the native app
  receives `error=account_conflict`. The event `tesla.sign-in.identity-conflict`
  carries hashed ids of both accounts, the stage (`lookup`, `unique-retry` or
  `bind`) and whether the subject was trusted. Resolving such a conflict is a
  manual admin task.

Consequence: while Tesla's signing key is unknown and Fleet user info does not
confirm the `sub`, no existing account can sign in (it fails closed with
`identity-conflict`); only a brand-new account can be created. Existing users
sign in again normally once the signature verifies.


### 3. Runtime authorization checks

Common checks (all DB-derived after JWT verification via `validateSessionAgainstAuthState`):
- `verifySiteAccess(siteId)` in `auth-checks.ts`: verifies the `site_auth` JWT,
  then checks the user is active, that the token's `sv` is not behind the DB
  `session_version`, that `orig_iat` does not predate account creation
  (`tokenPredatesAccount`), and authorizes against DB site memberships and roles.
- `SiteService.getAuthorizedSites()` and `SiteService.validateSiteAccess(siteId)`:
  apply the same `validateSessionAgainstAuthState` checks (including
  `tokenPredatesAccount`), then Tesla API fallback if client exists.

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

Tesla token encryption:
- `User.access_token` and `User.refresh_token` are stored as
  `enc:v1:<keyId>:<iv>:<ciphertext+tag>` (AES-256-GCM, AAD `User:<column>:<userId>`),
  so a value cannot be replayed into another row or column. Implementation:
  `cmd/next-app/src/lib/token-crypto.ts`.
- Keys come from environment variables, not the database, so database access or a
  backup alone cannot decrypt: `TOKEN_ENCRYPTION_KEYS` (`id:base64,id:base64`, 32-byte
  keys, **first is active**) and `TOKEN_FINGERPRINT_KEY` (separate 32-byte base64 key).
  Both are required wherever tokens are written. Generate with
  `openssl rand -base64 32`.
- Rotating encryption keys: see "Rotating `TOKEN_ENCRYPTION_KEYS`" below.
- `TOKEN_ENCRYPTION_KEYS` values must be canonical base64 of 32 bytes; surrounding
  whitespace or quotes are tolerated, typos are rejected.
- Reads decrypt, and pass legacy plaintext through so deploying before the backfill is
  safe. Writes always encrypt. The backfill `scripts/encrypt-tesla-tokens.ts` is
  idempotent and guarded by the exact old values, so a concurrent rotation wins.
- Random-IV ciphertext cannot be compared, so the refresh compare-and-swap uses
  `User.refresh_token_fp` (HMAC-SHA256 of the refresh token). See `DesignDecisions.md`.
- TRMNL tokens are not covered; they remain a separate follow-up.

Rotating `TOKEN_ENCRYPTION_KEYS` (runbook; example `k2` to `k3`):

Production and Preview/beta have separate keys; repeat per environment. Vercel never
shows a sensitive value again, so **save every key in 1Password before sending it to
Vercel** and use a new key id each time (a reused id makes a lost key look like a
corrupt ciphertext).

1. Generate: `NEW=$(openssl rand -base64 32)`; save `k3:$NEW` in 1Password.
2. Prepend, keeping the old key so existing rows still decrypt:
   `vercel env rm TOKEN_ENCRYPTION_KEYS production --yes`, then
   `printf 'k3:%s,k2:%s' "$NEW" "<old key>" | vercel env add TOKEN_ENCRYPTION_KEYS production --sensitive`.
   Deploy and wait until it is live (new writes now use `k3`). **Env var changes apply only
   to new deployments, and saving the variable does not deploy.** Confirm the new
   deployment id is actually serving (Vercel shows it Ready and Current, and Axiom shows
   events from its id) before step 3. The backfill writes `k3` rows; a deployment still
   running without `k3` cannot read them, and every Tesla token read fails (TRMNL
   markup, crons, the app) until it is replaced. This caused a ~35 minute outage when
   the first rotation was backfilled before the redeploy went live.
3. Re-encrypt every row: from `cmd/next-app`, export `DATABASE_URL`, the same
   `TOKEN_ENCRYPTION_KEYS` (`k3:...,k2:...`) and the existing `TOKEN_FINGERPRINT_KEY`,
   then run `npx tsx scripts/encrypt-tesla-tokens.ts --dry-run` and the real run. Re-run
   until `scanned=0`. `raced` rows were rewritten by a live refresh and need nothing.
   Dormant and revoked users never refresh, which is why the backfill is required.
4. Verify (read-only), expecting 0:
   `SELECT count(*) FROM "User" WHERE (NULLIF(access_token,'') IS NOT NULL AND access_token NOT LIKE 'enc:v1:k3:%') OR (NULLIF(refresh_token,'') IS NOT NULL AND refresh_token NOT LIKE 'enc:v1:k3:%');`
5. Retire the old key: set `TOKEN_ENCRYPTION_KEYS` to `k3:<new>` only and deploy, and
   confirm the new deployment is serving as in step 2.
6. Keep `k2` archived in 1Password for as long as the oldest database backup
   (`docs/database-backups.md`): a restored backup still holds `k2` rows.

Failure modes (logs carry the `TokenCryptoError` code, since error messages are not
exported: `KEY_ID_UNKNOWN` = the running deployment lacks a key a row was written with,
usually an un-deployed env change; `DECRYPT_FAILED` = wrong key material for that id or a
copied ciphertext; `KEYS_NOT_CONFIGURED` / `KEY_INVALID` = bad env value):
- Reads throw `No TOKEN_ENCRYPTION_KEYS entry for key id`: a key was removed before the
  backfill finished. Re-add it, deploy, re-run the backfill.
- A key is lost: rows under it are unrecoverable. Rotate to a new key id so those rows are
  identifiable, then null the affected users' `access_token`, `refresh_token` and
  `refresh_token_fp` and set `tesla_refresh_state = 'reconnect_required'`,
  `auth_status = 'revoked'` so they sign in again.

`TOKEN_FINGERPRINT_KEY` cannot be rotated: the backfill does not recompute existing
fingerprints, so changing it makes every refresh compare-and-swap fail. Supporting it
would need a code change (recompute `refresh_token_fp` from the decrypted token).

Tesla token refresh behavior:
- All production refresh callers share the account-level coordinator. Its atomic
  lease claim records `in_flight`, a UUID attempt ID, generation, and start time
  **before** dispatch, and only claims the refresh credential the caller holds:
  a stale caller adopts the stored rotation instead. An expired lease returns to
  `ready` with a two-minute retry floor counted from lease expiry (so a lease
  found long after it died is claimed in the same pass), keeping its attempt ID.
  Verification releases dead leases too. Parallel requests on one client judge a
  401 by the credentials they sent, so only one of them refreshes.
- Rotated credentials, the next generation and the lease release are saved in
  one statement, guarded by the original generation, attempt ID and refresh
  credential fingerprint (not the lease clock), with one retry. Newer OAuth login wins over
  stale completions. Acknowledgement loss cannot authorize another exchange of
  the previous generation.
- `not_dispatched` and `configuration_rejected` return to `ready` with a
  fifteen-minute retry floor; unknown outcomes (429, 5xx, transport, lost body)
  with a two-minute floor, then the same grant is retried. Only definitive
  credential rejection becomes `reconnect_required` with `auth_status=revoked`.
  During a retry floor, Fleet requests fail fast with `TeslaRefreshBackoffError`.
- The dev/beta database copy clears `User` Tesla tokens (and `refresh_token_fp`): a second holder of a
  single-use grant races prod (see `docs/dev-database-copy.md`).
- `is_active` is account eligibility, independent of Tesla health. Refresh and
  verification never deactivate an account. OAuth replaces credentials and
  advances generation while preserving existing eligibility and session version.
  The refresh-outcomes migration reactivates historical inactive accounts (all
  were deactivated by Tesla health) so they can reconnect.
- The detached exchange retains PR #251's independent 18-second deadline,
  request `after()` lifetime, one-second save/cleanup deadlines, and conditional
  cleanup. A caller can stop waiting without canceling a dispatched exchange.
  Process death and response loss still cannot be transparently recovered.
- `TESLA_REFRESH_PAUSED=1` blocks new coordinated refresh exchanges. It does not
  cancel running exchanges or disable login. See the cutover requirements in the
  [operations guide](docs/tesla-auth-remediation-operations.md).
- Every live request rechecks persisted connection state and eligibility. API
  `409` with `code=TESLA_CONNECTION_REQUIRED` means “Reconnect Tesla to update
  your data.” It does not invalidate an otherwise valid app session. Existing
  suspension, session-version revocation, roles, and site ownership checks remain.
- Web/iOS retain authorized stored readings and source timestamps. iOS disables
  unavailable battery commands; widgets preserve cached data on reconnect and
  still discard it on app authorization rejection. TRMNL authenticates its own
  installation token and renders stored data without awaiting Tesla. Its
  background refresh is suppressed for unresolved generations, and stale SoC
  is unknown rather than fresh.
- Structured events correlate `exchangeId`, hashed `accountId` and `generationId`,
  request context, stage, duration, status, and allowlisted error code. Confirmed
  transitions have `persisted=true` and `fromState`/`toState`. Superseded writes
  emit separate events. Credentials, OAuth codes, bodies, and arbitrary error
  messages are never diagnostic fields. Start/outcome/login checkpoints use the
  existing bounded Axiom delivery; runtime logs remain the delivery fallback.

Account verification (`UserRepo.verifyUserStatus`):
- Captures PostgreSQL `xmin` before checking Fleet, then fences health writes
  with that version and current site ownership. Inactive/unresolved accounts
  do not dispatch a probe. A healthy probe cannot clear refresh uncertainty.
- All outcomes preserve eligibility. Fleet access rejection records `error`,
  not refresh-token revocation. Only a typed refresh rejection proves that
  generation unusable; ordinary endpoint 401/403 is insufficient evidence.
- A concurrent login, refresh, suspension, or session-version change supersedes
  the check. It reports retained state and leaves `last_checked_at` unchanged.
  No transaction/row lock spans a Tesla call; membership guards use the final
  statement snapshot. Even a rotation triggered by the probe supersedes it.

### 5. Logout
Local logout — Route: `POST /logout`
- Signing out takes an intentional POST: the web header's form, or the iOS app's
  URLSession request. The same origin/`sec-fetch-site` check as
  sign-out-everywhere (`isCrossOriginRequest`) runs first; a cross-origin POST
  gets 403 and the cookie is left alone. A request without `Origin` is allowed,
  because URLSession may omit it.
- Clears `site_auth` (`Max-Age=0`, path `/`) and answers `303` to `/`, so the
  browser follows with `GET /` instead of re-posting to the home page.
- `GET /logout` never signs out (a link, prefetch or image must not end a
  session): it answers `405` with `Allow: POST`.
- Does not bump `session_version`; other devices stay signed in.

Sign out everywhere — Route: `POST /api/auth/sign-out-everywhere`
- Requires an authenticated user (with origin/`sec-fetch-site` checks as
  CSRF defense in depth).
- Increments `User.session_version`, which revokes every outstanding `site_auth`
  JWT on every device: each request blocks on the `sv` mismatch and the proxy
  refuses to renew the cookie. Re-authentication issues a token stamped with the
  new version. The caller's cookie is cleared in the same response.
- In the same statement, revokes every connection: all of the user's
  `OAuthGrant` rows (connected AI apps and integration tokens) and their
  tokens, so MCP calls and integration polls fail at once. Each app must be
  connected again and each script given a new integration token. Pending OAuth authorization codes
  stop redeeming because they are stamped with the old `session_version`.

### 6. Account deletion
Page: `/account-delete` (signed-out visitors go through `/login?callback=/account-delete`;
`/auth/tesla-callback` issues a `site_auth` cookie for that callback even when the
account has 0 Powerwall sites).
Route: `DELETE /api/user`
- Requires an authenticated user and `{ "confirm": "DELETE", "deleteSiteIds": [...] }`
  (`deleteSiteIds` is optional: shared sites to delete for every member instead of just leaving; default is leave), with the same
  origin/`sec-fetch-site` checks as sign-out-everywhere (`isCrossOriginRequest`).
- Restores any active Battery Saver session on sites being deleted (including shared sites
  chosen for deletion) or where no other usable member remains, because deleting the last member removes the record the restore relies
  on. If Tesla needs reconnecting or the restore cannot be confirmed, it returns
  `409`, keeps the account and keeps the session.
- Deletes in one transaction (`AccountDeletionRepo`), locking the `User` and `Site`
  rows in deterministic `ORDER BY id` order so a new Battery Saver session cannot
  slip in. Removes the user's `MobileLoginHandoff`, `TrmnlInstallation`
  (`installed_by_user_id`), and `SiteMember` rows; for sites with no remaining
  members, `EnergyDayArchive` goes first (because `EnergyDaySummary` has `NO ACTION`
  keys to `Tariff` and `TariffSchedule`) followed by `Site`, and finally `User`.
  Surviving shared sites repair their Tesla connection (`SiteRepo.repairConnection`).
- Clears the caller's `site_auth` cookie. Other devices are rejected on their next
  request, because `resolveAuth` no longer finds the user.
- Does not call Tesla to revoke tokens: Tesla documents no revocation endpoint for third
  parties. `/account-delete/done` links to Tesla's consent page
  (`auth.tesla.com/user/revoke/consent`) as an optional step. Revoking must follow
  deletion, since pwusage needs the grant to restore the reserve.

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
- Resolves device UUID exclusively from provider credentials via:
  1. OAuth payload fields
  2. JWT payload decode attempt
  3. Trmnl `/api/me`
- Any client-supplied `uuid` is treated as a hint only: mismatches against the
  provider UUID are rejected with `403`, and an unverified client `uuid` is
  never used when provider UUID resolution fails.
- If the resolved device UUID already exists on another site, requires
  ownership of that existing site (or admin role) and enforces the ownership
  condition atomically at the SQL write (`WHERE "TrmnlInstallation".site_id = ANY(...)`).
- Creates/updates `TrmnlInstallation` with `site_id`, `uuid` (if known), plugin setting id, and Trmnl token.

Pending flows:
- If UUID lookup fails, records a pending installation (with or without `plugin_setting_id`) for later claim.

### 3. Webhook finalization
Route: `POST /api/trmnl/webhook`
- Accepts webhook payload with `user.uuid` and `plugin_setting_id`.
- For opaque-token webhooks, verifies the token against stored `access_token`
  values (existing UUID row, pending `plugin_setting_id` row, or recent loose
  pending rows within 15 minutes) and carries that exact authenticated row
  through to the write.
- For signed JWT webhooks, matches by verified `uuid` or `plugin_setting_id`;
  if neither correlates to an installation, loose pending rows are left
  untouched for authenticated completion.
- Pending claims execute atomically (`WHERE id = $4 AND uuid IS NULL AND (plugin_setting_id IS NULL OR plugin_setting_id = $2)`):
  legitimate retries by the same device are idempotent (`200`), while competing
  claims return `409`.
- Also opportunistically backfills user email when possible.

### 4. Manage page and manage API
Page: `/trmnl/manage?uuid=...&token=...` (provider launch format)
- Immediately strips `token`, `jwt`, and `handoff` from the visible browser URL
  via `history.replaceState` and keeps the credential out of subsequent API URLs
  and login return URLs.
- Fetches current install and sites via `GET /api/trmnl/manage?uuid=...`
  (passing any TRMNL JWT in the `Authorization: Bearer` header) and `GET /api/sites`.
- If unauthorized (`401`) while holding a TRMNL JWT, exchanges it via
  `POST /api/trmnl/manage/handoff` for a short-lived server-side
  `TrmnlManageHandoff` ID bound to an HttpOnly `trmnl_manage_binding` cookie and
  `uuid`, then redirects to `/login?callback=/trmnl/manage?uuid=...&handoff=...`.
  On return, `POST /api/trmnl/manage/handoff/consume` atomically redeems the
  one-time handoff.

Route: `GET /api/trmnl/manage`
- Authorizes with either:
  1. Valid Trmnl JWT (`Authorization: Bearer` / `X-Trmnl-Token` header) for UUID, or
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
   app state, attempt UUID, expiry, a SHA-256 hash of a random opaque code, and
   the account's `session_version`, read in the same INSERT statement.
   The browser is redirected only to the fixed `pwusage://auth/callback` scheme,
   host, and path. That URL contains the opaque code, attempt UUID, and app state;
   it never contains the site JWT or Tesla tokens. No `site_auth` cookie is issued
   to the browser for this mobile flow.
4. The app POSTs the code, attempt UUID, app state, and PKCE verifier to
   `/api/mobile/session` using its own `URLSession`. One conditional SQL UPDATE
   atomically consumes only a matching, unexpired, unconsumed handoff whose
   `session_version` still equals the account's. The verifier is hashed and
   compared to the stored challenge. Replays, wrong state, wrong attempt, expired
   code, wrong verifier, a handoff revoked by sign-out-everywhere, and a handoff
   row with no `session_version` (written before that column existed) fail closed. The route accepts
   only `application/json`; a supplied `Origin` must match the pwusage origin,
   and `Sec-Fetch-Site: cross-site` is rejected. It does not require `Origin`,
   since URLSession requests may omit it.
5. Before issuing a session, the exchange reloads the user and current site
   assignments. Inactive/missing accounts and sites no longer assigned to the
   account are rejected, and so is a handoff whose version no longer matches the
   reloaded account (a sign-out-everywhere that commits after the consume). The
   token is stamped with the handoff's `session_version`, never a newer value read
   later, so an exchange that overlaps revocation cannot mint a usable cookie on the
   older handoff's authority. A fresh login after revocation creates a handoff
   under the new version and succeeds. The response sets the existing `site_auth`
   cookie with `HttpOnly`, `SameSite=Lax`, path `/`, and `Secure` on HTTPS (always
   in production). The app's exchange request opts out of URLSession cookie
   handling (`httpShouldHandleCookies = false`) and returns the cookie to
   `MobileAuthService`, which stores it only while that sign-in attempt still owns
   the sign-in (see below). Later requests send it to existing APIs such as
   `/api/site-live-data` and `/api/mobile/bill-summary`; those routes continue to
   call `verifySiteAccess`.

Native sign-in ownership of the cookie (`MobileAuthService`): the ownership check
and the store run together on the main actor with no suspension between them. A
sign-in cancelled after its exchange started, superseded by a newer attempt, or
ended by logout/session expiry drops its credential unstored. So a cancelled
first sign-in leaves no cookie for the next launch to find, a cancelled reconnect
keeps the session the app already had, and a late response cannot replace or erase
a newer sign-in's cookie. Logout and session invalidation clear the local cookie
before their first suspension; the server `/logout` request also opts out of
cookie handling, so its cookie deletion cannot land on a newer session.

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
`session_version` was added later (`20261118191802`) as a nullable column, so rows
written by the previous deploy remain readable and are simply rejected; they expire
within five minutes. A database-backed test
(`session-revocation-postgres.test.ts`) covers creation, revocation, then exchange;
the race with the consume; a fresh login after revocation; and a pre-column row.

The existing proxy still performs sliding JWT renewal. Renewal reloads active
user status, roles, and site assignments near token expiry. `POST /logout` clears
the same cookie and works from the app's URLSession without an `Origin` header. A connected server test passes
the exchange-issued cookie through `verifySiteAccess`, confirms site isolation,
then exercises proxy renewal after a site assignment changes, revoked-user
denial, and logout clearing. The test uses controlled handoff/repository
fixtures; it does not apply or connect the migration. Cookie persistence across
app launches, renewal, expiry, logout, and the custom URL callback still require
simulator and device verification in the native app implementation.

## Integration tokens

Signed-in home members can create and revoke their own integration tokens in
the web app under **Site Settings → Connections**. The token (`pwu_int_…`) is
shown once.

An integration token is an `OAuthGrant` of kind `token`, so it shares the
store, the bearer check and the revocation path with connected AI apps (see
[DesignDecisions.md](./DesignDecisions.md#integration-tokens-are-oauth-grants)).
The grant belongs to one home and one issuing user, has scope `billing:read`
and the resource `urn:pwusage:integrations:v1`, and never expires on its own.
Its single `OAuthToken` row (kind `integration`) holds the SHA-256 digest.
Every poll goes through `authenticateGrantToken`, which checks the token, the
grant, the active user, the user's `session_version` and live access to the
home. Revoking the token, **Sign out everywhere**, or losing access to the home
invalidates it (`401`). Deleting the home deletes the token outright: a
trigger on `OAuthGrantSite` removes a `token` grant once it has no home left
(app grants, which can cover several homes, are kept). A valid token whose grant lacks `billing:read` receives
`403`. Integration tokens are rejected on `/api/mcp`, and MCP access tokens
are rejected on the integration routes.

`POST /api/oauth/grants` (`{ siteId, name }`, same-origin, body capped at
16 KB) creates a token;
`GET /api/oauth/grants?siteId=` lists the home's connections, and
`DELETE /api/oauth/grants/[id]` revokes one. Creation:

- Requires membership of the home. Admin access to the home isn't enough,
  because the token would never authenticate.
- Is bound to the `session_version` the caller's session was validated at, so
  a concurrent **Sign out everywhere** wins (`401`).
- Is refused with `409` once the user has 5 active tokens for the home.

A token that resolves to anything other than exactly one home is rejected
(`401`). The bearer check also requires the grant kind to match the token kind
(`integration` ↔ `token`, `access` ↔ `app`). `POST /api/oauth/revoke`
intentionally ignores `pwu_int_` tokens: it serves OAuth clients revoking
their own access and refresh tokens, and integration tokens are revoked under
**Site Settings → Connections**.

Send `Authorization: Bearer <token>` to `GET /api/integrations/v1/billing`.
The token selects its home. The response includes the same
`currentBill.periods`, `loadTiming` period balances and rates, and
`sources.energyDataThrough` as the app summary. Positive
`loadTiming.periods[].cycleNetExportKwh` means banked exports. Negative
values mean an import gap. The expanded forward schedule used by Smart Shift
is available through the app's bill summary.

Copy the response's `ETag` into `If-None-Match` on the next request. A `304`
has an empty body and tells the client to reuse its previous response. PWUsage
checks the latest stored sample before revalidating the ETag. If the sample is
missing or more than an hour old, it tries the existing throttled Tesla history
refresh during the request. If no newer sample arrives, the previous timestamp
still describes data freshness.

## Remote MCP Server & OAuth 2.1

AI assistants (Claude, ChatGPT, Cursor, VS Code, Antigravity) connect to the stateless Streamable HTTP MCP endpoint at `POST /api/mcp` using **OAuth 2.1 + PKCE (`S256`)** access tokens (`pwu_oat_...`). Personal `pwu_int_` integration tokens are rejected on `/api/mcp`.

- **Discovery:**
  - `GET /.well-known/oauth-protected-resource` (RFC 9728) advertises `resource` (`<origin>/api/mcp`), `authorization_servers`, and `scopes_supported` (`billing:read`, `usage:read`).
  - `GET /.well-known/oauth-authorization-server` (RFC 8414) advertises `authorization_endpoint`, `token_endpoint`, `registration_endpoint`, `revocation_endpoint`, `code_challenge_methods_supported: ["S256"]`, `token_endpoint_auth_methods_supported: ["none"]`, and `client_id_metadata_document_supported: true`.
- **Client resolution:**
  - **DCR (RFC 7591):** `POST /api/oauth/register` registers public PKCE clients (`pwu_client_...`) with strict `redirect_uris` validation, a 16 KB body cap, IP rate limiting (IPv6 keyed by /64) and a cap of 500 never-used registrations per day.
  - **Redirect URIs** are compared as exact strings (validated, never rewritten). Allowed: `https:` (not PWUsage's own origin), loopback `http:`, and hierarchical custom schemes (`cursor://…`, `com.example.app:/…`). Refused: `pwusage:` (the iOS app's own callback), network schemes (`ws:`, `ftp:`…), opaque handlers (`mailto:`, `tel:`, `sms:`) and browser/OS schemes.
  - **CIMD:** HTTPS URLs on the default port with a non-empty path (never PWUsage itself or an IP literal) are fetched on demand with SSRF guards: the host's addresses are checked against private/reserved IPv4 and IPv6 ranges and the connection is pinned to those checked addresses (no DNS rebinding), no redirects, 16 KB body cap, 3s timeout, strict `client_id` matching.
- **Consent & Tesla onboarding:**
  - `GET /oauth/authorize` validates all OAuth parameters first, prompts unauthenticated users to **Continue with Tesla** (`/login?callback=...`), and lets authenticated users choose which home(s) to share.
  - If a Tesla account has no Powerwall, `/no-sites` offers **Try a different Tesla account** (`/login?switch_account=1`, which sends `prompt=login`) and **Cancel and return to app** (`error=access_denied`).
  - The consent screen shows only what PWUsage can verify: the host publishing a CIMD app (only when the app also returns to that host), otherwise **Unverified app**, and always where the browser returns after Allow. A `client_uri` is shown only when it is exactly the publisher or redirect host. `/oauth/*` sends `frame-ancestors 'none'` and `X-Frame-Options: DENY`.
  - `POST /oauth/authorize/decision` enforces same-origin and a CSRF token bound to the exact request shown (client, redirect URI, PKCE challenge, resource, scope) before issuing a 5-minute single-use authorization code (`OAuthAuthCode`). The code records the user's `session_version` and redeems only while the user is active and that version is unchanged, so **Sign out everywhere** voids codes in flight. Sign out everywhere also disconnects every connected AI app and integration token (below).
- **Tokens, rotation & revocation:**
  - `POST /api/oauth/token` exchanges auth codes (verifying PKCE `S256`, `client_id`, `redirect_uri`, and `resource`) for a 1-hour `pwu_oat_` access token and a 30-day sliding / 90-day max `pwu_ort_` refresh token (SHA-256 hashed at rest).
  - Refresh tokens rotate on every use; presenting an already-used refresh token or replaying a consumed auth code revokes the entire `OAuthGrant` and all its tokens.
  - `POST /api/oauth/revoke` (RFC 7009) revokes the token's grant. Users can also disconnect apps under **Site Settings → Connections** (`GET /api/oauth/grants`, `DELETE /api/oauth/grants/[id]`).
- **Per-request authorization:** `POST /api/mcp` validates the `pwu_oat_` token, parent `OAuthGrant`, `resource`, active `User`, and live `SiteMember` intersection on every request. It sends CORS headers (`Access-Control-Allow-Origin: *`, no credentials: access is a bearer token) so browser MCP clients can call it and read the `WWW-Authenticate` challenge.

## Authorization Decision Summary

- Human user auth: `site_auth` JWT in cookie, verified per request against DB state (active status, `session_version`, roles, site memberships). Revocation via `POST /api/auth/sign-out-everywhere` bumps `session_version` and invalidates all outstanding JWTs.
- Human user site-level authorization: DB site memberships and roles (or `SiteService` Tesla API fallback on specific server paths that instantiate a Tesla client).
- Device/plugin auth: Trmnl JWT validation (`/api/trmnl/manage`) or installation bearer token (`/api/trmnl/markup`, `/api/trmnl/uninstall`).
- Integration auth: `pwu_int_` integration tokens, stored as `OAuthGrant` kind `token` for one home with resource `urn:pwusage:integrations:v1`. `/api/integrations/v1/billing` requires `billing:read`.
- MCP OAuth 2.1 auth: opaque `pwu_oat_` access tokens bound to `OAuthGrant` + `OAuthGrantSite` and intersected with live `SiteMember` on `POST /api/mcp` (`billing:read`, `usage:read`).
- Tesla backend API auth: tokens from `User` table, auto-refreshed server-side.

## Current Open Gaps

Proxy JWT-renewal diagnostics and Axiom delivery failures remain runtime-only.
Page/request session-rejection and Tesla refresh/verification events reach Axiom.
