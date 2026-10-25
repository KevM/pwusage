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

## iOS: macOS/tvOS readiness (2026-10-16)

Audit and evidence: [multiplatform readiness audit](docs/superpowers/specs/2026-10-16-multiplatform-readiness-audit.md). Item numbers below refer to its "Ordered refactors" table. No port is in progress.

- [ ] **Cheap seams, partly covered by the nav rework (items 1, 3, 5):** colour shim replacing the 24 `Color(uiColor:)` uses, semantic toolbar placements and an inline-title wrapper, and an `AppTab` enum. The [nav design](docs/superpowers/specs/2026-10-16-ios-sidebar-navigation-design.md) ("Platform portability") covers these in the files it touches only; finish the rest (untouched views, Shared tiles, widget files) opportunistically.
- [ ] **Seams follow-up PR, after the nav rework lands (items 2, 4, 6, 7, 8):** move `PWUsageAppModel` and `PWUsageApplicationAPI` out of the `@main` file, put the auth presentation anchor and `UIPasteboard` behind platform helpers (plus a `kSecUseDataProtectionKeychain` helper), add a `WidgetReloading` protocol for the `WidgetCenter`/`ControlCenter` calls, split `BatteryHoldActivityAttributes.ContentState` from ActivityKit, and use SwiftUI window sizing instead of `UIWindowScene.sizeRestrictions`. Touches `PWUsageApp.swift`, `MobileAuthService.swift`, `DashboardCache.swift`, so wait for the rework to avoid view conflicts.
- [ ] **tvOS device-code login spec (item 13), blocked on a product decision:** `ASWebAuthenticationSession` is unavailable on tvOS. Spec a QR plus short-code flow reusing the `MobileLoginHandoff` PKCE exchange (`/api/mobile/device`, `/login/device`, poll, `/auth/tesla-callback` branch) and Keychain-stored session token. Needs a security decision on session storage before building.
- [ ] **Revisit if we pursue Mac or TV (items 9–12, 14):** storage abstraction, `Shared/` reorganisation, `PWUsageCore` Swift package, native macOS target (menu bar extra, widgets), tvOS app. Unverified until then: tvOS cookie persistence, macOS app-group id format, `ControlCenter` macOS 26 requirement.

## iOS: delete the pre-redesign Smart Shift card code (2026-10-18, branch `claude/smart-shift-energy-weather-5de814`)

The energy weather redesign replaced the old Job card, but left its presentation code in place, now unreachable from any view. It still ships "export cushion" / "grid rate" copy.

- [ ] **Delete the dead copy and models:** `LoadTimingForecastPresentation.overlay` / `placement` (`Enhanced`, `Overlay`, `Card`, `Placement`), the unused `LoadTimingPresentation` statics (`recommendationMessage`, `energyImpact`, `costDifference`, `startNowSummary`, `runCardSummary`, `breakdownRows`, `missingBalanceNote`, `unavailableMessage`, `noChargeMessage`, `cycleObservationMessage`, `activeBalanceSummary`, `observedBalances`, `noResponseExplorationMessage`), and `LoadTimingRecommendation` if nothing else adopts it. Migrate the ~30 overlay tests in `LoadTimingViewTests` that guard the forecast note copy onto `forecastAvailability` / `forecastUnavailableNote` first, since those reuse the same note details.
- [ ] **Smart Shift polish from the branch review:**
  - "Covers all of this run" ignores periods the run crosses into.
  - After picking a Job, adding or editing another in Manage Jobs doesn't switch the card to it.
  - "Rate periods" omits a tariff period that has no balance yet.
  - A future energy source time shows the generic "can't compare" sentence.
  - VoiceOver reads "plus 18 kWh banked now".
  - At accessibility text sizes the cost bars can be squeezed out.
  - Six Jobs per pass now cost about 10 ms on the simulator (forecast, history or flat) since one plan is shared across the pass (branch `claude/smart-shift-bill-date-projection-2f834d`); cache per-Job savings only if devices still show hitches.

## Smart Shift bill-date projection follow-ups (2026-10-18, branch `claude/smart-shift-bill-date-projection-2f834d`)

Smart Shift now projects rate-period banks to the bill date from 7 days of Solcast and the site's last 28 days of grid history. See the [design](docs/superpowers/specs/2026-10-18-smart-shift-cycle-projection-design.md).

- [ ] **Backfill and per-slot rollups:** the projection reads whatever raw 5-minute history a site has (28 days, about 835 KB per read for Harrison, memoised per site per day). A new or patchy site gets flat banks or a noisy dull day until history fills in. Do this as part of the rollup-storage migration, and read the household pattern from rollups once they exist.
- [ ] **A measured 1-in-4 cloudy *week* for the cautious history:** the phone approximates one by moving each typical slot 1/√7 of the way toward the server's 1-in-4 dull day, which assumes days are independent (real cloudy spells cluster). Replace it with weeks ranked from months of history once backfill lands.
- [ ] **14-day projected-bill views using `pv_estimate10`:** a separate PR. The per-slot solar history (`solarKw`) added here is meant to feed it and to compare Solcast against what the roof actually did.

## Compact-archive migration (2026-10-19)

Phase 1 (`scripts/migrate-site-history.ts`, `src/lib/history-migration.ts`) backfills a site's raw history to `Site.installed` and archives every finished day before the 2-day floor, deleting nothing. See [the spec](docs/superpowers/specs/2026-10-19-history-backfill-and-archive-migration-design.md).

- [ ] **Production rollout:** one explicit site ID per run (preview, then `--apply`), oldest-installed first. Re-run later to archive days finished since. Backfill records `Site.history_backfill_from` once it confirms the pre-provisioning gap (Tesla's install date is the hardware install; Harrison had no data 2023-11-15 → 11-28 until the utility provisioned it), so re-runs stop re-fetching it. Harrison took 52 min on the Dev DB (39 MB DB read, 61 MB written); with the between-pass pause that keeps today-refresh working, expect roughly double.
  - **Status 2026-10-24:** Prod and Dev share a 500 MB quota, so full-history backfill is on hold until raw can be trimmed (needs compact reads on). All 8 active sites are archived through 2026-10-21 (`--skip-backfill --apply`, +4 MB), and the last 45 days' gaps were healed with `--repair-from 2026-09-09` (186 days, +7 MB). The daily archive cron is still off in Prod (`HISTORY_ARCHIVE_JOB_ENABLED` unset), so re-run to archive newer days. Freed ~85 MB by dropping `idx_energy_timestamp` and `REINDEX CONCURRENTLY` of the two `EnergyData` (timestamp, site_id) indexes, which the out-of-order backfill had bloated.
- [x] **Repaired gapped day tails on tokened sites (2026-10-25):** after the v1 → v2 conversion, Prod had 918 `gapped` days. About 97% ended early: the day was imported before it ended and its tail was never fetched, an old-import artifact. Days since the 2026-10-21 repair heal normally for sites in use. `migrate-site-history.ts --site-id <id> --skip-backfill --repair-from <first gapped date> --apply` refetched 519 days on 6 sites, and every one came back full. That also cleared all 3 `attribution-flag` days (2026-07-03). `convert-archives-v2.ts --apply` then converted everything to v2: **0 v1 days, 2,567 v2 days, all verified.**
  - **Left:** 511 `gapped` days on revoked sites, waiting for re-auth (same command once a user signs in). Two sites' tokens were refused during the repair and are now revoked: 282084616922, which stops ~13:40 local and has no import since 2026-10-07, and 189176704371. Also 3 `gapped` days on active sites that Tesla doesn't have: Harrison's 2023-11 pre-provisioning days, and 2252488382882515's install day (data starts 02:50).
  - **Not attributed:** 7 complete days on 189176704371 (2026-08-31 to 09-06) have `scheduleId: null` because their raw rows were imported without a matching tariff period. Re-attribution from stored samples (see the day record v2 spec) would fix them.
  - **Empty days inside history:** 268546532166 has no data for 2026-04-03 to 04-05. Repair skips empty days; only a backfill would try them.
- [ ] **Rolling backfill for older history:** backfill a month or two per active site → archive → trim that chunk's raw, repeat, capped at 1–2 years. Keeps peak DB size near today's instead of staging years of raw rows. Needs compact reads enabled and a per-run window cap in `migrateSiteHistory`.
- [ ] **Enable `COMPACT_HISTORY_READS_ENABLED`** in production.
- [ ] **Turn on unattended archiving in Prod** after the archive-all PR lands: `control-history-archive.ts archive-all` (commands in `docs/plans/2026-10-07-daily-history-archive-operations.md`). The job now archives after `HISTORY_ARCHIVE_AFTER_DAYS` (default 2) separately from `DATA_RETENTION_DAYS`, covers every owned site, and runs hourly from pg_cron. Backlog on 2026-10-24: ~2,500 unarchived site-days (mostly inactive sites), about 53 days at the default 2 per run; Prod runs `HISTORY_ARCHIVE_MAX_DAYS` at the cap (7 → 10 with this change; a 7-day run took ~13 s), about 10–15 days to drain. Archive-all was turned on 2026-10-24.
- [ ] **Archive cron trim mode** for migrated sites (`control-history-archive.ts trim …`); archive-all stays on, and only the listed sites are trimmed.
- [ ] **Archive-aware `/api/sync`:** `DataSyncer` (dashboard and usage pages) calls `/api/sync` → `ensureDataForRange` for the viewed range, and `planImport` counts raw rows only, so viewing a trimmed month would re-fetch it from Tesla and rewrite raw (dropping the archive). Same fix as gap-heal below: have the planner count archived days as covered. Blocks trim mode. (2026-10-24: compact reads verified to match raw on 5 Prod sites across archived and mixed ranges; only bucketed `id` differs, string vs number.)
- [ ] **Archive-aware gap-heal:** count archived days as covered, and when it heals a day older than the retention cutoff, finalize that day into the archive instead of leaving raw rows. Without this, gap-heal (`GAP_HEAL_DAYS = 14`, raw-only `countAlignedSamples`) sees trimmed days as holes, re-fetches from Tesla, rewrites raw rows, and the invalidation trigger drops the archive: a churn loop.
- [ ] **Lower `DATA_RETENTION_DAYS` in steps** (365 → 30 → 7). Archiving no longer waits on retention (`HISTORY_ARCHIVE_AFTER_DAYS`), so this only changes how long raw rows stay. Both cutoffs floor at 2 days (`archiveCutoff`, `HistoryArchiveRepo.next`); going lower needs a change there.
- [ ] **Re-check raw-only reads with a short raw window:** `today-refresh.ts` (latest raw row), `battery-hold-monitor-service.ts` (last 30 min raw), `user-repo.ts` admin `last_data_import` (MAX raw timestamp).
- [ ] **Daily backup sizing for day records:** `dump-db-backup.sh` excludes only `EnergyData`, so every daily backup now carries all day-record history, and `docs/database-backups.md`'s figures (daily ≈ 3 MB, ~0.38 GB/month egress) no longer hold. Re-measure daily and weekly sizes and egress. Decide whether daily keeps full day-record history: it makes daily a complete restore on its own, so the weekly merge may simplify. Once raw drains, either drop `energy-recent.csv` or switch it to recent day records. Update the restore runbook, which assumes history comes from the weekly. See the "Operational consumers" table in `docs/plans/2026-10-24-day-record-v2.md`.
- [ ] **New-site history onboarding:** automatic, budgeted backfill for new sites so Smart Shift gets years of history without an operator run. Likely a pg_cron-driven route (60 s Hobby cap) reusing `migrateSiteHistory` with a per-run window cap and per-site progress (e.g. `history_backfilled_through`), stopping at the 2-day floor. It should honor `Site.history_backfill_from` (pre-provisioning gap) and must not re-fetch other days Tesla can't fill on every run. Needs its own design (spec "Follow-up" section).

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

## Live Activity delivery (battery hold Tasks 5–6)

Task 5 (APNs sender and delivery trigger) landed the claim/acknowledge contract, the
`ended`-row token clearing and the terminal backoff bypass; see
[`docs/battery-hold-live-activity-delivery.md`](./docs/battery-hold-live-activity-delivery.md).
Delete items as they land.

- [ ] **Enable the production schedule deliberately.** Merging the Task 5 migration starts `battery-hold-activity-delivery-trigger` every 5 minutes (`2-59/5`). The `APNS_*` variables are set in Production and Preview, so each run reconciles and claims. After merge, confirm pg_net responses, runtime and egress over a few runs. If manual-stop latency (up to 5 minutes) is noticeable in Task 6, send from the stop path rather than running the cron more often.
- [ ] **Smaller deferred items:** token rotation leaves a `current` row current, so the new token gets nothing until the next desired change (ActivityKit keeps the shown content, so this is believed fine; confirm on device in Task 6); no `Origin` check on DELETE and no body size cap; optional `register` assertion in the in-window terminal route test; the slow-reconcile test (5 s) is shorter than the 10 s restore deadline (the ordering test already pins placement); no test for the cross-user same-registration-id case; a theoretical deadlock between the no-id and per-hold syncs is bounded by `lock_timeout` and caught. iOS presents `status = 'active'` with the `restoring` phase or a `restore_reason` as "Restoring" (`BatteryHoldActivityPresentation`).
- [ ] **Rows that lose access stay pending until expiry.** The claim skips them (no push), and expiry clears their token within 12 hours. Disabling at claim time would also strand a user whose `is_active` flips back after a Tesla re-login, so this was left as is.
- [ ] **Design note before the plan finishes:** add a `DesignDecisions.md` section for the activity bookkeeping invariants: SQL-side monotonic guards in `syncDesired`, bookkeeping only after lease release and outside restore deadlines, the periodic no-id reconcile as the recovery path, production APNs only when `VERCEL_ENV === 'production'` (gated at registration and claim), the dev copy deleting all activity rows, owner-conditioned advance-only acknowledgement, data-time APNs timestamps, and "accepted is not delivered".

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
