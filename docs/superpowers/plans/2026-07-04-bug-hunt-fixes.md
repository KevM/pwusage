# Bug Hunt Fixes (2026-07-04) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the five code bugs and one doc bug found in the 2026-07-04 bug hunt: intermittent 500s from concurrent live-data polls, TRMNL bill dropping days billed under older tariff versions, importer discarding simultaneous grid import+export, a TypeError in the token-refresh waiter, UTC-based date bounds in the load-analysis page, and a misleading comment in billing-cycle.

**Architecture:** All fixes are small, surgical changes to existing modules — no new files except none. Each task follows TDD: extend the module's existing co-located Vitest suite with a failing test, make it pass, commit. Tasks are independent and can be done in any order, but the numbering below goes highest-impact first.

**Tech Stack:** Next.js App Router (Node runtime), TypeScript, Vitest, PostgreSQL via `pg` pool. All paths below are relative to the repo root. All test/build commands run from `cmd/next-app/`.

**Working conventions (from CLAUDE.md / user prefs):**
- Run `npm test`, `npm run lint`, and `npm run build` from `cmd/next-app` before declaring done.
- Commit locally; **never push** unless the user explicitly asks.
- Run git commands without a leading `cd` (use `git -C` or run from the repo root).

---

### Task 1: `refreshLiveStatus` — fall back to stale cache when a refresh is already in flight

**Why:** `HeaderLiveStats`, `SiteLiveStats`, and `DashboardCards` each poll `/api/site-live-data` independently. When the 60s cache is stale, two concurrent requests race; the loser hits the `state.liveInFlight` early-return in `refreshLiveStatus`, which returns `{ status: 'in-flight' }` with **no** `liveStatus`. The route treats any result without `liveStatus` as a 500 ([route.ts:49](../../cmd/next-app/src/app/api/site-live-data/route.ts)). The claim-failure branch a few lines down already falls back to the stale cache — the in-flight branch should do the same.

**Files:**
- Modify: `cmd/next-app/src/lib/today-refresh.ts` (lines ~202-205, the `state.liveInFlight` branch)
- Test: `cmd/next-app/src/lib/today-refresh.test.ts` (add to the existing `describe('refreshLiveStatus')` block)

- [ ] **Step 1: Write the failing test**

Add to the `describe('refreshLiveStatus', ...)` block in `cmd/next-app/src/lib/today-refresh.test.ts`. It mirrors the existing "sets liveInFlight before awaiting tokens" test (which asserts the no-cache case returns `in-flight` — that test must keep passing), but this time a stale cache exists:

```ts
    it('falls back to the stale cache when another request is already in flight', async () => {
        const staleAt = Date.now() - 17 * 60 * 1000; // older than the 16-min TTL
        siteRepoMock.getSite.mockResolvedValue({
            id: 'site-1',
            live_status_cache: { percentage_charged: 55 },
            last_live_refresh_at: staleAt,
        });

        let resolveTokens: (val: typeof tokens) => void;
        userRepoMock.getTokensForSite.mockReturnValue(new Promise((resolve) => {
            resolveTokens = resolve;
        }));

        const { refreshLiveStatus } = await importRefreshLiveStatus();

        // First call: cache is stale, so it proceeds to refresh and blocks on token lookup
        const firstPromise = refreshLiveStatus('site-1');

        // Second call arrives while the first is in flight: must serve the stale
        // cache instead of returning a liveStatus-less 'in-flight' result
        const secondResult = await refreshLiveStatus('site-1');
        expect(secondResult).toMatchObject({
            status: 'cached',
            liveStatus: { percentage_charged: 55 },
            fetchedAt: staleAt,
        });

        resolveTokens!(tokens);
        await expect(firstPromise).resolves.toMatchObject({ status: 'refreshed' });
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `cmd/next-app/`): `npm test -- src/lib/today-refresh --run`
Expected: the new test FAILS with the second result being `{ status: 'in-flight' }` instead of `cached`. All other tests pass.

- [ ] **Step 3: Implement the fix**

In `cmd/next-app/src/lib/today-refresh.ts`, replace the `liveInFlight` early return:

```ts
        const state = getState(siteId);
        if (state.liveInFlight) {
            return { status: 'in-flight' };
        }
```

with:

```ts
        const state = getState(siteId);
        if (state.liveInFlight) {
            // Serve the stale cache rather than a liveStatus-less result: multiple
            // components poll the same site concurrently and callers treat a
            // missing liveStatus as a hard failure (HTTP 500).
            if (cachedStatus && useCached) {
                return { status: 'cached', liveStatus: cachedStatus, fetchedAt };
            }
            return { status: 'in-flight' };
        }
```

(`cachedStatus`, `useCached`, and `fetchedAt` are already defined above this point in the function.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/lib/today-refresh --run`
Expected: ALL tests pass, including the pre-existing `'sets liveInFlight before awaiting tokens...'` test (its mock has `live_status_cache: null`, so it still gets `in-flight`).

- [ ] **Step 5: Commit**

```bash
git add cmd/next-app/src/lib/today-refresh.ts cmd/next-app/src/lib/today-refresh.test.ts
git commit -m "fix(live-status): serve stale cache when a live refresh is already in flight

Concurrent polls from HeaderLiveStats/SiteLiveStats/DashboardCards raced on
a stale cache; the loser got a liveStatus-less in-flight result which
/api/site-live-data turned into an intermittent 500."
```

---

### Task 2: TRMNL bill — resolve tariff/schedule ids across ALL tariff versions

**Why:** `aggregateUsage` (the TRMNL markup aggregation) builds its lookup maps only from `site.tariffs`, which `SiteRepo.getSite` restricts to `t.is_current`. `EnergyData` rows keep the tariff/schedule ids they were imported under, so after a mid-cycle tariff version bump, pre-change days resolve to "Unknown" with 0 rates → $0 cost, understating the bill. `EnergyRepo.getUsageByTOU` was already fixed for exactly this (see its comment "must cover ALL tariff versions"); this task applies the same fix to the TRMNL path.

**Design:** Keep `aggregateUsage` pure. Add two optional trailing parameters — `historicalTariffs` and `historicalSchedules` — seeded into the maps **before** `site.tariffs` so current versions win on id collisions. The markup route fetches them via the existing `TariffRepo.getTariffsForSite` / `getSchedulesForSite` (same methods `getUsageByTOU` uses) inside its existing parallel fetch block.

**Files:**
- Modify: `cmd/next-app/src/lib/tou-aggregation.ts` (signature + map seeding, lines ~34-52)
- Modify: `cmd/next-app/src/app/api/trmnl/markup/route.ts` (parallel fetch block ~line 162, `aggregateUsage` call ~line 242, imports)
- Test: `cmd/next-app/src/lib/tou-aggregation.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `cmd/next-app/src/lib/tou-aggregation.test.ts` (uses the existing `makeTestTariff()` helper and `TZ` const already in the file):

```ts
    it('resolves prior-cycle rows tagged with an older tariff version via historical maps', () => {
        const tariffs = makeTestTariff(); // current version: tariff id 1, schedules 10/20
        const site: SiteWithTariffs = {
            id: 'test_site',
            name: 'Test Site',
            timezone: TZ,
            billing_start_day: 1,
            updated: new Date(),
            installed: new Date(),
            json: {},
            tariffs
        };
        const schedule = new Schedule(tariffs, TZ);

        // A row imported under a PREVIOUS tariff version (tariff 99 / schedule 990),
        // which is no longer in site.tariffs because is_current = false.
        const priorAggregates: CycleAggregateRow[] = [
            {
                day: new Date('2026-01-10T00:00:00Z'),
                tariff_id: 99,
                tariff_schedule_id: 990,
                load_power: 1000,
                solar_power: 0,
                grid_power: 2000, // 2 kWh import
                battery_power: 0
            }
        ];

        const historicalTariffs: Tariff[] = [
            { id: 99, site_id: 'test_site', name: 'Old Tariff', updated: new Date('2025-06-01') }
        ];
        const historicalSchedules = [
            {
                id: 990, season_id: 900, name: 'Old-Peak',
                buy_rate: 0.25, sell_rate: 0.12,
                from_day_of_week: 0, to_day_of_week: 6,
                from_hour: 0, from_minute: 0,
                to_hour: 24, to_minute: 0,
            }
        ];

        const result = aggregateUsage(
            site, priorAggregates, [], schedule,
            historicalTariffs, historicalSchedules
        );

        const oldGroup = result.tariffGroups.find(g => g.tariffName === 'Old Tariff');
        expect(oldGroup).toBeDefined();
        const period = oldGroup!.periods.find(p => p.touName === 'Old-Peak');
        expect(period).toBeDefined();
        // 2 kWh import at the historical 0.25 buy rate
        expect(period!.cost).toBeCloseTo(0.5, 5);
        expect(result.totalBillCost).toBeCloseTo(0.5, 5);
    });

    it('still reports Unknown/$0 without historical maps (documents the pre-fix fallback)', () => {
        const tariffs = makeTestTariff();
        const site: SiteWithTariffs = {
            id: 'test_site', name: 'Test Site', timezone: TZ, billing_start_day: 1,
            updated: new Date(), installed: new Date(), json: {}, tariffs
        };
        const schedule = new Schedule(tariffs, TZ);
        const priorAggregates: CycleAggregateRow[] = [
            {
                day: new Date('2026-01-10T00:00:00Z'),
                tariff_id: 99,
                tariff_schedule_id: 990,
                load_power: 1000, solar_power: 0, grid_power: 2000, battery_power: 0
            }
        ];

        const result = aggregateUsage(site, priorAggregates, [], schedule);
        // Without version history the row can't be priced — cost stays 0.
        expect(result.totalBillCost).toBe(0);
    });
```

Also extend the import at the top of the test file if needed — `TariffSchedule` is not currently imported there; the `historicalSchedules` literal above is structurally typed so no import change is required.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/tou-aggregation --run`
Expected: FAIL — TypeScript/runtime error because `aggregateUsage` only takes 4 arguments (extra args ignored at runtime, so the first new test fails on `oldGroup` being `undefined` / cost 0).

- [ ] **Step 3: Implement the fix in `tou-aggregation.ts`**

Change the signature and map seeding in `cmd/next-app/src/lib/tou-aggregation.ts`:

```ts
export function aggregateUsage(
    site: SiteWithTariffs,
    priorAggregates: CycleAggregateRow[],
    todayRaw: EnergyData[],
    schedule: Schedule,
    // Tariff/schedule rows from ALL versions (including is_current = false).
    // EnergyData rows keep the ids they were imported under, so without these
    // a mid-cycle tariff version bump makes pre-change days resolve to
    // 'Unknown' at $0. Mirrors EnergyRepo.getUsageByTOU.
    historicalTariffs: Tariff[] = [],
    historicalSchedules: TariffSchedule[] = []
): TouAggregationResult {
    const tariffMap = new Map<number, Tariff>();
    const scheduleMap = new Map<number, TariffSchedule>();

    // Seed historical versions first so current versions win on id collisions.
    historicalTariffs.forEach(t => tariffMap.set(t.id, t));
    historicalSchedules.forEach(s => scheduleMap.set(s.id, s));

    site.tariffs.forEach(t => {
        tariffMap.set(t.id, t);
        if (t.seasons) {
            t.seasons.forEach(season => {
                if (season.schedules) {
                    season.schedules.forEach(s => scheduleMap.set(s.id, s));
                }
            });
        }
    });
```

The rest of the function body is unchanged — the existing `scheduleMap.get(row.tariff_schedule_id)` and `tariffMap.get(row.tariff_id)` lookups now find historical versions. Note: in Pass 1, when the schedule lookup succeeds via a historical schedule but `tariffMap.get(row.tariff_id)` finds the historical tariff, `currentTariff`/`tariffName` come from the historical tariff — that is the desired behavior (bill line shows the tariff the energy was billed under).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/lib/tou-aggregation --run`
Expected: PASS (both new tests plus existing).

- [ ] **Step 5: Wire the markup route to fetch all versions**

In `cmd/next-app/src/app/api/trmnl/markup/route.ts`:

Add the import (with the other `@/lib` imports at the top):

```ts
import { TariffRepo } from '@/lib/tariff-repo';
```

Extend the existing parallel DB fetch (currently `const [latestData, priorAggregates, todayRaw] = await Promise.all([dbLatestPromise, dbCyclePromise, dbTodayPromise]);` around line 162):

```ts
        const tariffRepo = new TariffRepo();
        const [latestData, priorAggregates, todayRaw, allTariffVersions, allScheduleVersions] = await Promise.all([
            dbLatestPromise,
            dbCyclePromise,
            dbTodayPromise,
            tariffRepo.getTariffsForSite(site!.id),
            tariffRepo.getSchedulesForSite(site!.id),
        ]);
```

And pass them at the `aggregateUsage` call site (around line 242):

```ts
        const { tariffGroups, totalBillCost, seriesData, latestSeriesSoc } = aggregateUsage(
            site,
            priorAggregates,
            todayRaw,
            schedule,
            allTariffVersions,
            allScheduleVersions
        );
```

- [ ] **Step 6: Run the full suite, lint**

Run: `npm test -- --run` then `npm run lint`
Expected: all tests pass; lint clean.

- [ ] **Step 7: Commit**

```bash
git add cmd/next-app/src/lib/tou-aggregation.ts cmd/next-app/src/lib/tou-aggregation.test.ts cmd/next-app/src/app/api/trmnl/markup/route.ts
git commit -m "fix(trmnl): price cycle days billed under older tariff versions

aggregateUsage only resolved ids against site.tariffs (is_current), so a
mid-cycle tariff version bump made pre-change days show Unknown/\$0 on the
TRMNL bill. Seed the lookup maps with all versions, mirroring the fix
already in EnergyRepo.getUsageByTOU."
```

---

### Task 3: Importer — net simultaneous grid import/export and battery charge/discharge

**Why:** `transformEnergyPoints` uses either-or logic: `grid = gridImported !== 0 ? gridImported : -gridExported`. When one 5-minute interval has both import and export (cloud edges, load transitions), the export is silently discarded, skewing import/export splits and cost. Netting (`imported - exported`) is identical to the current behavior when only one side is nonzero and strictly better when both are. Same for battery charge/discharge.

**Note on daily aggregates:** the same code path handles full-day rollup rows (period `day`, duration > 20h), where both sides are almost always nonzero. The schema stores a single signed `grid_power`, so gross split is unrepresentable for those rows either way; net is the least-wrong single number (the current code stores gross import only, which overstates cost on export-heavy days).

**Files:**
- Modify: `cmd/next-app/src/lib/importer/energy-transformer.ts` (lines ~59-65)
- Test: `cmd/next-app/src/lib/importer/energy-transformer.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to the `describe('transformEnergyPoints', ...)` block in `cmd/next-app/src/lib/importer/energy-transformer.test.ts`:

```ts
    it('nets grid_power when an interval has both import and export', () => {
        const history = [makeEntry({ grid_energy_imported: 50, total_grid_energy_exported: 300 })];
        const [row] = transformEnergyPoints(history, [], 'day', 1, CONTEXT);
        expect(row.grid_power).toBe(-250); // 50 imported - 300 exported
    });

    it('nets battery_power when an interval has both charge and discharge', () => {
        const history = [makeEntry({ total_battery_charge: 20, total_battery_discharge: 120 })];
        const [row] = transformEnergyPoints(history, [], 'day', 1, CONTEXT);
        expect(row.battery_power).toBe(-100); // 20 charged - 120 discharged
    });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/lib/importer/energy-transformer --run`
Expected: both new tests FAIL (`grid_power` is `50`, `battery_power` is `20`). Existing exclusive-case tests pass.

- [ ] **Step 3: Implement the fix**

In `cmd/next-app/src/lib/importer/energy-transformer.ts`, replace:

```ts
        const gridImported = h.grid_energy_imported ?? 0;
        const gridExported = h.total_grid_energy_exported ?? 0;
        const grid = gridImported !== 0 ? gridImported : -gridExported;

        const batteryCharge = h.total_battery_charge ?? 0;
        const batteryDischarge = h.total_battery_discharge ?? 0;
        const battery = batteryCharge !== 0 ? batteryCharge : -batteryDischarge;
```

with:

```ts
        // Net rather than either-or: a single interval can have both import and
        // export (or charge and discharge), and the schema stores one signed value.
        const gridImported = h.grid_energy_imported ?? 0;
        const gridExported = h.total_grid_energy_exported ?? 0;
        const grid = gridImported - gridExported;

        const batteryCharge = h.total_battery_charge ?? 0;
        const batteryDischarge = h.total_battery_discharge ?? 0;
        const battery = batteryCharge - batteryDischarge;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/lib/importer/energy-transformer --run`
Expected: ALL tests pass (the exclusive-case tests `200-0=200`, `0-150=-150`, `80-0=80`, `0-40=-40` are unchanged by netting).

- [ ] **Step 5: Commit**

```bash
git add cmd/next-app/src/lib/importer/energy-transformer.ts cmd/next-app/src/lib/importer/energy-transformer.test.ts
git commit -m "fix(importer): net grid and battery energy instead of dropping the smaller side

Intervals with both import and export (or charge and discharge) silently
discarded the export/discharge side, skewing splits and cost."
```

---

### Task 4: `waitForTokenRefresh` — clean error when the user row disappears

**Why:** `TeslaTokenRepo.waitForTokenRefresh` does `const row = res.rows[0];` then immediately reads `row.is_refreshing`. If the user row is deleted while a waiter polls, this throws `TypeError: Cannot read properties of undefined` instead of a meaningful error.

**Files:**
- Modify: `cmd/next-app/src/lib/tesla-token-repo.ts` (lines ~16-18, inside the polling loop)
- Test: `cmd/next-app/src/lib/tesla-token-repo.test.ts` (add to `describe('TeslaTokenRepo.waitForTokenRefresh')`)

- [ ] **Step 1: Write the failing test**

Add to the `describe('TeslaTokenRepo.waitForTokenRefresh', ...)` block (uses the existing `makeSiteJoinRow` helper and `queryMock`):

```ts
    it('throws a clean error when the user row no longer exists', async () => {
        // getSite JOIN query succeeds
        queryMock.mockResolvedValueOnce({ rows: [makeSiteJoinRow()] });
        // User polling query returns no rows (user deleted mid-wait)
        queryMock.mockResolvedValueOnce({ rows: [] });

        await expect(tokenRepo.waitForTokenRefresh('site-1'))
            .rejects.toThrow('Token refresh wait failed: user not found');
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/tesla-token-repo --run`
Expected: FAIL with `TypeError: Cannot read properties of undefined (reading 'is_refreshing')` instead of the expected error message.

- [ ] **Step 3: Implement the fix**

In `cmd/next-app/src/lib/tesla-token-repo.ts`, inside the `while` loop of `waitForTokenRefresh`, replace:

```ts
            const res = await pool.query(`SELECT access_token, refresh_token, is_refreshing, auth_status FROM "User" WHERE id = $1`, [site.user_id]);
            const row = res.rows[0];
            if (!row.is_refreshing) {
```

with:

```ts
            const res = await pool.query(`SELECT access_token, refresh_token, is_refreshing, auth_status FROM "User" WHERE id = $1`, [site.user_id]);
            const row = res.rows[0];
            if (!row) {
                throw new Error('Token refresh wait failed: user not found');
            }
            if (!row.is_refreshing) {
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/lib/tesla-token-repo --run`
Expected: ALL tests pass.

- [ ] **Step 5: Commit**

```bash
git add cmd/next-app/src/lib/tesla-token-repo.ts cmd/next-app/src/lib/tesla-token-repo.test.ts
git commit -m "fix(tesla-auth): clean error instead of TypeError when user row vanishes during token wait"
```

---

### Task 5: Load-analysis page — compute "today" in the site timezone, not UTC

**Why:** `LoadAnalysisClientPage` uses `new Date().toISOString().split('T')[0]` (UTC date) for both the fallback initial date (line 31) and the date picker `max` (line 301). For a Pacific-time site after ~4-5pm the picker allows an empty "tomorrow"; for timezones east of UTC the `max` blocks selecting the actual current day. The component already receives `siteTimezone` as a prop.

**Design:** Add a small client-safe helper `todayDateStrInTimeZone(tz)` to `format-utils.ts` (pure `Intl`, no Temporal polyfill — keeps the client bundle clean; `date-utils.ts` pulls in `@js-temporal/polyfill` and is server-oriented). `en-CA` locale formats as `YYYY-MM-DD`.

**Files:**
- Modify: `cmd/next-app/src/lib/format-utils.ts`
- Modify: `cmd/next-app/src/components/LoadAnalysisClientPage.tsx` (lines 31 and 301)
- Test: `cmd/next-app/src/lib/format-utils.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `cmd/next-app/src/lib/format-utils.test.ts` (add `todayDateStrInTimeZone` to the existing import from `./format-utils`, and `vi` to the vitest import if not present):

```ts
describe('todayDateStrInTimeZone', () => {
    it('returns the date for the given timezone, not UTC', () => {
        // 2026-07-04T03:00:00Z is still 2026-07-03 in Los Angeles (UTC-7)
        // and already 2026-07-04 in UTC.
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-04T03:00:00Z'));

        expect(todayDateStrInTimeZone('America/Los_Angeles')).toBe('2026-07-03');
        expect(todayDateStrInTimeZone('UTC')).toBe('2026-07-04');
        // East of UTC: Sydney (UTC+10) is already on the 4th
        expect(todayDateStrInTimeZone('Australia/Sydney')).toBe('2026-07-04');

        vi.useRealTimers();
    });

    it('formats as YYYY-MM-DD', () => {
        expect(todayDateStrInTimeZone('UTC')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/format-utils --run`
Expected: FAIL — `todayDateStrInTimeZone` is not exported.

- [ ] **Step 3: Implement the helper**

Append to `cmd/next-app/src/lib/format-utils.ts`:

```ts
/**
 * Today's date as "YYYY-MM-DD" in the given IANA timezone. Client-safe
 * (pure Intl — no Temporal polyfill); falls back to UTC on a bad timezone.
 */
export function todayDateStrInTimeZone(timeZone: string): string {
    try {
        // en-CA formats as YYYY-MM-DD
        return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
    } catch {
        return new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC' }).format(new Date());
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/lib/format-utils --run`
Expected: PASS.

- [ ] **Step 5: Use the helper in `LoadAnalysisClientPage`**

In `cmd/next-app/src/components/LoadAnalysisClientPage.tsx`:

Add to the imports:

```ts
import { todayDateStrInTimeZone } from '@/lib/format-utils';
```

Replace line 31:

```ts
    const initialDate = searchParams.get('date') || defaultDate || new Date().toISOString().split('T')[0];
```

with:

```ts
    const initialDate = searchParams.get('date') || defaultDate || todayDateStrInTimeZone(siteTimezone);
```

Replace the `max` attribute on the date input (line ~301):

```tsx
                                    max={new Date().toISOString().split('T')[0]}
```

with:

```tsx
                                    max={todayDateStrInTimeZone(siteTimezone)}
```

- [ ] **Step 6: Run suite + lint**

Run: `npm test -- --run` then `npm run lint`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add cmd/next-app/src/lib/format-utils.ts cmd/next-app/src/lib/format-utils.test.ts cmd/next-app/src/components/LoadAnalysisClientPage.tsx
git commit -m "fix(load-analysis): compute today in the site timezone, not UTC

The date fallback and picker max used the UTC date, allowing an empty
'tomorrow' west of UTC and blocking the current day east of UTC."
```

---

### Task 6: `billing-cycle.ts` — correct the misleading overflow comment

**Why:** The doc comment says short months are handled "via Temporal Date overflow — no clamping", but `Temporal.PlainDate.from({...})` defaults to `overflow: 'constrain'`, which **clamps** (Feb 31 → Feb 28). The behavior is correct for billing; only the comment is wrong.

**Files:**
- Modify: `cmd/next-app/src/lib/billing-cycle.ts` (lines 14-15)

- [ ] **Step 1: Fix the comment**

In `cmd/next-app/src/lib/billing-cycle.ts`, replace:

```ts
 * Short-month behavior (e.g. billingStartDay=31 in February) is preserved
 * via Temporal Date overflow — no clamping.
 */
```

with:

```ts
 * Short-month behavior (e.g. billingStartDay=31 in February) relies on
 * Temporal.PlainDate.from's default overflow: 'constrain', which clamps the
 * day to the month's last day (Feb 31 → Feb 28/29) — the desired billing
 * semantics for cycles anchored past a month's end.
 */
```

- [ ] **Step 2: Verify nothing broke**

Run: `npm test -- src/lib/billing-cycle --run`
Expected: PASS (comment-only change).

- [ ] **Step 3: Commit**

```bash
git add cmd/next-app/src/lib/billing-cycle.ts
git commit -m "docs(billing-cycle): comment claimed no clamping; Temporal constrain clamps (and that is intended)"
```

---

### Task 7: Final verification

- [ ] **Step 1: Full test suite**

Run (from `cmd/next-app/`): `npm test -- --run`
Expected: all test files pass (baseline was 64 files / 516 tests; this plan adds 7 tests).

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 3: Production build**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 4: Review the diff**

Run: `git diff main --stat` and skim `git log --oneline` for the six commits from Tasks 1-6. Confirm no stray files (scratch, `.next`, etc.) are staged.

Do **not** push — per user preference, pushing happens only when explicitly requested.

---

## Out of scope (deliberately)

- **`throttled`-with-no-cache → 500** on `/api/site-live-data`: only occurs with a completely cold cache (fresh DB); Task 1 removes the common trigger. Revisit if it shows up in logs.
- **Saturday-observed holiday rules** in `schedule.ts`: already tracked in `docs/superpowers/plans/2026-07-03-observed-holiday-rules.md`.
- **Historical daily-aggregate rows already stored with gross-import-only grid values** (pre-Task-3 data): a backfill/re-import would be needed to correct old rows; not attempted here.
