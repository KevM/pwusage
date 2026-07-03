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
- Generates OAuth `state` and `nonce`.
- Stores `auth_state`, `auth_nonce`, optional `auth_callback` cookies.
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
After enabling a new scope, users must re-authenticate via `/login` (the authorize URL
uses `prompt=login`) so a fresh token carries it — existing tokens are not upgraded.

### 2. OAuth callback processing
Route: `GET /auth/tesla-callback`
- Validates `code` and `state`.
- Verifies `state` against cookie.
- Exchanges authorization code for Tesla tokens.
- Decodes `id_token` and validates `nonce`.

User and site provisioning:
- Builds stable user id from ID token `sub` (fallback email).
- Upserts `User` row with Tesla tokens.
- Calls Tesla `getProducts()` and ensures each energy site exists.
- Links each site to the user (`Site.user_id`).
- Persists latest Tesla tokens on user.

Session issuance:
- Signs `site_auth` JWT with `sites`, `roles`, `sub`.
- Sets `site_auth` cookie.
- Clears one-time auth cookies.
- Redirects to saved callback (or `/`).

Important implementation note:
- `auth-checks.ts` now uses `site_auth` claims only for `verifySiteAccess`/`getAuthorizedSiteIds`; legacy `access_token` cookie fallback was removed.

### Email uniqueness

`User.email` is unique case-insensitively (partial index `idx_user_email_lower`
on `LOWER(email) WHERE email IS NOT NULL`; rows with NULL email are exempt).
Both OAuth paths (verified and degraded) reconcile logins to an existing
account by email before upserting, and the upsert retries once on a unique
violation to handle concurrent first logins. This prevents the account
splitting that previously occurred when the degraded path keyed a User row by
email and a later verified login keyed a second row by Tesla `sub`.


### 3. Runtime authorization checks

Common checks:
- `verifySiteAccess(siteId)` in `auth-checks.ts`: allows if `site_auth` has site or `admin`.
- `SiteService.validateSiteAccess(siteId)`: same JWT check, then Tesla API fallback if client exists.

Protected surfaces include:
- Site pages (`/site/[id]`)
- Server actions for settings updates
- API routes like `/api/hourly-data`, `/api/site-live-data`, `/api/site/[id]/analysis`

### 4. Session refresh behavior

Middleware/proxy (`src/proxy.ts`):
- On each request with `site_auth`, checks token expiry window.
- If near expiry, re-signs and resets `site_auth` cookie (sliding session).

Tesla token refresh behavior:
- `TeslaClient` retries once on Fleet API 401 when refresh token exists.
- `EnergyRepo.getLockedRefreshHandler(siteId)` serializes refresh with DB lock fields on `User`.
- Refreshed Tesla tokens are written back to `User`.
- Terminal auth failures can mark user `auth_status='revoked'`.

### 5. Logout
Route: `GET|POST /logout`
- Deletes `site_auth` cookie and redirects to `/`.

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

## Authorization Decision Summary

- Human user auth: `site_auth` JWT in cookie.
- Human user site-level authorization: `site_auth.sites` and `roles` (or `SiteService` Tesla API fallback on specific server paths that instantiate a Tesla client).
- Device/plugin auth: Trmnl JWT validation (`/api/trmnl/manage`) or installation bearer token (`/api/trmnl/markup`, `/api/trmnl/uninstall`).
- Tesla backend API auth: tokens from `User` table, auto-refreshed server-side.

## Current Open Gaps

No known auth gaps as of February 16, 2026.