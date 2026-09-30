# TODO

Cross-session work that didn't fit the current focus. Pull from this list when picking up new work.

## How to use this list

When starting fresh work in this repo, check this file. If a session begins something here, leave a short note (date + branch/PR) under the item so the next session knows it's in flight. Once landed, delete the item.

## Future iOS widgets

**Note (2026-09-24, PR #110 / `codex/ios-foundation`):** Architecture only; no widget work is in progress. Keep the `MobileLoginHandoff` table as a one-time PKCE sign-in exchange. Widgets should use the resulting `site_auth` session, not redeem handoff codes or hold Tesla credentials. See [the authorization design](docs/plans/2026-09-24-ios-widget-authorization-design.md) for rationale and edge cases.

- [ ] **Prepare shared authorization:** Add one App Group entitlement to the app and widget extension and configure their `URLSession`s with the same App Group cookie store. Decide whether existing app sessions will migrate from `HTTPCookieStorage.shared` or require a fresh sign-in. Verify cookie issuance, renewal, expiry, logout, and provisioning on a signed device build. Never put the JWT in shared `UserDefaults` or widget snapshots.
- [ ] **Tighten server authorization:** For every private widget read and battery-hold write, check a valid session, active user, and *current* site assignment or admin role. `verifySiteAccess` currently reads site/role claims from the JWT, so removal may not take effect until renewal. Treat invalid or revoked sessions as signed out and clear per-site cached widget data. Address the existing PR #110 bootstrap issue where an inactive user can receive `200 []` from `/api/sites`.
- [ ] **Ship read-only widgets first:** Battery SoC with its measurement time, monthly bill estimate, and car-charge advice based primarily on bill impact and tariff. The advice recommends whether to charge; it does not control charging. Fetch on WidgetKit refresh, use the existing mobile live/bill APIs where suitable, and add a compact server-side charge-advice contract so tariff and billing rules stay consistent with the site. Show stale readings with their original timestamps; avoid presenting an offline cache as authorized after access can no longer be checked.
- [ ] **Add the interactive hold only after write safeguards:** The `Hold battery` App Intent starts the existing automatic load-ended hold with its eight-hour backstop. Require local device authentication on tap and fresh server authorization before the Tesla command. Use server-fetched SoC/reserve; at 85–95% SoC, open the app for an explicit 80% or 100% choice. Make repeated/concurrent taps idempotent or serialized *before* the first Tesla write. Reject cross-origin browser writes without rejecting native requests that have no `Origin` header. Show the confirmed hold state and clear errors rather than optimistic success.
- [ ] **Validate the end-to-end lifecycle:** Test separate app/extension processes, locked-device tap, expired/revoked sessions, changed site access, cookie renewal, failed refresh, duplicate taps, and restore after the car load ends. Use the peer SleepDaddy iOS test-runner approach if `xcodebuild test` crashes; inspect that script before adapting it here.

Separately, fix the PR #110 mobile OAuth error paths that still return JSON into `ASWebAuthenticationSession` instead of redirecting an error to the app. That is a current sign-in issue, not a widget feature.

## DB egress: remaining reduction candidates

The July 2026 Supabase egress spike was traced to site queries duplicating wide
columns (Site.json, Tesla tokens, live_status_cache) across the tariff join
fan-out on the TRMNL markup hot path; that and the markup route's duplicate
usage-by-TOU fetch were fixed (2026-07-18, branch `claude/db-egress-spike-eie52j`).
Candidates that remain, in rough value order:

- **`getExistingTimestamps` returns every 5-min timestamp** in the audited
  range (~8.5k rows per billing cycle) on each `/api/sync` step, and
  `DataSyncer` retries up to 15× per stage, 2 stages, re-running hourly.
  Aggregating per-day stats (count, first, last, max interior gap via `lag()`)
  in SQL would cut it ~300×, but must reproduce `auditDays`' site-timezone day
  windows (DST days are pinned by `import-planner.test.ts`) — do it carefully.
- **Live-status cache churn:** `claimLiveRefresh`/`updateLiveStatusCache`
  invalidate the in-memory site cache roughly every 14–16 min per site, so the
  15-min site cache rarely survives. Consider a narrow update that doesn't
  nuke the whole cached site, or a short-TTL request-scoped reread.
- **All tariff versions fetched per markup poll** (`getTariffsForSite` /
  `getSchedulesForSite`, intentionally unfiltered for historical name
  resolution). Version count grows monotonically (append-only); if it gets
  large, resolve names via a slimmer projection or cache the version list.

## TRMNL: Loose Pending Installation Flow Note

- **Note (2026-07-01):** The loose-pending fallback flow (installation row with NULL `uuid` and NULL `plugin_setting_id`, claimed by the next webhook within 15 minutes) has been retained. Database inspection confirmed that loose installations still occur (most recent on June 23, 2026). This fallback remains necessary to handle cases where `plugin_setting_id` is missing from the callback URL during manual setups or when the TRMNL API `fetchMe` fails. Revisit and remove this flow if loose installs stop appearing after the manual-install path is fixed.


## Remove vestigial Go code (low priority)

The Go tree (`cmd/pwrtool`, `internal/`, `go.mod`/`go.sum`) and the legacy Svelte app (`cmd/web-app`) predate the Next.js app and are kept only as reference for how things used to work. Delete them when convenient — nothing depends on them.

## Remove Temporal polyfill after Node.js 26 LTS

`src/lib/billing-cycle.ts` now uses `@js-temporal/polyfill` for timezone-aware date arithmetic. Once Node.js 26 reaches LTS (~mid-2026), remove the polyfill dependency and use native `Temporal` from the runtime instead.

**Change:** Replace `import { Temporal } from '@js-temporal/polyfill'` with `import { Temporal } from 'temporal'` (or native global if available) and remove `@js-temporal/polyfill` from `package.json`.

## Upgrade ESLint to v10 (blocked upstream)

`eslint` is pinned at `^9` because `eslint-config-next` bundles `eslint-plugin-react@7.37.5` (latest), whose eslint peer range caps at `^9.7`. ESLint 10 removed `context.getFilename()`, which that plugin still calls, so `npm run lint` crashes under v10. This is not a config-format issue — the repo already uses flat config (`eslint.config.mjs`).

**Change:** Once `eslint-plugin-react` (and `eslint-config-next`) declare eslint 10 support, bump `eslint` to `^10` and re-run `npm run lint`.


## Tesla OAuth: consolidate the three credential paths (2026-09-30, PR #118)

`/login` and `/refresh` call `requireEnv`, which **throws** on a missing variable.
/`auth/tesla-callback` deliberately intercepts instead, and its own comment says the
interception exists "to turn that loud throw into the clean response below instead of a
raw 500". The two-of-three split is user-visible on iOS: a mobile client hitting `/login`
with the client id unset gets an opaque 500 sheet instead of `AuthError.serverRejectedLogin`.

Fix: have `/login` intercept the same way. That requires exporting the callback route's
module-private `mobileCallbackResponse`. In the same change:

1. Relocate `requireEnv` out of `src/lib/tesla-token-endpoint.ts` into something like
   `src/lib/env.ts`. A token-endpoint module exporting a generic env accessor is the wrong
   home now that a *login route* depends on it.
2. Move `buildTeslaAuthorizeUrl` to `src/lib/tesla-authorize-url.ts`, where the rest of the
   Tesla wire-format logic already lives.

**Change:** export `mobileCallbackResponse`, intercept in `/login` before the cookie
writes, relocate `requireEnv`, move the URL builder.

## Tesla OAuth: consider `require_requested_scopes` (2026-09-30, PR #118)

`prompt_missing_scopes=true` (set in PR #118) prompts for scopes the user has not granted
but **cannot** silently grant them. The sibling `require_requested_scopes` ("user must
authorize all requested scopes to proceed") is not set.

Latent today because the scope set is static. **If a scope is ever added**, a user who
*declines* still completes login with a partial grant, and the app fails later at
point-of-use instead of at login. Decide the policy before the first scope addition.

**Change:** set `require_requested_scopes` alongside `prompt_missing_scopes`, or document
why a partial grant is acceptable.

## Tesla OAuth: unexpected 3xx from the token endpoint (2026-09-30, PR #118)

`src/lib/tesla-token-endpoint.ts` handles 4xx and 5xx explicitly, and an unexpected
1xx/2xx/3xx throws `TeslaTokenEndpointError`. That is correct — a 307/308 would re-POST
`client_secret` to whatever origin the redirect named, which is why `redirect: 'manual'`
is set — but nothing **logs** it, so a Tesla-side redirect would look like an unexplained
authentication failure.

**Change:** log the status and host on the unexpected-status throw path.

## Tesla OAuth: restore leaked OAuth test env vars at the source (2026-09-30, PR #118)

Several suites `vi.stubEnv` the `PUBLIC_TESLA_OAUTH_*` and `TESLA_OAUTH_SECRET` variables
and never unstub them. Harmless in a fixed file order, but Vitest may run files in any
order, so a neighbouring suite can inherit them. Reproduce with
`npx vitest run --sequence.shuffle`.

`route.test.ts` was fixed at the file level with `afterEach(vi.unstubAllEnvs)`; the rest
of the suites were not.

**Change:** either set `unstubEnvs: true` in `vitest.config.ts`, or add a file-scope
`afterEach(() => vi.unstubAllEnvs())` to each suite that stubs these vars.

## Tesla OAuth: issuer-keyed JWKS client, and re-resolve after the discovery TTL (2026-09-30, PR #118)

Raised by review on PR #118. Both are pre-existing and unchanged by that branch, verified
against base commit `092b727`.

**1. One module-level client, keyed only by the previous issuer.**
`getOrCreateJwksClient` (`src/lib/tesla-auth-service.ts`) assigns `teslaJwksClient` *after*
`await getTeslaJwksUri(issuer)`. Two concurrent cold-start verifications carrying different
`iss` values both enter the branch, and the loser verifies against the wrong issuer's key
set — takes a genuine `SigningKeyNotFoundError`, lands in the degraded path. Latent (Tesla
issues only `/nts`) and pre-existing. The same code also thrashes the key cache on issuer
alternation. This is the one path into the signature bypass that is *not* a key-set miss.

**2. The 1-hour discovery TTL is never applied in the single-issuer flow.**
Once a client exists for the issuer Tesla actually uses, `issuer !== lastIssuer` is false
forever, so `getTeslaJwksUri` is never called again. Base behaved identically: its removed
`fetchFreshJwks(jwksUri)` took the *already-resolved* URI as a parameter and did not
re-resolve. So if Tesla ever changes an issuer's `jwks_uri`, verification keeps querying
the old endpoint for the life of the instance. Rarely observable on serverless, where
instances are short-lived.

**Change:** key clients by issuer in a `Map<string, client>`, and rebuild the client when
the discovery entry has passed `DISCOVERY_CACHE_TTL_MS` so `getTeslaJwksUri` is called
again. Fixes both.

## Tesla OAuth: distinguish Tesla outages from invalid login (2026-09-30, PR #118)

When both token-endpoint hosts fail on transport error or 5xx, the callback reports
`invalid-id-token`. That conflates "Tesla is down or slow" with "this token is bad", so an
operator debugging an outage reads an auth-config error. `DesignDecisions.md` §5 records
the related terminal-vs-transient split: `isTeslaAuthError` classifies by **substring**, so
an upstream body interpolated into a non-terminal message (`tesla-auth.ts`) can trigger a
user revocation. That path is now reachable for the first time, since PR #118 made the
refresh request actually succeed.

**Change:** give transport/5xx failures their own status, and classify from the parsed
error code rather than a substring of the message.

## Tesla: bound the unbounded network calls in the Tesla callback path (2026-09-30, PR #118)

`src/lib/tesla-client.ts` — `getUserInfo` and `getProducts` — and `importer.ensureSite`
have **no timeouts whatsoever**. Verified: zero occurrences of `AbortSignal` in either
file. An earlier version of this item also claimed the token exchange was a bare `fetch`
with no `AbortSignal`; that is stale, PR #118 routed it through `postToTeslaTokenEndpoint`,
which sets `AbortSignal.timeout(8000)`.

**Arithmetic.** The bounded legs stack to **≈18 s** for a login that *completes*: at most
one timed-out host attempt (8 s) before the exchange succeeds, then 5 s of OIDC discovery
and 5 s of JWKS fetch, and those two do stack (8 + 5 + 5). The exchange's own worst case is
2 × 8 s = **16 s**, but that case never reaches verification — exhausting both hosts
returns `token-exchange-failed` before `verifyTeslaIdToken` is called, so it cannot be
added to the other legs. The route's `maxDuration` is 60 s, so there is headroom; the
`tesla-client` calls are what can hang indefinitely.

**Caveat on "worst case":** only the exchange and discovery figures are hard deadlines
(`AbortSignal.timeout` fires on elapsed time). jwks-rsa's `timeout` is a
**socket-inactivity** bound, so a trickling JWKS response can exceed 5 s in total. 5 s is
not a deadline on that leg, and neither is any number that includes it.

**Change:** add request timeouts to `tesla-client.ts`. Prefer bounded per-request
`AbortSignal.timeout` over a whole-request race, which is what PR #118 removed from the
verification path.
