# Ingestion / Cron / Billing-Window Bug Hunt — Results (2026-07-12)

## Hunt scope
Data-ingestion and background-job layer: importer (index, import-planner,
energy-transformer, soc-interpolation), import-lock, today-refresh,
sync/import/analysis routes, cron routes (check-users, cleanup,
restore-reserve), energy-repo read/write paths, site-repo locks/claims,
tesla-client + factory + token-repo, user-repo, site-service, date-utils,
billing-cycle, plus the usage-page billing-window orchestration.
(Prior hunts covered: recommendation/analytics layer plan on 2026-07-07 —
still unexecuted; time/money date math in #103; live-status / TRMNL billing /
importer completeness in #98; routes+auth in #101/#102.)

## Bugs found and fixed
- /site/[id]/usage rendered without any authorization (IDOR): Gated page access using `verifySiteAccess` and `getCurrentUser` helpers.
- check-users cron deactivated users on transient Tesla errors (app lockout): Updated `verifyUserStatus` to check if `isTeslaAuthError(err)` before deactivating the user, retaining active status for transient failures.
- check-users cron verified with stale bulk-read tokens + unlocked refresh
  (burned rotated refresh tokens → spurious revocations; plausible
  "daily reauth" mechanism): Rewrote `verifyUserStatus` to use the dynamic `createTeslaClientForSite` factory (fresh DB token read + locked refresh handler) and updated `verifyAllUserStatuses` to fetch users without pre-reading tokens.
- Billing-cycle ends derived as start+1month / 35-day pivot (dropped days,
  stuck next-navigation, frozen TRMNL cycle totals, two-month "bills" for
  day>=29 anchors): Added a new shared `getNextCycleStart` helper that properly advances the month and re-anchors to the billing day using Temporal's overflow constrain logic, replacing the old ad-hoc end date calculations in site-service, TRMNL markup, and the usage page.
- ×1000 "day aggregate" scaling only ever misfired (85 poisoned rows found in
  prod data, Feb 19 – Apr 27; no real aggregates exist for single-day
  requests): scaling removed, rows repaired by migration: Removed daily aggregate scaling from `energy-transformer.ts`, simplified signature/calls, updated tests, and generated SQL migration `20260712205548_repair_x1000_scaled_energy_rows.sql` to divide inflated values by 1000.
- getUsageByTOU splitPoint ignored `start` (future cycles included today's
  rows): Clamped the `splitPoint` between `start` and `end` Dates using `Math.max` and `Math.min`.
- Analysis route returned 404 before auth (site-id existence oracle): Moved AUTH CHECK block to execute before `getSite` lookup.

## Known issues documented, deliberately not changed
1. `/api/site/[id]/analysis?force=true` steals the import lock and bypasses every throttle on a GET (`acquireImportLock` force path + `Importer.pendingSyncs` force bypass): repeated force requests trigger unbounded billable Tesla refetches and can steal the lock mid-import. Possibly intentional as a debug tool; needs a product decision (rate-limit or admin-gate), not a drive-by fix.
2. `Importer.loadInterval` returns unfiltered `energyDatas` while persisting `filteredDatas` (`importer/index.ts:398-417`): callers would see rows outside the requested window — currently dead payload (no caller consumes `EnsureDataResult.rows`).
3. `refreshTodayData` reports `no-new-rows` even when `persistHistory` updated overlap rows (`today-refresh.ts:149-155`): status is cosmetic; callers ignore it today.
4. `TeslaClient.fetch` never consumes the 429 response body before retrying — undici keeps the socket alive until GC; harmless at current volume.
5. `TeslaTokenRepo.releaseRefreshLock`/`updateSiteTokens` don't verify lock ownership: a refresh that outlives the 60s lock can release a successor's lock or clobber newer tokens. Requires the cross-instance claim pattern (`DesignDecisions.md`); window is tiny.
6. `upsertOnTeslaAuth` ON CONFLICT doesn't update `token_expires_at` — the column is written on insert only and read nowhere; flag for schema cleanup.
7. `getUsageByTOU` pass-1 midpoint fallback uses UTC-day + 12h for rows with NULL `tariff_schedule_id` — approximate TOU attribution by design; only affects synthetic-fallback rows.
8. `check-users` cron runtime is unbounded (sequential `getLiveStatus` per stale user + 200ms sleep); fine at current user count, will not scale past the function timeout.
9. The 2026-07-07 load-timing plan (`docs/superpowers/plans/2026-07-07-load-timing-bug-hunt-fixes.md`) is still unexecuted — separate effort, untouched by this plan.

## Modules audited with no defects found
import-planner (auditDays/planImport/splitAtSiteMidnight), soc-interpolation,
import-lock, site-repo import-lock/live-refresh claims and upsert, tesla-client
fetch/401-refresh/429-backoff and formatDateWithTimezone (probed on Node 26:
midnight renders 00, GMT+0/GMT+5:30 offsets parse correctly),
tesla-client-factory, date-utils, billing-cycle.getCurrentCycleStart,
sync/import/cleanup/restore-reserve routes, today-refresh throttle+claim flow,
site-service auth flow.
