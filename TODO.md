# TODO

Cross-session work that didn't fit the current focus. Pull from this list when picking up new work.

## Database Egress Reduction Follow-ups

These were identified during the audit that produced the Trmnl markup cycle aggregation work. They're smaller individual wins than the cycle-aggregation change but still worthwhile once that lands.

### Remove unused db tables from the db

- **Where:** Database schema / Migrations
- **Change:** Drop any tables that are no longer used by the application to clean up the schema.
- **Impact:** Cleaner database schema and reduced maintenance overhead.
- **Risk:** High — ensure absolutely no code paths rely on these tables before dropping.


### Replace `SELECT *` with column projection in `getRawEnergyData`

- **Where:** `cmd/next-app/src/lib/energy-repo.ts` — `getRawEnergyData` and `getRawEnergyDataWithTz`
- **Change:** Project only the columns callers actually use: `timestamp, tariff_id, load_power, solar_power, grid_power, battery_power, battery_soc`. Drop `id` from the wire.
- **Callers to verify after change:** `cmd/next-app/src/app/api/site-live-data/route.ts`, `cmd/next-app/src/app/api/site/[id]/analysis/route.ts`, `cmd/next-app/src/app/api/trmnl/markup/route.ts` (today-only path after the C-2 work lands).
- **Impact:** ~10–15% wire reduction on every call to these methods.
- **Risk:** Low — mechanical change, existing tests should catch regressions.

### Lower `HeaderLiveStats` polling cadence and pause when tab hidden

- **Where:** `cmd/next-app/src/components/HeaderLiveStats.tsx`
- **Change:** Increase `setInterval` from `120000` (2 min) to `300000` (5 min). Add a `document.visibilityState` listener so polling pauses when the tab is hidden and resumes on focus (use `visibilitychange` event).
- **Impact:** ~60% reduction on `/api/site-live-data` calls for active tabs; effectively eliminates calls from backgrounded tabs.
- **Risk:** Low — UX impact is acceptable since live header values aren't critical to drive decisions on. Check that re-fetch on focus works smoothly without flicker.

### Aggregate sparkline data in SQL for `/api/site-live-data`

- **Where:** `cmd/next-app/src/app/api/site-live-data/route.ts` and `cmd/next-app/src/app/api/site-live-data/sparkline-utils.ts`
- **Change:** Replace the raw 5-minute fetch with a SQL query that buckets to 15-minute windows using `date_trunc('15 minutes', timestamp)` and `AVG(...)` over `solar_power, grid_power, load_power`. Returns ~16 rows per metric instead of ~144. Update `toSparklinePayload` to consume pre-bucketed input.
- **Impact:** ~90% wire reduction on this endpoint's row data.
- **Risk:** Medium — verify sparkline visual output matches before/after with representative data; tests in `sparkline-utils.test.ts` need updating.

### Refactor usage page to use `getCycleAggregates` instead of `getUsageByTOU`

- **Where:** `cmd/next-app/src/lib/energy-repo.ts` — `getUsageByTOU`; callers in `cmd/next-app/src/app/site/[id]/usage/page.tsx` and `cmd/next-app/src/app/site/[id]/page.tsx`
- **Change:** Replace the full-cycle raw fetch in `getUsageByTOU` with the same split strategy used in the Trmnl markup route: `getCycleAggregates(siteId, billingStart, todayStart)` for prior days + `getRawEnergyData(siteId, todayStart, now)` for today. Merge the two result sets using `scheduleMap` for prior rows and `Schedule.getTariffPeriod` for today rows (same pattern as `validate-aggregation.ts`).
- **Impact:** Same ~20× egress reduction per usage page load for users with long billing cycles.
- **Risk:** Low — `validate-aggregation.ts` confirms numerical equivalence across all sites; update the existing usage page tests after refactoring.

## How to use this list

When starting fresh work in this repo, check this file. If a session begins something here, leave a short note (date + branch/PR) under the item so the next session knows it's in flight. Once landed, delete the item.
