# Integration Tokens as OAuth Grants Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store, check and revoke the billing integration tokens from PR #456 as a kind of OAuth grant, so PWUsage has one connection store, one bearer-token check and one place to revoke access, while scripts keep a simple static `pwu_int_` token.

**Architecture:** `OAuthGrant` gains a `kind` column (`app` for OAuth 2.1 apps, `token` for integration tokens). An integration token is a `token` grant with one site, a fixed non-URL resource, scope `billing:read`, no expiry (`'infinity'`) and one `OAuthToken` row of kind `integration`. One function in `oauth-repo.ts` authenticates both MCP access tokens and integration tokens, each against its own resource and token kind. Site Settings shows one **Connections** card listing apps and tokens. Existing tokens keep working because the migration copies their SHA-256 hashes unchanged.

**Tech Stack:** Next.js App Router, TypeScript, `pg`, PostgreSQL (Supabase), Vitest.

**Spec:** This document. The decisions came out of the 2026-11-25 discussion after PR #458 merged:
- Keep a static token for scripts (ecobee-aux, #457). The OAuth flow's 90-day grant cap, refresh rotation and MCP-only audience don't suit unattended cron jobs.
- Unify the storage, verification and revocation underneath.
- "Sign out everywhere" revokes integration tokens too (user decision).
- One Connections card replaces both Billing Integrations and Connected AI Apps (user decision).

## Global Constraints

- The token format stays `pwu_int_` + 43 base64url characters (32 random bytes), stored only as `sha256(token)` in `OAuthToken.token_hash`.
- The integration resource is the constant `urn:pwusage:integrations:v1`, exported as `INTEGRATION_RESOURCE` from `src/lib/oauth/types.ts`. It never equals the MCP resource, so neither token kind is accepted on the other surface.
- The integration grant `client_id` is the constant `pwu_integration` (`INTEGRATION_CLIENT_ID`). It has no `OAuthClient` row.
- Integration tokens never expire on their own: `max_expires_at` and `expires_at` are `'infinity'`. Every SQL filter `> now()` already accepts that. Any `max_expires_at` read into TypeScript must go through `CASE WHEN isfinite(...)`, because node-pg parses `infinity` as a non-Date.
- Integration tokens are created with scope `['billing:read']` only. No scope picker.
- The billing route response, ETag and 304 behavior are unchanged.
- The migration is additive and idempotent: Prod runs it before the Vercel deploy, and CI runs it twice on Dev. `IntegrationCredential` and `IntegrationGrant` stay in place this PR, and a `TODO.md` entry covers dropping them.
- The copy follows `docs/voice-and-terms.md`. Keep the word "token" (the current UI's term) and use sentence case for new labels.
- Web lint, `tsc --noEmit`, Vitest, `npm run build`, and the Postgres test in Task 1 must pass.

## Review Focus

1. **A token created before the deploy still works after it** (hash copied, user's current `session_version` stamped). Pinned by the Task 1 Postgres test.
2. **An integration token sent to `/api/mcp`, or an MCP access token sent to the billing route, gets 401.** Pinned in Task 2.
3. **"Sign out everywhere" kills integration tokens at once**, both through `revoked_at` and through the `session_version` mismatch. Pinned in Task 1's Postgres test (via `UserRepo.signOutEverywhere`).
4. **A token whose user lost access to its home** (SiteMember removed) gets 401, not 403, and doesn't leak the site. Already covered by the `OAuthGrantSite` join, and pinned in Task 2.
5. **The Connections card handles a no-expiry row** (`maxExpiresAt: null`) without printing "Invalid Date" or crashing. Pinned in Task 4.

---

### Task 1: Migration — integration tokens become grants

**Files:**
- Create: `cmd/next-app/db-migrations/20261125183518_integration_tokens_as_grants.sql`
- Create: `cmd/next-app/src/lib/oauth/integration-grants-postgres.test.ts`

**Interfaces:**
- Produces: `OAuthGrant.kind text NOT NULL DEFAULT 'app' CHECK (kind IN ('app','token'))`, and `OAuthToken.kind` that also allows `'integration'`.

- [ ] **Step 1: Write the failing Postgres test.** Follow `src/app/api/mobile/session/session-revocation-postgres.test.ts`: `describe.skipIf(!process.env.COMPACT_HISTORY_TEST_SOCKET)`, create the Supabase roles, and create minimal `"User"` (with `session_version`, `is_active`), `"Site"` and `"SiteMember"` tables. Apply `20261124073716_integration_credentials.sql` and `20261125111815_oauth_mcp.sql`, insert one `IntegrationCredential` (+ `IntegrationGrant` `billing:read`) for `user-1`/`site-1` whose `token_hash = sha256('pwu_int_' + 'a'.repeat(43))`, then apply the new migration **twice**. Tests:
  - `copies each credential into a token grant` — one `OAuthGrant` row with `id` = credential id, `kind = 'token'`, `client_id = 'pwu_integration'`, `client_name` = credential name, `resource = 'urn:pwusage:integrations:v1'`, `scopes = {billing:read}`, `isfinite(max_expires_at) = false`, `session_version` = the user's. One `OAuthGrantSite` (`site-1`) and one `OAuthToken` (`kind = 'integration'`, same hash, `isfinite(expires_at) = false`).
  - `is idempotent` — counts are unchanged after the second run.
  - `authenticates a copied token` — with `@/lib/db` mocked to the local client as in the reference test, `authenticateGrantToken('Bearer pwu_int_aaa…', { kind: 'integration', resource: INTEGRATION_RESOURCE })` returns `authorizedSiteIds: ['site-1']`, `scopes: ['billing:read']`. Write this assertion now and let it fail until Task 2.
  - `sign out everywhere revokes the token` — after `new UserRepo().signOutEverywhere('user-1')`, the same call returns `null`.
- [ ] **Step 2: Run it and confirm it fails.** `npm run test:compact -- src/lib/oauth/integration-grants-postgres.test.ts` → FAIL (migration file missing).
- [ ] **Step 3: Write the migration.**
  - `ALTER TABLE "OAuthGrant" ADD COLUMN IF NOT EXISTS kind …`.
  - Replace `"OAuthToken_kind_check"` in a `DO` block (`DROP CONSTRAINT IF EXISTS`, then `ADD CONSTRAINT … CHECK (kind IN ('access','refresh','integration'))`).
  - Copy with `INSERT … SELECT … ON CONFLICT DO NOTHING` into `OAuthGrant` (scopes = `array_agg(g.scope ORDER BY g.scope)` grouped by credential, `created_at` kept, `session_version` from `"User"`), into `OAuthGrantSite`, and into `OAuthToken` (`created_at` kept).
  - Leave the old tables alone.
- [ ] **Step 4: Run it and confirm the migration tests pass.** The first three migration assertions pass. The two auth assertions wait for Task 2.
- [ ] **Step 5: Commit** — `feat(oauth): copy integration tokens into OAuth grants`

### Task 2: One bearer-token check for MCP and the billing route

**Files:**
- Modify: `cmd/next-app/src/lib/oauth/types.ts` (add `INTEGRATION_TOKEN_PREFIX = 'pwu_int_'`, `INTEGRATION_RESOURCE`, `INTEGRATION_CLIENT_ID`, `type GrantKind = 'app' | 'token'`)
- Modify: `cmd/next-app/src/lib/oauth/oauth-repo.ts:469-535` (replace `authenticateOAuthAccessToken`)
- Modify: `cmd/next-app/src/app/api/mcp/route.ts`, plus any other caller of `authenticateOAuthAccessToken` (`git grep` it)
- Modify: `cmd/next-app/src/app/api/integrations/v1/billing/route.ts`
- Test: `cmd/next-app/src/lib/oauth/oauth-repo.test.ts`, `cmd/next-app/src/app/api/integrations/v1/billing/route.test.ts`

**Interfaces:**
- Produces: `authenticateGrantToken(authorization: string | null, expected: { kind: 'access' | 'integration'; resource: string }): Promise<OAuthAccessContext | null>`. Prefixes: `access` → `pwu_oat_`, `integration` → `pwu_int_`. The SQL adds `AND t.kind = $3` to the current query. Everything else (revoked, expiry, resource, `is_active`, `session_version`, site join, `last_used_at` throttle) stays as it is.

- [ ] **Step 1: Write the failing unit tests** in `oauth-repo.test.ts`:
  - `rejects a pwu_int_ token when kind is access` and `rejects a pwu_oat_ token when kind is integration` — both `null`, with no query run.
  - `passes kind and resource to the token query` — `mockQuery.mock.calls[0][1]` equals `[sha256(token), INTEGRATION_RESOURCE, 'integration']`.
- [ ] **Step 2: Update the billing route tests** (`route.test.ts`). Mock the token lookup rows in the `OAuthGrant`/`OAuthToken` shape in place of `IntegrationCredential`. Keep every existing response and ETag assertion. Add:
  - `returns 401 for an MCP access token`
  - `returns 403 when the grant lacks billing:read` (scopes `['usage:read']`)
  - `returns 401 when the token's home is no longer authorized` (site query returns no rows)
  - `logs grantId, not integrationId` (`mocks.setLogContext` called with `{ siteId: 'home', grantId: id }`)
  
  Delete the `billing-integrations` settings-route cases from this file; Task 3 replaces that route.
- [ ] **Step 3: Run them and confirm they fail.** `npx vitest --run src/lib/oauth/oauth-repo.test.ts src/app/api/integrations/v1/billing/route.test.ts`
- [ ] **Step 4: Implement.**
  - Rename and generalize the function, and update the MCP caller to `{ kind: 'access', resource: expectedMcpResource(origin) }`.
  - The billing route calls `{ kind: 'integration', resource: INTEGRATION_RESOURCE }`. `null` → 401 (unchanged headers). Missing `billing:read` → 403. The site is `authorizedSiteIds[0]`. Logging uses `setLogContext({ siteId, grantId })`.
  - In `src/lib/observability.ts:140-145`, rename the `setLogContext` field `integrationId` to `grantId`. Update `docs/operations/observability.md` if it names the field.
- [ ] **Step 5: Run these tests, the MCP route tests, and the Task 1 Postgres test.** All pass.
- [ ] **Step 6: Commit** — `refactor(oauth): authenticate integration tokens as grants`

### Task 3: Create, list and revoke tokens through the grants API

**Files:**
- Modify: `cmd/next-app/src/lib/oauth/oauth-repo.ts` (add `createIntegrationToken`; extend `UserOAuthGrantSummary` and `listUserOAuthGrantsForSite`)
- Modify: `cmd/next-app/src/app/api/oauth/grants/route.ts` (add `POST`)
- Delete: `cmd/next-app/src/app/api/site/[id]/billing-integrations/route.ts`, `cmd/next-app/src/lib/integration-credential-repo.ts`
- Modify: `cmd/next-app/src/lib/user-repo.ts:186-197` (doc comment only: tokens are grants, so the existing SQL already revokes them)
- Test: `cmd/next-app/src/lib/oauth/oauth-repo.test.ts`, `cmd/next-app/src/app/api/oauth/grants/route.test.ts`

**Interfaces:**
- Produces: `createIntegrationToken(userId: string, siteId: string, name: string): Promise<{ grant: UserOAuthGrantSummary; token: string }>`. It runs one transaction: read `session_version` from `"User"`, insert the `OAuthGrant` (`kind 'token'`), the `OAuthGrantSite`, and the `OAuthToken` (`kind 'integration'`).
- Produces: `UserOAuthGrantSummary` gains `kind: GrantKind`, and `maxExpiresAt` becomes `string | null` (null = never expires). `publisherHost` is null for tokens.
- Produces: `POST /api/oauth/grants`, body `{ siteId, name }` → 201 `{ grant, token }`. It requires `isSameOriginPost`, a signed-in user and `verifySiteAccess(siteId)`. The name is trimmed, 1–80 characters, with no `\0`; otherwise 400 `Enter a name up to 80 characters.`
- Revocation reuses `DELETE /api/oauth/grants/[id]` unchanged.

- [ ] **Step 1: Write the failing tests.**
  - Repo: `createIntegrationToken returns a pwu_int_ token and stores only its hash` (the third client insert's params contain `sha256(token)` and not `token`).
  - Repo: `lists a token grant with kind token and null maxExpiresAt` (mock row `kind: 'token', max_expires_at: null`).
  - Route: `POST rejects cross-origin`, `POST 403 for another home`, `POST 400 for an 81-character name`, `POST 201 returns the token once`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.** In the listing SQL, select `g.kind` and `CASE WHEN isfinite(g.max_expires_at) THEN g.max_expires_at END AS max_expires_at`. Then delete the old route and repo, and `git grep -n "integration-credential-repo\|billing-integrations"` until only docs and the migration mention them.
- [ ] **Step 4: Run** `npx vitest --run src/lib/oauth src/app/api/oauth src/app/api/integrations src/lib/user-repo.test.ts` and `npx tsc --noEmit`. All pass.
- [ ] **Step 5: Commit** — `feat(oauth): create integration tokens as grants`

### Task 4: One Connections card in Site Settings

**Files:**
- Create: `cmd/next-app/src/components/site/Connections.tsx` (from `ConnectedAiApps.tsx` plus the token form and the show-once token panel and examples from `BillingIntegrations.tsx`)
- Delete: `cmd/next-app/src/components/site/ConnectedAiApps.tsx`, `cmd/next-app/src/components/site/BillingIntegrations.tsx`
- Modify: `cmd/next-app/src/components/site/SettingsView.tsx:12-13,351-352` (render `<Connections key={site.id} siteId={site.id} />` once)
- Modify: `cmd/next-app/src/components/site/SignOutEverywhere.tsx:9,37,51` (copy: "…disconnects every connected app and integration token.")
- Test: `cmd/next-app/src/components/site/Connections.test.tsx`; update `SettingsView.test.tsx` and `SignOutEverywhere.test.tsx` if they assert the old titles or copy.

**Interfaces:**
- Consumes: `GET /api/oauth/grants?siteId=`, `POST /api/oauth/grants`, `DELETE /api/oauth/grants/[id]` (Task 3).

Card copy:
- Title "Connections". Description "AI apps and integration tokens that can read this home’s data."
- Rows: an app shows its name, publisher line ("App details from …" / "Unverified app"), last used and "Disconnect". A token shows its name, "Integration token · Billing", last used and "Revoke".
- The "Create token" form, the show-once panel and the curl/Node examples keep `BillingIntegrations.tsx`'s copy verbatim.
- Errors: "Couldn’t load connections.", "Couldn’t create the integration token.", "Couldn’t revoke this connection."

- [ ] **Step 1: Write the failing component tests** (React Testing Library, `fetch` mocked):
  - `lists apps and tokens from one request` (one app grant and one token grant render with "Disconnect" and "Revoke")
  - `renders a token with null maxExpiresAt without "Invalid Date"`
  - `shows a created token once and adds it to the list`
  - `revoking removes the row`
- [ ] **Step 2: Run them and confirm they fail.** `npx vitest --run src/components/site/Connections.test.tsx`
- [ ] **Step 3: Implement the component, swap it into `SettingsView`, update the sign-out copy, and delete the two old components.**
- [ ] **Step 4: Run** `npx vitest --run src/components/site` and `npm run lint`. Both pass.
- [ ] **Step 5: Verify in the browser.** Run the dev server against the local or Dev database. Create a token, call `GET /api/integrations/v1/billing` with it (expect 200, then 304 with the ETag), revoke it (expect 401), and check the card at phone width in light and dark mode.
- [ ] **Step 6: Commit** — `feat(web): combine AI apps and integration tokens into Connections`

### Task 5: Docs and follow-up

**Files:**
- Modify: `Authentication.md` (integration tokens section: stored as `token` grants, one verifier, revoked by "Sign out everywhere")
- Modify: `DesignDecisions.md` (new section "Integration tokens are OAuth grants": why scripts keep static tokens — 90-day cap, rotation, MCP audience — and why storage is shared)
- Modify: `cmd/next-app/README.md` (routes and components list)
- Modify: `docs/dev-database-copy.md` (the `OAuthGrant`/`OAuthToken` rows now include integration tokens; `IntegrationCredential` stays until the drop)
- Modify: `cmd/ecobee-aux/README.md:16` ("Create a token in **Site Settings → Connections**")
- Modify: `TODO.md` (new entry: drop `IntegrationCredential`/`IntegrationGrant` and their `sanitize-dev-copy.sql` lines and the dev-copy doc row once this has been on Prod for one release)

- [ ] **Step 1: Make the edits above.**
- [ ] **Step 2: Run the full web check.** `npm run lint && npx tsc --noEmit && npx vitest --run && npm run build`, plus `npm run test:compact -- src/lib/oauth/integration-grants-postgres.test.ts`. Everything passes.
- [ ] **Step 3: Commit** — `docs: document integration tokens as OAuth grants`
