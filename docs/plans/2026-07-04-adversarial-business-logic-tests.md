# Plan: Adversarial Business Logic & Highest-Value Route Test Coverage

## Goal
Establish comprehensive unit test coverage across 7 high-risk business logic and boundary areas: TRMNL routes (webhook, manage, setup, uninstall), boundary auth helpers (`auth-checks.ts`), login and OAuth callback handlers, background sync and batch import endpoints, and admin management APIs (announcements and upload).

## Implementation Details

### 1. Strict TRMNL Plugin Setting ID Coercion
- Export strict `coercePositiveInt(value: unknown): number | null` helper in `src/lib/trmnl-component-config.ts` enforcing `/^\d+$/` digit regex check (rejecting partially numeric strings such as `"42abc"`, floats, zero, negatives, and invalid types).
- Use `coercePositiveInt` across `src/app/api/trmnl/setup/route.ts`, `src/app/api/trmnl/webhook/route.ts`, `src/app/api/trmnl/manage/route.ts`, and `src/components/site/SettingsView.tsx`.
- Add dedicated test coverage in `src/lib/trmnl-component-config.test.ts`.

### 2. TRMNL Webhook Route & Auth Claim Flow (`src/app/api/trmnl/webhook/route.test.ts`)
- Cover unsigned webhooks (401), JWT with wrong sub (401), opaque token DB lookup, plugin setting ID mismatch (403), claiming pending installs, 15-minute loose pending claim window enforcement, preserving component screen configs, and conditional user email syncing.

### 3. TRMNL Manage Authorization Matrix (`src/app/api/trmnl/manage/route.test.ts`)
- Update `src/app/api/trmnl/manage/route.ts` to validate `component_screens` length when provided.
- Cover GET with TRMNL token vs site cookie, unlinked device rejection, POST linking via token vs site-auth fallback, re-linking target site authorization checks, and invalid component screen bounds.

### 4. TRMNL Setup & Uninstall Routes (`src/app/api/trmnl/setup/route.test.ts`, `src/app/api/trmnl/uninstall/route.test.ts`)
- Guard `parseInt(body.plugin_setting_id)` against `NaN`.
- Cover missing credentials (500), unauthorized site (403), 404 site, UUID extraction precedence order, `pending_webhook` / `pending_loose` fallbacks, idempotent uninstall (200), Bearer auth, and token verification failure (401).

### 5. Auth Boundary Helpers & Proxy Middleware (`src/lib/auth-checks.test.ts`, `src/proxy.test.ts`)
- Cover revoked/inactive user blocking (`getCurrentUser`, `verifySiteAccess`, `getAuthorizedSiteIds`), admin role behavior, malformed token handling, and proxy sliding window cookie refresh with attributes (`httpOnly`, `sameSite=lax`, `secure` in prod).

### 6. Login & Tesla OAuth Callback Handlers (`src/app/login/route.test.ts`, `src/app/auth/tesla-callback/route.test.ts`)
- Cover safe relative callback parameter validation, rejection of open-redirect attempts (`//evil`, `/\evil`, `https://`), cleanup of auth cookies on callback, mapping error statuses (`state-mismatch`, `nonce-mismatch`, `token-exchange-failed`, `invalid-id-token`), and site_auth cookie suppression when no sites exist.

### 7. Data Sync & Import Endpoints (`src/app/api/sync/route.test.ts`, `src/app/api/import/route.test.ts`)
- Validate `startDate` and `endDate` parameters to reject `Invalid Date` strings with HTTP 400.
- Cover missing/invalid parameters, 403 unauthorized sites, 401 unauthenticated client, SSE stream events (`checking`, `progress`, `complete`, `partial`, `error`), partial import success reporting, and 502 Bad Gateway when all sites fail.

### 8. Admin Announcement & Upload Routes (`src/app/api/announcements/route.test.ts`, `src/app/api/upload/route.test.ts`)
- Sanitize `filename` parameter in `/api/upload` to reject path traversal filenames (`../`).
- Cover non-admin access rejection (401), title/content validation, swallowed Discord integration errors, 404 for missing update IDs, 400 for missing delete IDs, and path traversal rejection.

## Verification
- Run `npm run test` (79 test files passed, 632 tests passed).
- Run `npm run lint` (0 errors, 0 warnings).
- Run `npm run build` (Next.js build succeeded).
