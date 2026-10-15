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
Per-poll cost on this path is amplified: `DataSyncer` retries up to 15× per stage,
2 stages, re-running hourly.
Candidates that remain, in rough value order:

- **Live-status cache churn:** `claimLiveRefresh`/`updateLiveStatusCache`
  invalidate the in-memory site cache roughly every 14–16 min per site, so the
  15-min site cache rarely survives. Consider a narrow update that doesn't
  nuke the whole cached site, or a short-TTL request-scoped reread.
  **Correction (2026-10-01):** this does *not* affect the TRMNL markup path —
  `getSitesWithTariffs` bypasses the cache entirely when `includeTokens` is set
  (`site-repo.ts:43-47`), and the markup route always sets it. The value is in
  the web/dashboard/iOS paths. Cheapest of these items (~5 lines), but not a
  hot-path win. A third invalidator exists that this item omits:
  `releaseLiveRefreshClaim` (`site-repo.ts:364-371`).
- **All tariff versions fetched per markup poll** (`getTariffsForSite` /
  `getSchedulesForSite`, intentionally unfiltered for historical name
  resolution). Version count grows monotonically (append-only); if it gets
  large, resolve names via a slimmer projection or cache the version list.
  **Sized 2026-10-01:** 1–2 tariff rows and 6–48 schedule rows per site, and
  `addTariffVersion` only inserts when `tariffContentHash` differs, so a stable
  tariff never grows the table. Lowest value of the candidates; skip unless a
  site's version count actually climbs.
- **`getCycleAggregates` is the top compute cost, not egress** — re-added
  2026-10-01; it was in the 2026-07-19 postmortem but never made it onto this
  list. `energy-repo.ts:422` still re-aggregates the whole cycle per 15-min poll.
  Live `pg_stat_statements` on production: **327 calls, 849 ms mean, 278 s
  total** — the heaviest non-`net.http_get` statement measured. The postmortem
  claimed the `(site_id, timestamp)` index "already exists, so the only lever is
  a pre-aggregated daily rollup". **That claim is wrong.** `EXPLAIN (ANALYZE,
  BUFFERS)` shows the planner *ignoring* `idx_energy_site_ts` in favour of the
  single-column `idx_energy_timestamp`, discarding ~120k rows per call on the
  `site_id` filter (~61k buffers, ~120–180 ms) to return ~43 rows. Same
  predicate via `count(*)` uses the composite index for 464 buffers / 10 ms, so
  the composite path is both available and far cheaper.
  **Change:** establish why the planner rejects `idx_energy_site_ts` (planner
  GUCs, `site_id` selectivity/correlation, or an index-only-scan opportunity via
  a covering index) *before* building a rollup table. Only escalate to
  `EnergyDailyAggregate` if the plan cannot be fixed.
- **`getRawEnergyData` is the top egress line** — re-added 2026-10-01, same
  origin. `energy-repo.ts:454` still ships every 5-min row in the window. The
  original postmortem framing ("sum in SQL") is wrong: the markup route uses
  today's raw rows for three things, and **per-TOU bill pricing walks each row
  through `schedule.getTariffPeriod(ts)`**, so a scalar `SUM` cannot replace it.
  The realistic reduction is a `GROUP BY tariff_schedule_id` partial aggregate —
  the same shape `getCycleAggregates` returns — which could serve both the bill
  split and `sumTodayRows`, and is only safe when `showEnergyChart` is false.
  **Sized 2026-10-01:** `showEnergyChart` defaults to **true**, so the gate only
  fires for users who explicitly disabled the chart. Check how many TRMNL
  installs have it off before sizing this.
- **No egress signal exists (re-added 2026-10-01).** The postmortem called this
  its highest-leverage prevention action and nothing was done. There is no
  `EXPLAIN` harness in the repo, and both sanctioned harnesses are dead:
  `scripts/measure-mobile-egress.ts` requires `DEV_DATABASE_URL` *and*
  `EGRESS_SITE_ID` (neither is set) and refuses production, and
  `scripts/mobile-route-egress-trace.test.ts` shares that guard and only traces
  `site-live-data` and `mobile/bill-summary` — **not** the TRMNL markup route,
  which is the hot path. This is how a 10× regression ran for a month before
  Supabase's free-tier notice surfaced it. A weekly `pg_stat_statements` check
  ordered by rows, and/or a Supabase egress alert at ~50% of tier, would catch
  the next one in days.

## Live Activity delivery (battery hold Task 5)

Deferred from the Task 4 registration and pending-delivery work (branch `claude/live-activity-registration-e9b5ca`). Delete items as they land.

- [ ] **Smaller deferred items:** token rotation leaves a `current` row current (confirm against ActivityKit docs); ended rows keep their token until expiry (null it on terminal acknowledgement, which needs the CHECK relaxed for `ended`); no `Origin` check on DELETE and no body size cap; optional `register` assertion in the in-window terminal route test; the slow-reconcile test (5 s) is shorter than the 10 s restore deadline (the ordering test already pins placement); no test for the cross-user same-registration-id case; a theoretical deadlock between the no-id and per-hold syncs is bounded by `lock_timeout` and caught. Task 5 or 6 should also map `status = 'active'` plus `restore_reason` to "restoring" on purpose, or ignore it; the snapshot includes it.
- [ ] **Design note before the plan finishes:** add a `DesignDecisions.md` section for the activity bookkeeping invariants: SQL-side monotonic guards in `syncDesired`, bookkeeping only after lease release and outside restore deadlines, the periodic no-id reconcile as the recovery path, production APNs only when `VERCEL_ENV === 'production'`, and the dev copy deleting all activity rows.

**Task 5 contract notes:**

- The delivery claim selects only `delivery_state = 'pending' AND desired_version > delivered_version AND desired_snapshot IS NOT NULL AND push_token IS NOT NULL AND expires_at > now()`, gates `apns_environment` against `allowedApnsEnvironments()` again, re-checks current access (`User.is_active`, roles, `Site.user_id` through the hold), and captures `(desired_version, desired_snapshot)` atomically so it sends exactly that pair.
- Replace `acknowledgeDelivery` with an owner-conditioned, advance-only version that touches backoff and claim columns only when the delivered version advances (a stale or duplicate ack must not reset backoff or leave the claim held).
- Decide whether a new terminal version bypasses backoff: `syncDesired` leaves `next_attempt_at` untouched.
- Never store the token or raw APNs response bodies in `last_error`; log with `activityErrorTag`.
- Call `reconcileBatteryHoldActivities()` before claiming, and keep the worker's budget separate from the 60 s monitor.

## TRMNL: Loose Pending Installation Flow Note

- **Note (2026-07-01):** The loose-pending fallback flow (installation row with NULL `uuid` and NULL `plugin_setting_id`, claimed by the next webhook within 15 minutes) has been retained. Database inspection confirmed that loose installations still occur (most recent on June 23, 2026). This fallback remains necessary to handle cases where `plugin_setting_id` is missing from the callback URL during manual setups or when the TRMNL API `fetchMe` fails. Revisit and remove this flow if loose installs stop appearing after the manual-install path is fixed.


## Remove Temporal polyfill after Vercel supports Node 26 (2026-10-01: blocked on Vercel, not on Node)

`src/lib/billing-cycle.ts` and five other modules use `@js-temporal/polyfill` for
timezone-aware date arithmetic. Native `Temporal` would let us drop the dependency
and the import cost. It is **not** actionable yet, and the blocker is Vercel rather
than Node's release schedule — the older framing of this item ("once Node.js 26
reaches LTS") was wrong on both counts.

**Verified 2026-10-01 by running each interpreter, not by reading docs:**

| Node | `'Temporal' in globalThis` |
| --- | --- |
| 24.21.0 (Vercel Functions default) | **false** — only under `--harmony-temporal` |
| 25.9.0 | **false** |
| 26.10.0 | true |

- Temporal was unflagged by default in **Node 26 only** (V8 14.6). Node 24 and 25
  require `--harmony-temporal`, which is not a production option.
- **Vercel Functions offer only 24.x / 22.x / 20.x.** Node 26 is available on
  Vercel *Sandboxes*, which is a different product and does not affect this app.
- `cmd/next-app/package.json` declares `engines.node: ">=24.0.0"`, which Vercel's
  own mapping table resolves to the latest **24.x**.

**Change, once Vercel lists 26.x for Functions:** bump `engines.node`, replace
`import { Temporal } from '@js-temporal/polyfill'` with the global (all six call
sites are server-side — no `'use client'` — so there is no browser-polyfill
concern), then remove the dependency. Re-run the billing-cycle and
load-planning-context tests: `date_trunc`-style DST behavior is the risk, not the
API surface.

Do not "unblock" this with `NODE_OPTIONS=--harmony-temporal`; that would put
billing-window date math on a V8 experimental flag.

## Upgrade ESLint to v10 (blocked upstream)

`eslint` is pinned at `^9` because `eslint-config-next` bundles `eslint-plugin-react@7.37.5` (latest), whose eslint peer range caps at `^9.7`. ESLint 10 removed `context.getFilename()`, which that plugin still calls, so `npm run lint` crashes under v10. This is not a config-format issue — the repo already uses flat config (`eslint.config.mjs`).

**Change:** Once `eslint-plugin-react` (and `eslint-config-next`) declare eslint 10 support, bump `eslint` to `^10` and re-run `npm run lint`.


## Tesla OAuth: stop interpolating upstream bodies into classified errors (2026-10-01)

**This item replaces an earlier, partly-stale framing.** The old text claimed the
callback reports `invalid-id-token` when both token-endpoint hosts fail. That is
already fixed: `tesla-auth-service.ts:477-485` catches `TeslaTokenEndpointError`
and returns `token-exchange-failed` with the upstream status (pinned by four
tests). The real remaining defect is the second half, and
`DesignDecisions.md:346-381` already names both sites under "Known remaining
violations", states *"**Neither is fixed here**"*, and calls it a doc/code
contradiction. So this is a **known bug awaiting a fix**, not a new finding.

`isTeslaAuthError` (`tesla-client.ts:154-169`) classifies **by substring**. Two
paths build messages that classifier inspects out of upstream-controlled text:

1. `tesla-auth.ts:67-77` — the refresh fallthrough throws
   `` `Failed to refresh token: ${response.status} ${body}` `` with the **raw
   body** interpolated, while its own 401/400 condition does *not* classify as
   terminal. A 403 body containing `login_required`, or a 400 containing
   `invalid authentication`, is "retry later" to one classifier and "revoke this
   user" to the other. `tesla-token-repo.ts:72` feeds that into an atomic
   `auth_status='revoked', is_active=false` write.
2. `tesla-token-endpoint.ts:25-31` — `describeError` folds `err.cause.message`
   in verbatim, so a proxy/TLS cause string containing a trigger substring makes
   a `TeslaTokenEndpointError` classify as terminal.

**Change:** stop putting upstream bodies into messages on paths whose errors are
inspected by `isTeslaAuthError` — classify from the parsed error code or a typed
error field instead. Preserve the substring list itself: `DesignDecisions.md:311-326`
records it as load-bearing and pins it with `tesla-token-repo.test.ts`, and the
guardrail assertions in `tesla-auth.test.ts` (`not.toMatch(/login_required|invalid_grant/)`)
must survive. A separate, still-open question: transport/5xx failures on the
**JWKS** leg still surface as `invalid-id-token` (`tesla-auth-service.ts:526-539`),
which is the outage-vs-invalid-login conflation in its current form.

## Tesla OAuth: issuer-keyed JWKS client, and re-resolve after the discovery TTL (2026-09-30, PR #118)

Raised by review on PR #118. Both are pre-existing and unchanged by that branch, verified
against base commit `092b727`.

**1. One module-level client, keyed only by the previous issuer.**
`getOrCreateJwksClient` (`src/lib/tesla-auth-service.ts`) holds a single
`teslaJwksClient` + `lastIssuer` pair, and sets `lastIssuer` *before* awaiting
`getTeslaJwksUri(issuer)`. The racing caller does not lose immediately — each
continuation assigns and returns in one microtask, so it gets the client built for
its own issuer. The damage is **desynced module state**: a warm `/nts` client, a
`/v3` request in flight, then an `/nts` login, then the `/v3` await landing, leaves
`teslaJwksClient` holding the `/v3` key set while `lastIssuer` says `/nts`. The
**next** `/nts` login takes the false branch and verifies an `/nts` token against
the base `/v3` keys → genuine `SigningKeyNotFoundError` → `KidNotFoundError` →
the degraded path that **skips ID-token signature verification**
(`tesla-auth-service.ts:533-539`). This is the one path into that bypass which is
*not* a key-set miss. The same code also thrashes the client on issuer alternation.

**2. The 1-hour discovery TTL is never applied in the single-issuer flow.**
Once a client exists for the issuer Tesla actually uses, `issuer !== lastIssuer` is
false forever, so `getTeslaJwksUri` is never called again. Base behaved identically:
its removed `fetchFreshJwks(jwksUri)` took the *already-resolved* URI and did not
re-resolve. So if Tesla ever changes an issuer's `jwks_uri`, verification keeps
querying the old endpoint for the life of the instance. The TTL itself works
correctly when consulted (`tesla-auth-service.ts:96-98`) — the trigger is missing.
Rarely observable on serverless, where instances are short-lived.

**Change:** key clients by issuer in a `Map<string, client>` (the sibling
`discoveryCache` and `FALLBACK_JWKS_URIS` are already Maps, and
`__resetJwksClientForTests` is the single reset site to update), and rebuild the
client when the discovery entry has passed `DISCOVERY_CACHE_TTL_MS` so
`getTeslaJwksUri` is called again. Fixes both.

## Tesla OAuth: consider `require_requested_scopes` (2026-09-30, PR #118)

`prompt_missing_scopes=true` (set in PR #118) prompts for scopes the user has not granted
but **cannot** silently grant them. The sibling `require_requested_scopes` ("user must
authorize all requested scopes to proceed") is not set.

Latent today because the scope set is static (`tesla-authorize-url.ts`, hardcoded
`openid energy_device_data offline_access user_data energy_cmds`). **If a scope is
ever added**, a user who *declines* still completes login with a partial grant, and
the app fails later at point-of-use instead of at login. Decide the policy before the
first scope addition.

**Change:** set `require_requested_scopes` alongside `prompt_missing_scopes`, or document
why a partial grant is acceptable.

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
