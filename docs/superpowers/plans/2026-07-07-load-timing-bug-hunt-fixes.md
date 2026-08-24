# Load-Timing / Battery-Hold Bug Hunt Fixes (2026-07-07) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the four confirmed bugs and one latent inconsistency found in the 2026-07-07 recommendation/analytics-layer bug hunt: schedule transitions misreported (or missed entirely) for minute-granularity tariffs, a bogus "$0.00 cheaper period" for season-level-rate tariffs, "tomorrow" mis-rendered across a DST fall-back day, a user's explicit battery-park reserve choice silently discarded on SoC drift, and inconsistent null-TOU-name fallbacks that break active-period highlighting.

**Architecture:** All fixes are surgical changes to existing modules; the only structural change is a minute-precision transition walker (15-minute stepping + binary refinement) replacing the hour-snap walker in `next-cheaper-period.ts`, plus one new shared one-line helper `touDisplayName` in `schedule.ts`. Every task is TDD: extend the module's co-located Vitest suite with a failing test, make it pass, commit.

**Tech Stack:** Next.js app in `cmd/next-app`, Vitest, TypeScript. All npm commands run from `cmd/next-app/`; git commands run from the repo root without a leading `cd` (use `git -C /Users/kevm/github/pwusage` if needed).

---

## Context for a zero-context engineer

- **How TOU resolution works:** `src/lib/schedule.ts` `Schedule.getTariffPeriod(Date)` converts a UTC instant to site-local components (memoized per minute — *minute*-level TOU boundaries are supported and real: Tesla tariff JSON carries `fromMinute`/`toMinute`, persisted by `src/lib/importer/tariff-parser.ts`). It walks `Tariff → TariffSeason → TariffSchedule` to the matching rate window. The returned `TariffPeriod.start`/`.end` are **stamped with the query time**, not the true period boundaries — that's why the walker in `next-cheaper-period.ts` detects transitions by comparing `schedule.id` between samples.
- **The bug being fixed in Task 1 (confirmed by probe):** `walkScheduleTransitions` samples hourly and snaps the detected transition to the enclosing local hour start. For a tariff whose On-Peak starts 16:30, the reported start is 16:00 or 17:00 depending on the current wall-clock minute, and a 17:00–17:30 window is never sampled at all. Confirmed: with `now` at 14:45 local, a 16:30 boundary was reported as 16:00 (tells the user peak pricing starts 30 minutes early); with `now` at 14:15 it was reported as 17:00; a 30-minute Super-Peak window produced zero transitions.
- **The bug being fixed in Task 2 (confirmed):** `TariffSchedule.buy_rate`/`sell_rate` are `number | null` (`src/lib/db-types.ts:61-62`); rates can live at the season level (the ScheduleEditor path — `load-timing.ts` already defends with `s.buy_rate ?? active.season.buy_rate ?? 0`). But `findNextCheaperPeriod` prices a future transition as `t.schedule.buy_rate ?? 0`, so a flat season-rate tariff reported "On-Peak cheaper at $0.00".
- **The bug being fixed in Task 3 (confirmed):** `formatRelativeStart` computes "tomorrow" as `now + 24h`. On a 25-hour DST fall-back day (America/Chicago Nov 1 2026), `now + 24h` is still the same local day, so a start on Nov 2 rendered as "Monday at 6 AM" instead of "tomorrow at 6 AM".
- **The bug being fixed in Task 4:** `parkBattery` (`src/lib/battery-hold-service.ts`) recomputes `planReserve(soc)` from a *fresh* SoC read at submit time. If the user was prompted (SoC in the ambiguous 85–95 band), picked 80 or 100, and SoC drifted out of the band before the confirm landed (e.g. 94.8 → 95.2), the explicit choice is silently discarded and the drifted plan's target is sent instead.
- **The inconsistency fixed in Task 5:** null/empty TOU schedule names resolve to `'Standard'` in `energy-repo.ts` and `tou-aggregation.ts`, but to `'Unknown'` (via `?? 'Unknown'`) in `src/app/site/[id]/live/page.tsx` and `src/app/api/trmnl/markup/route.ts`. A null-named schedule would make the active period never match its cycle group (no highlight, `activeIsCheapest` always false). All Tesla-parsed schedules are named, so this is latent — but it's a one-line helper to make it impossible.
- **Weekday/DST facts used by tests** (verify with the node one-liners given in the tasks): Mar 16 2026 is a Monday; America/Los_Angeles is PDT (UTC-7) on that date. America/Chicago falls back Sun Nov 1 2026 (02:00 CDT → 01:00 CST; CDT=UTC-5, CST=UTC-6), making Nov 1 a 25-hour local day. America/Chicago springs forward Sun Mar 8 2026.
- **Triage protocol:** if a step's "Expected" outcome doesn't materialize, stop and invoke `superpowers:systematic-debugging`. Never bend a test expectation to match broken behavior.
- **Ground rules:** do NOT `git push` — the user pushes. `npm run lint`, `npm run build`, and `npm test` must all pass before finishing. Pure unit-test work; never run scripts against the `.env` `DATABASE_URL`.

## Findings documented but deliberately NOT changed

List these in the results doc (Task 6) as confirmed-and-left-alone; do not fix them here:

1. **Double-park compensating-restore race** (`battery-hold-service.ts` `parkBattery`): two concurrent park requests both pass the `getActiveHold` check; the loser hits the `battery_hold_one_active_per_site` unique index on insert and "compensates" by restoring the reserve it read at start — undoing the winner's freshly-set hold reserve while the winner's hold row stays active. Fixing needs the cross-instance claim pattern (see `DesignDecisions.md`); the window is two clicks within ~1s.
2. **Walker never re-yields the same schedule after a coverage gap** (`next-cheaper-period.ts`): if a tariff has hours matched by *no* schedule, a period that ends, gaps, and resumes is not reported as a new start (`schedule.id` equals `prevScheduleId`). Only affects hand-built tariffs with coverage gaps; Tesla tariffs cover all hours.
3. **Windows shorter than 15 minutes** remain undetectable after Task 1 (walk step = 15 min). Tesla minute boundaries are 15-minute-aligned; nothing in the ingest path can produce a sub-15-minute window.
4. **`getUsageByTOU` aggregation key** (`energy-repo.ts` cost loop): `key.split('|')` mis-parses rates if a tariff or TOU name ever contains `|`. No such names exist; flag only.
5. **`computeLoadTiming` internal mixed fallbacks** (`load-timing.ts`): groups key by `u.touName ?? 'Unknown'` but the season filter uses `u.touName || 'Standard'`. Harmless today because `energy-repo` always provides a normalized `touName`; not worth churning the module for.
6. **TRMNL markup route uses `new Date()` for `currentPeriod` but `now` for `computeLoadTiming`** — sub-second skew, harmless.

## File Structure

- Modify: `cmd/next-app/src/lib/next-cheaper-period.ts` — minute-precision walker (Task 1), season-rate fallback (Task 2), DST-safe "tomorrow" (Task 3)
- Modify: `cmd/next-app/src/lib/next-cheaper-period.test.ts` — Tasks 1–3 tests
- Modify: `cmd/next-app/src/lib/load-timing.ts` — drop obsolete timeZone args (Task 1 refactor step)
- Modify: `cmd/next-app/src/lib/battery-hold-service.ts` — honor explicit reserve choice (Task 4)
- Modify: `cmd/next-app/src/lib/battery-hold-service.test.ts` — Task 4 tests
- Modify: `cmd/next-app/src/lib/schedule.ts` — add `touDisplayName` helper (Task 5)
- Modify: `cmd/next-app/src/lib/schedule.test.ts` — Task 5 helper test
- Modify: `cmd/next-app/src/lib/energy-repo.ts`, `cmd/next-app/src/lib/tou-aggregation.ts`, `cmd/next-app/src/app/site/[id]/live/page.tsx`, `cmd/next-app/src/app/api/trmnl/markup/route.ts` — use the helper (Task 5)
- Create: `docs/superpowers/plans/2026-07-07-load-timing-bug-hunt-RESULTS.md` — outcome log (Task 6)

---

### Task 0: Housekeeping + branch setup

- [ ] **Step 1: Commit the previous hunt's untracked plan doc to its own branch**

The prior session committed its RESULTS doc but left the plan doc untracked. Tidy that up on the branch it belongs to (we are currently on `fix/time-money-adversarial-tests`):

```bash
git -C /Users/kevm/github/pwusage add docs/superpowers/plans/2026-07-07-adversarial-time-money-tests.md
git -C /Users/kevm/github/pwusage commit -m "docs: track the adversarial time/money test-hunt plan"
```

- [ ] **Step 2: Create the working branch from main**

```bash
git -C /Users/kevm/github/pwusage checkout main
git -C /Users/kevm/github/pwusage checkout -b fix/load-timing-bug-hunt
```

Note: this plan file itself is untracked and will follow the checkout; it gets committed in Task 6.

- [ ] **Step 3: Confirm the suite is green before starting**

Run (from `cmd/next-app`): `npm test`
Expected: all tests pass. If not, stop and report — do not build on a red base.

---

### Task 1: Minute-precision schedule transitions (confirmed real bug)

**Files:**
- Modify: `cmd/next-app/src/lib/next-cheaper-period.ts` (replace `snapToLocalHourStart` + `walkScheduleTransitions`, lines ~28–84)
- Modify: `cmd/next-app/src/lib/load-timing.ts` (two call sites, refactor step)
- Test: `cmd/next-app/src/lib/next-cheaper-period.test.ts`

- [ ] **Step 1: Verify the date facts**

```bash
node -e "console.log(new Date('2026-03-16T12:00:00Z').getUTCDay()); console.log(new Intl.DateTimeFormat('en-US',{timeZone:'America/Los_Angeles',hour:'numeric',hour12:false}).format(new Date('2026-03-16T21:45:00Z')))"
```
Expected output: `1` (Monday) then `14` (14:45 PDT — UTC-7 confirmed).

- [ ] **Step 2: Write the failing tests**

Append to `next-cheaper-period.test.ts` (module-scope helpers `makeUsage` and the `Tariff`/`Schedule` imports already exist in the file):

```ts
describe('walker with minute-granularity boundaries (real Schedule)', () => {
    // On-Peak starts on the half hour — 16:30–21:00 daily. The old hourly
    // walker snapped the reported start to the enclosing hour of whichever
    // cursor detected the change, so the same boundary was reported as 16:00
    // or 17:00 depending on the current wall-clock minute.
    function buildHalfHourTariff(): Tariff {
        return {
            id: 2, site_id: 'site-2', updated: new Date(), name: 'Half-Hour',
            seasons: [{
                id: 21, tariff_id: 2, name: 'All Year',
                from_month: 1, from_day: 1, to_month: 12, to_day: 31,
                buy_rate: 0, sell_rate: 0,
                schedules: [
                    { id: 210, season_id: 21, name: 'On-Peak', buy_rate: 0.45, sell_rate: 0.04,
                        from_day_of_week: 0, to_day_of_week: 6,
                        from_hour: 16, from_minute: 30, to_hour: 21, to_minute: 0 },
                    { id: 220, season_id: 21, name: 'Off-Peak', buy_rate: 0.10, sell_rate: 0.04,
                        from_day_of_week: 0, to_day_of_week: 6,
                        from_hour: null, from_minute: null, to_hour: null, to_minute: null }
                ]
            }]
        };
    }

    const halfHourCycle: UsageData[] = [
        makeUsage('On-Peak', 0.45, 0.04, 200_000),
        makeUsage('Off-Peak', 0.10, 0.04, 500_000)
    ];

    it('reports a 16:30 boundary exactly when the old walker snapped early', () => {
        const schedule = new Schedule([buildHalfHourTariff()], 'America/Los_Angeles');
        // now = 14:45 PDT Mar 16 2026 (21:45 UTC): hourly cursors landed at
        // 16:45 and snapped to 16:00 — half an hour before On-Peak begins.
        const now = new Date(Date.UTC(2026, 2, 16, 21, 45, 0));
        const starts = findNextStartsByKey(schedule, now, halfHourCycle, 'America/Los_Angeles', 24);
        // True boundary: 16:30 PDT = 23:30 UTC.
        expect(starts.get(periodKey('On-Peak'))).toEqual(new Date(Date.UTC(2026, 2, 16, 23, 30, 0)));
    });

    it('reports a 16:30 boundary exactly when the old walker snapped late', () => {
        const schedule = new Schedule([buildHalfHourTariff()], 'America/Los_Angeles');
        // now = 14:15 PDT: hourly cursors landed at 17:15 and snapped to 17:00.
        const now = new Date(Date.UTC(2026, 2, 16, 21, 15, 0));
        const starts = findNextStartsByKey(schedule, now, halfHourCycle, 'America/Los_Angeles', 24);
        expect(starts.get(periodKey('On-Peak'))).toEqual(new Date(Date.UTC(2026, 2, 16, 23, 30, 0)));
    });

    it('detects a 30-minute period the hourly walker skipped entirely', () => {
        const superPeakTariff: Tariff = {
            id: 4, site_id: 'site-4', updated: new Date(), name: 'Super',
            seasons: [{
                id: 41, tariff_id: 4, name: 'All Year',
                from_month: 1, from_day: 1, to_month: 12, to_day: 31,
                buy_rate: 0, sell_rate: 0,
                schedules: [
                    { id: 410, season_id: 41, name: 'Super-Peak', buy_rate: 0.60, sell_rate: 0.04,
                        from_day_of_week: 0, to_day_of_week: 6,
                        from_hour: 17, from_minute: 0, to_hour: 17, to_minute: 30 },
                    { id: 420, season_id: 41, name: 'Off-Peak', buy_rate: 0.10, sell_rate: 0.04,
                        from_day_of_week: 0, to_day_of_week: 6,
                        from_hour: null, from_minute: null, to_hour: null, to_minute: null }
                ]
            }]
        };
        const schedule = new Schedule([superPeakTariff], 'America/Los_Angeles');
        const now = new Date(Date.UTC(2026, 2, 16, 21, 45, 0)); // 14:45 PDT
        const cycle: UsageData[] = [
            makeUsage('Super-Peak', 0.60, 0.04, 100_000),
            makeUsage('Off-Peak', 0.10, 0.04, 500_000)
        ];
        const starts = findNextStartsByKey(schedule, now, cycle, 'America/Los_Angeles', 24);
        // 17:00 PDT Mar 16 = 00:00 UTC Mar 17.
        expect(starts.get(periodKey('Super-Peak'))).toEqual(new Date(Date.UTC(2026, 2, 17, 0, 0, 0)));
    });
});
```

- [ ] **Step 3: Run and verify all three fail**

Run: `npm test -- src/lib/next-cheaper-period --run`
Expected failures: test 1 receives `2026-03-16T23:00:00Z` (16:00 snap), test 2 receives `2026-03-17T00:00:00Z` (17:00 snap), test 3 receives `undefined`. All pre-existing tests pass.

- [ ] **Step 4: Replace the walker**

In `next-cheaper-period.ts`, delete everything from `const HOUR_MS = 60 * 60 * 1000;` through the end of the `walkScheduleTransitions` function (i.e. the `HOUR_MS` constant, the whole `snapToLocalHourStart` function and its doc comment, the `ScheduleTransition` interface, and the whole `walkScheduleTransitions` function and its doc comment), and replace with:

```ts
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
// Tesla TOU boundaries land on 15-minute marks (from_minute/to_minute in the
// tariff JSON), so a 15-minute walk step samples every representable window
// at least once and never skips a sub-hour period.
const WALK_STEP_MS = 15 * 60 * 1000;

export interface ScheduleTransition {
    /** Exact instant the new period starts matching (minute precision). */
    start: Date;
    schedule: TariffSchedule;
    period: TariffPeriod;
}

/**
 * Binary-search the exact minute a transition happened. Invariants: the
 * schedule matching at `beforeMs` is not `newScheduleId`, the one at
 * `afterMs` is. Schedule matching has minute granularity, so the flip lands
 * exactly on a minute boundary.
 */
function refineTransitionStart(
    schedule: Schedule,
    beforeMs: number,
    afterMs: number,
    newScheduleId: number
): Date {
    let lo = Math.floor(beforeMs / MINUTE_MS);
    let hi = Math.floor(afterMs / MINUTE_MS);
    while (hi - lo > 1) {
        const mid = lo + Math.floor((hi - lo) / 2);
        const tp = schedule.getTariffPeriod(new Date(mid * MINUTE_MS));
        if (tp?.schedule.id === newScheduleId) {
            hi = mid;
        } else {
            lo = mid;
        }
    }
    return new Date(hi * MINUTE_MS);
}

/**
 * Yield each schedule transition occurring strictly after `now`, walking in
 * 15-minute steps up to the horizon. We don't trust `tp.start` / `tp.end`
 * from Schedule.getTariffPeriod — it stamps both with the query time rather
 * than the period boundaries — so transitions are detected by comparing
 * `schedule.id` against the previous sample, then refined to the exact
 * boundary minute.
 */
export function* walkScheduleTransitions(
    schedule: Schedule,
    now: Date,
    maxHorizonHours: number
): Generator<ScheduleTransition> {
    const active = schedule.getTariffPeriod(now);
    if (!active) return;

    let prevScheduleId = active.schedule.id;
    let prevMatchedMs = now.getTime();
    const horizonMs = maxHorizonHours * HOUR_MS;
    for (let elapsed = WALK_STEP_MS; elapsed <= horizonMs; elapsed += WALK_STEP_MS) {
        const cursor = new Date(now.getTime() + elapsed);
        const tp = schedule.getTariffPeriod(cursor);
        if (!tp) continue;
        if (tp.schedule.id === prevScheduleId) {
            prevMatchedMs = cursor.getTime();
            continue;
        }
        yield {
            start: refineTransitionStart(schedule, prevMatchedMs, cursor.getTime(), tp.schedule.id),
            schedule: tp.schedule,
            period: tp
        };
        prevScheduleId = tp.schedule.id;
        prevMatchedMs = cursor.getTime();
    }
}
```

Performance note (no action needed): the 7-day default horizon of `findNextStartsByKey` is now 672 samples plus ~11 refinement lookups per transition, all against the per-minute-memoized `Schedule` — single-digit milliseconds.

- [ ] **Step 5: Drop the now-unused timeZone parameters and update call sites**

`walkScheduleTransitions` no longer uses `timeZone` (it was only consumed by the deleted `snapToLocalHourStart`), and its two callers only passed it through. In `next-cheaper-period.ts`:

- `findNextCheaperPeriod`: signature becomes
  ```ts
  export function findNextCheaperPeriod(
      schedule: Schedule,
      now: Date,
      cycle: UsageData[],
      maxHorizonHours: number = 48
  ): CheaperPeriod | null {
  ```
  and its walker call becomes `walkScheduleTransitions(schedule, now, maxHorizonHours)`.
- `findNextStartsByKey`: signature becomes
  ```ts
  export function findNextStartsByKey(
      schedule: Schedule,
      now: Date,
      cycle: UsageData[],
      maxHorizonHours: number = 24 * 7
  ): Map<string, Date> {
  ```
  and its walker call becomes `walkScheduleTransitions(schedule, now, maxHorizonHours)`.

(`formatRelativeStart` keeps its `timeZone` parameter — it still formats local wall-clock times.)

In `load-timing.ts` update the two call sites:
- `findNextCheaperPeriod(schedule, now, groupedCycle, timezone)` → `findNextCheaperPeriod(schedule, now, groupedCycle)`
- `findNextStartsByKey(schedule, now, groupedCycle, timezone)` → `findNextStartsByKey(schedule, now, groupedCycle)`

In `next-cheaper-period.test.ts` remove the timezone argument everywhere:
- `findNextCheaperPeriod(schedule, t0, cycle, 'UTC', 48)` → `findNextCheaperPeriod(schedule, t0, cycle, 48)` (4 occurrences)
- `findNextStartsByKey(schedule, t0, cycle, 'UTC')` → `findNextStartsByKey(schedule, t0, cycle)` (3 occurrences, including the empty-map test)
- `findNextCheaperPeriod(schedule, now, cycle, 'America/Los_Angeles', 48)` → `findNextCheaperPeriod(schedule, now, cycle, 48)`
- `findNextStartsByKey(schedule, now, cycle, 'America/Los_Angeles')` → `findNextStartsByKey(schedule, now, cycle)`
- In the three tests added in Step 2: `findNextStartsByKey(schedule, now, halfHourCycle, 'America/Los_Angeles', 24)` → `findNextStartsByKey(schedule, now, halfHourCycle, 24)` and `findNextStartsByKey(schedule, now, cycle, 'America/Los_Angeles', 24)` → `findNextStartsByKey(schedule, now, cycle, 24)`.

Also update the stale comment in the pre-existing test at the old line ~103 (`// Walker detects transition at the hour boundary when schedule.id changes.`) to `// Walker detects the schedule.id change and refines to the boundary minute.`

- [ ] **Step 6: Run the file — all pass**

Run: `npm test -- src/lib/next-cheaper-period --run`
Expected: PASS, including all pre-existing tests (hour-aligned boundaries refine to the same hour-start instants the snap used to produce) and the stub-schedule tests (the refinement is a pure function of `getTariffPeriod`, which the stub implements).

- [ ] **Step 7: Run the load-timing suite too (its callers changed)**

Run: `npm test -- src/lib/load-timing --run`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git -C /Users/kevm/github/pwusage add cmd/next-app/src/lib/next-cheaper-period.ts cmd/next-app/src/lib/next-cheaper-period.test.ts cmd/next-app/src/lib/load-timing.ts
git -C /Users/kevm/github/pwusage commit -m "fix(load-timing): report schedule transitions at minute precision"
```

---

### Task 2: Season-level rates priced as \$0 in findNextCheaperPeriod (confirmed real bug)

**Files:**
- Modify: `cmd/next-app/src/lib/next-cheaper-period.ts` (`findNextCheaperPeriod` transition-cost block)
- Test: `cmd/next-app/src/lib/next-cheaper-period.test.ts`

Depends on Task 1 (uses the timezone-free signatures).

- [ ] **Step 1: Write the failing test**

Append to `next-cheaper-period.test.ts`:

```ts
describe('findNextCheaperPeriod – season-level rates (null schedule rates)', () => {
    // The ScheduleEditor can store rates on the season with null schedule
    // rates. load-timing patches cycle rates with the season fallback, but the
    // transition cost used `t.schedule.buy_rate ?? 0` — pricing every future
    // period at $0 and reporting a bogus "cheaper period" on a flat tariff.
    function buildSeasonRateTariff(): Tariff {
        return {
            id: 3, site_id: 'site-3', updated: new Date(), name: 'Flat',
            seasons: [{
                id: 31, tariff_id: 3, name: 'All Year',
                from_month: 1, from_day: 1, to_month: 12, to_day: 31,
                buy_rate: 0.25, sell_rate: 0.04,
                schedules: [
                    { id: 310, season_id: 31, name: 'On-Peak', buy_rate: null, sell_rate: null,
                        from_day_of_week: 0, to_day_of_week: 6,
                        from_hour: 16, from_minute: 0, to_hour: 21, to_minute: 0 },
                    { id: 320, season_id: 31, name: 'Off-Peak', buy_rate: null, sell_rate: null,
                        from_day_of_week: 0, to_day_of_week: 6,
                        from_hour: null, from_minute: null, to_hour: null, to_minute: null }
                ]
            }]
        };
    }

    it('falls back to season rates instead of pricing transitions at $0', () => {
        const schedule = new Schedule([buildSeasonRateTariff()], 'America/Los_Angeles');
        const now = new Date(Date.UTC(2026, 2, 16, 17, 0, 0)); // 10:00 PDT, Off-Peak
        expect(schedule.getTariffPeriod(now)?.schedule.name).toBe('Off-Peak');
        // Cycle entries arrive with season-patched rates (computeLoadTiming
        // applies `s.buy_rate ?? season.buy_rate` before calling us).
        const cycle: UsageData[] = [
            makeUsage('Off-Peak', 0.25, 0.04, 500_000),
            makeUsage('On-Peak', 0.25, 0.04, 500_000)
        ];
        // Effectively a flat tariff: nothing is cheaper than the active 0.25.
        expect(findNextCheaperPeriod(schedule, now, cycle, 48)).toBeNull();
    });
});
```

- [ ] **Step 2: Run and verify it fails**

Run: `npm test -- src/lib/next-cheaper-period --run`
Expected: the new test FAILS — received an object like `{ name: 'On-Peak', marginalCost: 0, basis: 'buy' }` instead of `null`.

- [ ] **Step 3: Fix — season fallback for transition rates**

In `findNextCheaperPeriod`, replace:

```ts
            // Future marginal cost based on the transition's own rates
            const buyRate = t.schedule.buy_rate ?? 0;
            const sellRate = t.schedule.sell_rate ?? 0;
```

with:

```ts
            // Future marginal cost from the transition's own rates. Schedules
            // saved via the editor may carry rates at the season level only —
            // mirror computeLoadTiming's season fallback.
            const buyRate = t.schedule.buy_rate ?? t.period.season.buy_rate ?? 0;
            const sellRate = t.schedule.sell_rate ?? t.period.season.sell_rate ?? 0;
```

- [ ] **Step 4: Run the file — all pass**

Run: `npm test -- src/lib/next-cheaper-period --run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C /Users/kevm/github/pwusage add cmd/next-app/src/lib/next-cheaper-period.ts cmd/next-app/src/lib/next-cheaper-period.test.ts
git -C /Users/kevm/github/pwusage commit -m "fix(load-timing): fall back to season rates when schedule rates are null"
```

---

### Task 3: "tomorrow" across a 25-hour DST day (confirmed real bug)

**Files:**
- Modify: `cmd/next-app/src/lib/next-cheaper-period.ts` (`formatRelativeStart`)
- Test: `cmd/next-app/src/lib/next-cheaper-period.test.ts`

- [ ] **Step 1: Verify the DST fact**

```bash
node -e "const f=(d)=>new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',month:'2-digit',day:'2-digit',hour:'numeric',hour12:false}).format(new Date(d)); console.log(f('2026-11-01T05:30:00Z'), '|', f('2026-11-02T05:30:00Z'))"
```
Expected output: `11/01, 0 | 11/01, 23` — i.e. Nov 1 05:30Z is 00:30 CDT, and 24 hours later it is *still Nov 1* locally (23:30 CST). That is the bug's mechanism.

- [ ] **Step 2: Write the failing test**

Append inside the existing `describe('formatRelativeStart', ...)` block:

```ts
    it('renders next-day starts as "tomorrow" across a 25-hour DST fall-back day', () => {
        // America/Chicago Nov 1 2026 is 25 hours long (CDT→CST). now + 24h is
        // still Nov 1 locally, so tomorrow-detection via now+24h failed and a
        // Nov 2 start rendered as "Monday at 6 AM".
        const now = new Date(Date.UTC(2026, 10, 1, 5, 30, 0));   // Nov 1 00:30 CDT
        const start = new Date(Date.UTC(2026, 10, 2, 12, 0, 0)); // Nov 2 06:00 CST
        expect(formatRelativeStart(start, now, 'America/Chicago')).toBe('tomorrow at 6 AM');
    });
```

- [ ] **Step 3: Run and verify it fails**

Run: `npm test -- src/lib/next-cheaper-period --run`
Expected: FAIL — received `'Monday at 6 AM'`.

- [ ] **Step 4: Fix — calendar arithmetic instead of now + 24h**

In `formatRelativeStart`, replace:

```ts
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const tomorrowKey = dayKey(tomorrow);
```

with:

```ts
    // Tomorrow's calendar date via date arithmetic on the local Y/M/D — not
    // now + 24h, which is still the same local day when DST fall-back makes
    // the day 25 hours long.
    const [nowMonth, nowDay, nowYear] = nowKey.split('/').map(Number);
    const tomorrowKey = new Intl.DateTimeFormat('en-US', {
        timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date(Date.UTC(nowYear, nowMonth - 1, nowDay + 1)));
```

(`dayKey` produces `MM/DD/YYYY`; the replacement formats a pure-calendar "next day" with identical options in UTC so the strings compare exactly. `Date.UTC` handles month/year rollover.)

- [ ] **Step 5: Run the file — all pass**

Run: `npm test -- src/lib/next-cheaper-period --run`
Expected: PASS, including the four pre-existing `formatRelativeStart` tests.

- [ ] **Step 6: Commit**

```bash
git -C /Users/kevm/github/pwusage add cmd/next-app/src/lib/next-cheaper-period.ts cmd/next-app/src/lib/next-cheaper-period.test.ts
git -C /Users/kevm/github/pwusage commit -m "fix(load-timing): detect tomorrow by calendar date across 25-hour DST days"
```

---

### Task 4: parkBattery silently discards an explicit reserve choice on SoC drift

**Files:**
- Modify: `cmd/next-app/src/lib/battery-hold-service.ts` (target-selection block, lines ~57–64)
- Test: `cmd/next-app/src/lib/battery-hold-service.test.ts`

- [ ] **Step 1: Write the failing tests**

Add inside the existing `describe('parkBattery', ...)` block (the `fakeRepo`/`fakeClient` helpers already exist at the top of the file):

```ts
  it('honors an explicit 80 choice when SoC drifted above the ambiguous band before submit', async () => {
    // User was prompted at SoC ~94, picked 80; by the time the confirm lands
    // SoC is 95.3 (no longer ambiguous). The choice must win — recomputing
    // from the drifted SoC would silently hold at 100 instead.
    const repo = fakeRepo(null);
    const client = fakeClient({ getLiveStatus: vi.fn().mockResolvedValue({ percentage_charged: 95.3, load_power: 450 }) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await parkBattery({ client: client as any, repo: repo as any, siteId: 's', mode: 'auto', reserveChoice: 80 });
    expect(res.status).toBe('ok');
    expect(client.setBackupReserve).toHaveBeenCalledWith('s', 80);
  });

  it('honors an explicit 100 choice when SoC drifted below the ambiguous band before submit', async () => {
    const repo = fakeRepo(null);
    const client = fakeClient({ getLiveStatus: vi.fn().mockResolvedValue({ percentage_charged: 84.6, load_power: 450 }) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await parkBattery({ client: client as any, repo: repo as any, siteId: 's', mode: 'auto', reserveChoice: 100 });
    expect(res.status).toBe('ok');
    expect(client.setBackupReserve).toHaveBeenCalledWith('s', 100);
  });

  it('ignores a stale choice at or below 80 and floors to current SoC', async () => {
    // A choice only exists because the ambiguous band offered one; at SoC 70
    // honoring a stale 100 would grid-charge the battery 30%. Keep the floor.
    const repo = fakeRepo(null);
    const client = fakeClient({ getLiveStatus: vi.fn().mockResolvedValue({ percentage_charged: 70, load_power: 450 }) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await parkBattery({ client: client as any, repo: repo as any, siteId: 's', mode: 'auto', reserveChoice: 100 });
    expect(res.status).toBe('ok');
    expect(client.setBackupReserve).toHaveBeenCalledWith('s', 70);
  });
```

- [ ] **Step 2: Run and verify the first two fail**

Run: `npm test -- src/lib/battery-hold-service --run`
Expected: test 1 FAILS (`setBackupReserve` called with 100 — SoC 95.3 snaps to 100, choice discarded), test 2 FAILS (called with 80 — SoC 84.6 snaps to 80), test 3 PASSES (pins existing behavior the fix must not change). All pre-existing tests pass.

- [ ] **Step 3: Fix — honor an explicit choice anywhere above the clamp floor**

In `battery-hold-service.ts`, replace:

```ts
  const plan = planReserve(soc);
  let target: number;
  if (plan.ambiguous) {
    if (reserveChoice !== 80 && reserveChoice !== 100) return { status: 'needs_choice', options: plan.options! };
    target = reserveChoice;
  } else {
    target = plan.target;
  }
```

with:

```ts
  const plan = planReserve(soc);
  let target: number;
  if ((reserveChoice === 80 || reserveChoice === 100) && soc > 80) {
    // Honor an explicit choice anywhere above the clamp floor: SoC can drift
    // out of the 85–95 ambiguous band between the prompt and the confirm,
    // and recomputing from the drifted SoC would silently override what the
    // user picked. At or below 80 a choice can only be stale — ignore it.
    target = reserveChoice;
  } else if (plan.ambiguous) {
    return { status: 'needs_choice', options: plan.options! };
  } else {
    target = plan.target;
  }
```

- [ ] **Step 4: Run the file — all pass**

Run: `npm test -- src/lib/battery-hold-service --run`
Expected: PASS, including the pre-existing "parks at an explicit 100 choice in the ambiguous band" (SoC 90, unchanged path) and "returns needs_choice" tests.

- [ ] **Step 5: Commit**

```bash
git -C /Users/kevm/github/pwusage add cmd/next-app/src/lib/battery-hold-service.ts cmd/next-app/src/lib/battery-hold-service.test.ts
git -C /Users/kevm/github/pwusage commit -m "fix(battery-hold): honor explicit reserve choice when SoC drifts out of the ambiguous band"
```

---

### Task 5: Unify null-TOU-name fallbacks via touDisplayName

**Files:**
- Modify: `cmd/next-app/src/lib/schedule.ts` (add helper after `getCurrentTariffLabel`)
- Modify: `cmd/next-app/src/lib/energy-repo.ts` (3 fallback sites)
- Modify: `cmd/next-app/src/lib/tou-aggregation.ts` (`getTouLabel` + 3 fallback sites)
- Modify: `cmd/next-app/src/app/site/[id]/live/page.tsx` (activePeriod name)
- Modify: `cmd/next-app/src/app/api/trmnl/markup/route.ts` (currentTouName + loadTimingActive name)
- Test: `cmd/next-app/src/lib/schedule.test.ts`

Every replacement is value-identical for named schedules; the behavior change is only for null/empty names, where the page-level `?? 'Unknown'` used to disagree with the repo-level `|| 'Standard'` and break active-period matching.

- [ ] **Step 1: Write the failing test**

Append to `schedule.test.ts` (add `touDisplayName` to the file's existing `./schedule` import):

```ts
describe('touDisplayName', () => {
    it('falls back to Standard for null/undefined/empty and passes real names through', () => {
        expect(touDisplayName(null)).toBe('Standard');
        expect(touDisplayName(undefined)).toBe('Standard');
        expect(touDisplayName('')).toBe('Standard');
        expect(touDisplayName('ON_PEAK')).toBe('ON_PEAK');
    });
});
```

- [ ] **Step 2: Run and verify it fails to import**

Run: `npm test -- src/lib/schedule --run`
Expected: FAIL — `touDisplayName` is not exported.

- [ ] **Step 3: Add the helper**

Append to `schedule.ts` (after `getCurrentTariffLabel`):

```ts
/**
 * Canonical label for a TOU schedule name. Null/empty names must resolve
 * identically everywhere they are compared — energy-repo aggregation keys,
 * tou-aggregation groups, the live page's active period, and TRMNL
 * highlighting — or the active period silently fails to match its cycle
 * group and never renders as active.
 */
export function touDisplayName(name: string | null | undefined): string {
    return name || 'Standard';
}
```

- [ ] **Step 4: Run — helper test passes**

Run: `npm test -- src/lib/schedule --run`
Expected: PASS.

- [ ] **Step 5: Use the helper at every fallback site**

All are mechanical replacements; add the import where missing.

`energy-repo.ts` (already imports from `'./schedule'` — add `touDisplayName` to that import):
- `touName = sched.name || 'Standard';` → `touName = touDisplayName(sched.name);`
- `touName = tp.schedule.name || 'Standard';` (two occurrences, pass 1 midpoint fallback and pass 2) → `touName = touDisplayName(tp.schedule.name);`

`tou-aggregation.ts` (already imports from `'./schedule'` — add `touDisplayName`):
- In `getTouLabel`: `return (name || 'Standard')` → `return touDisplayName(name)`
- `touName = sched.name || 'Standard';` → `touName = touDisplayName(sched.name);`
- `touName = tp.schedule.name || 'Standard';` (two occurrences) → `touName = touDisplayName(tp.schedule.name);`

`src/app/site/[id]/live/page.tsx` (change the import `import { Schedule } from '@/lib/schedule';` to `import { Schedule, touDisplayName } from '@/lib/schedule';`):
- `name: tp.schedule.name ?? 'Unknown',` → `name: touDisplayName(tp.schedule.name),`

`src/app/api/trmnl/markup/route.ts` (change `import { Schedule } from '@/lib/schedule';` to `import { Schedule, touDisplayName } from '@/lib/schedule';`):
- `const currentTouName = currentPeriod?.schedule.name;` → `const currentTouName = currentPeriod ? touDisplayName(currentPeriod.schedule.name) : undefined;`
- In `loadTimingActive`: `name: currentPeriod.schedule.name ?? 'Unknown',` → `name: touDisplayName(currentPeriod.schedule.name),`
- In the render context: `currentTouName: currentTouName || undefined,` → `currentTouName,`

- [ ] **Step 6: Run the affected suites + lint + build**

Run: `npm test -- src/lib/schedule src/lib/energy-repo src/lib/tou-aggregation src/lib/trmnl --run`
Expected: PASS (all replacements are value-identical for named schedules; `render-full.test.ts` uses `'OFF_PEAK'` which passes through unchanged).
Run: `npm run lint` — expected clean (page/route files have no unit tests; lint+build are their gate).

- [ ] **Step 7: Commit**

```bash
git -C /Users/kevm/github/pwusage add cmd/next-app/src/lib/schedule.ts cmd/next-app/src/lib/schedule.test.ts cmd/next-app/src/lib/energy-repo.ts cmd/next-app/src/lib/tou-aggregation.ts "cmd/next-app/src/app/site/[id]/live/page.tsx" cmd/next-app/src/app/api/trmnl/markup/route.ts
git -C /Users/kevm/github/pwusage commit -m "refactor(tou): unify null schedule-name fallback via touDisplayName"
```

---

### Task 6: Full verification + results log

**Files:**
- Create: `docs/superpowers/plans/2026-07-07-load-timing-bug-hunt-RESULTS.md`

- [ ] **Step 1: Run the full gate (from `cmd/next-app`)**

```bash
npm test
npm run lint
npm run build
```
Expected: all three pass. Fix anything they surface before proceeding.

- [ ] **Step 2: Write the results log**

Create `docs/superpowers/plans/2026-07-07-load-timing-bug-hunt-RESULTS.md`:

```markdown
# Load-Timing / Battery-Hold Bug Hunt — Results (2026-07-07)

## Hunt scope
Recommendation/analytics layer: next-cheaper-period, load-timing,
marginal-cost, battery-hold-*, soc-checkpoints, header-metrics,
period-card-display, plus the energy-repo cycle money path.
(Prior hunts covered: time/money date math on 2026-07-07, live-status /
TRMNL billing / importer on 2026-07-04, routes+auth in PRs #101/#102.)

## Bugs found and fixed
- walkScheduleTransitions hour-snap: [confirmed / outcome]
- findNextCheaperPeriod null-schedule-rate $0 transitions: [confirmed / outcome]
- formatRelativeStart 25-hour-day "tomorrow": [confirmed / outcome]
- parkBattery discarded explicit reserve choice on SoC drift: [confirmed / outcome]
- null-TOU-name fallback mismatch ('Unknown' vs 'Standard'): [latent; unified via touDisplayName]

## Known issues documented, deliberately not changed
[copy the 6-item list from the plan's "Findings documented but deliberately
NOT changed" section, noting anything new observed while executing]

## Modules audited with no defects found
battery-hold-detection (evaluateHold), battery-hold-rules (planReserve),
soc-checkpoints, header-metrics, live-indicators, period-card-display,
marginal-cost, energy-utils.
```

Fill in the actual outcomes.

- [ ] **Step 3: Commit (plan + results)**

```bash
git -C /Users/kevm/github/pwusage add docs/superpowers/plans/2026-07-07-load-timing-bug-hunt-fixes.md docs/superpowers/plans/2026-07-07-load-timing-bug-hunt-RESULTS.md
git -C /Users/kevm/github/pwusage commit -m "docs: record load-timing/battery-hold bug-hunt plan and results"
```

- [ ] **Step 4: Stop — do not push**

Report the branch name and a summary of confirmed bugs to the user. The user pushes and opens the PR.
