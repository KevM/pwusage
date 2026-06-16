# Schedule Editor — Phase A (Structures: Persistence, Validation & Pricing) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make comparison plans hold and price arbitrary TOU **schedules** (not just flat rates) — a pure coverage/canonicalization unit, repo methods to read/write/rename full structures, a route to drive them, and the grid generalized to price comparison columns from their real structure — all headless and fully tested. The authoring UI is Phase B.

**Architecture:** A schedule is `ParsedSeason[]` (the existing `tariff-parser` shape: seasons each with windows carrying day/hour ranges + buy/sell). A new pure unit (`tou-coverage.ts`) validates coverage and canonicalizes same-rate seasons. `ComparisonTariffRepo` gains `getPlanStructure` / `saveComparisonStructure` / `renameComparisonPlan` and a kind-aware listing; the route exposes them with a server-side coverage check; `plan-timeline.ts` builds comparison columns via the existing `scheduleTimeline` so TOU columns price date-resolved. **No DB migration** — `Tariff → TariffSeason → TariffSchedule` already store TOU structures.

**Tech Stack:** Next.js (App Router) route handlers, TypeScript, `pg` Pool, Vitest. Repo tests mock `../db` (`vi.hoisted` connect/query mocks) and assert on SQL strings + the `reporting_only` guard. Route tests mock `@/lib/auth-checks` + the repo class. The pure unit is tested directly (no mocks).

**Spec:** `docs/superpowers/specs/2026-06-16-schedule-editor-design.md` — this is the **structures/headless** half (decisions 1–9 minus the editor component). The `ScheduleEditor` and manager wiring are **Phase B**.

---

## Key facts grounding this plan (verified against the code)

- **A parsed schedule is `ParsedSeason[]`.** `ParsedSchedule` ([tariff-parser.ts:4](../../cmd/next-app/src/lib/importer/tariff-parser.ts)) has concrete (non-null) `from_day_of_week`/`to_day_of_week` (Tesla `0=Mon … 6=Sun`), `from_hour/from_minute/to_hour/to_minute`, and `buy_rate/sell_rate`. `ParsedSeason` adds `from_month/from_day/to_month/to_day` + its own `buy_rate/sell_rate`. The editor, repo, and coverage unit all speak `ParsedSeason[]`.
- **The resolver is most-specific-window-wins, gaps → `null`.** `Schedule.getTariffPeriodByComponents` ([schedule.ts:72](../../cmd/next-app/src/lib/schedule.ts)) sorts a season's schedules by narrower day-range first, then time-specific before all-day, returns the first match. An unmatched `(weekday, hour)` returns `null` → an unpriced hour. Coverage hunts gaps; overlaps are intentionally fine. `matchHourOfDay` treats `from_hour <= to_hour` as `[from, to)` and `from_hour > to_hour` as a midnight-crossing union.
- **`classifyTariff` is rate-based** ([classify-tariff.ts:5](../../cmd/next-app/src/lib/roi/classify-tariff.ts)): TOU iff resolved buy rates differ across schedules, else Fixed. The badge/kind reuses this rule (rate-variation, **not** window count).
- **The insert pattern to mirror** is `appendFixedComparison` ([comparison-tariff-repo.ts:151](../../cmd/next-app/src/lib/roi/comparison-tariff-repo.ts)): `BEGIN` → `SELECT 1 FROM "Site" … FOR UPDATE` → demote same-named current → `MAX(version)+1` → `INSERT "Tariff"(… reporting_only=true …)` → `INSERT "TariffSeason"` → `INSERT "TariffSchedule"` → `COMMIT`.
- **`TariffSeason → Tariff` and `TariffSchedule → TariffSeason` are `ON DELETE CASCADE`** — replacing a version's structure = delete its seasons (cascade drops schedules) then re-insert; the `Tariff` row stays.
- **The grid prices via `PlanTimeline`** ([plan-timeline.ts:8](../../cmd/next-app/src/lib/roi/plan-timeline.ts)). `meteredTimeline(tariffs, tz)` builds a date-resolved timeline from non-reporting Tariff versions via `scheduleTimeline`. `comparisonPlanTimeline(plan: ComparisonPlan)` ([plan-timeline.ts:73](../../cmd/next-app/src/lib/roi/plan-timeline.ts)) is **flat-only** — the bug decision 8 fixes.
- **The page builds grid columns** at [page.tsx:335](../../cmd/next-app/src/app/site/[id]/page.tsx): `{ name, type, isMetered, timeline }[]` → `buildExtendedGrid`. Comparison columns currently use the flat `comparisonPlanTimeline(p)`.
- **Full nested tariff structures load** via the `assembleFromRows` pattern in `site-repo.ts` ([site-repo.ts:120](../../cmd/next-app/src/lib/site-repo.ts)) — the model for a comparison-structure loader.

---

## File Structure

**Create:**
- `cmd/next-app/src/lib/roi/tou-coverage.ts` — pure unit: `canonicalizeSeasons`, `windowCoverage`, `seasonCalendarGaps`, `isFixedSchedule`.
- `cmd/next-app/src/lib/roi/tou-coverage.test.ts`.

**Modify:**
- `cmd/next-app/src/lib/roi/comparison-tariff-repo.ts` — add `getPlanStructure`, `listComparisonStructures`, `saveComparisonStructure`, `renameComparisonPlan`; extend `listFixedComparisons` rows with a `kind`; retire `appendFixedComparison` + rate-only `editComparisonVersion`.
- `cmd/next-app/src/lib/roi/comparison-tariff-repo.test.ts` — cover the new methods; drop the retired-method tests.
- `cmd/next-app/src/app/api/site/[id]/comparison-tariff/route.ts` — `GET`; `POST`/`PATCH` take a full `seasons[]` payload + server coverage check; `PATCH` rename intent.
- `cmd/next-app/src/app/api/site/[id]/comparison-tariff/route.test.ts` — cover the new shapes.
- `cmd/next-app/src/lib/roi/plan-timeline.ts` — generalize comparison pricing to `comparisonStructTimeline(tariffs, tz)`.
- `cmd/next-app/src/lib/roi/plan-timeline.test.ts` — TOU comparison pricing + Fixed regression.
- `cmd/next-app/src/app/site/[id]/page.tsx` — build comparison grid columns from full structures.

**Untouched (explicitly):** `schedule.ts` (resolver reused as-is), `extended-grid.ts`, `roi-service.ts`, `resolve-fixed-baseline.ts` (stays Fixed-oriented, per spec caveat), `tariff-repo.ts` (metered lineage). `fixed-comparison.ts`'s `buildFixedComparisonInput` stays as the Phase-B editor seed.

---

## Task 1: `tou-coverage.ts` — pure coverage + canonicalization

A pure unit over `ParsedSeason[]`, mirroring `schedule.ts` resolution semantics. No DB, no mocks.

**Files:**
- Create: `cmd/next-app/src/lib/roi/tou-coverage.ts`
- Test: `cmd/next-app/src/lib/roi/tou-coverage.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/roi/tou-coverage.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { canonicalizeSeasons, windowCoverage, seasonCalendarGaps, isFixedSchedule } from './tou-coverage';
import type { ParsedSeason, ParsedSchedule } from '../importer/tariff-parser';

function win(p: Partial<ParsedSchedule>): ParsedSchedule {
    return {
        name: 'w', buy_rate: 0.2, sell_rate: 0.05,
        from_day_of_week: 0, to_day_of_week: 6,
        from_hour: 0, from_minute: 0, to_hour: 24, to_minute: 0, ...p,
    };
}
function season(p: Partial<ParsedSeason>): ParsedSeason {
    return {
        name: 's', from_month: 1, from_day: 1, to_month: 12, to_day: 31,
        buy_rate: 0, sell_rate: 0, schedules: [win({})], ...p,
    };
}

describe('windowCoverage', () => {
    it('reports no gap when a base all-day/all-week window covers the season', () => {
        const cov = windowCoverage(season({}));
        expect(cov.gaps).toEqual([]);
        expect(cov.grid.length).toBe(7);
        expect(cov.grid[0].length).toBe(24);
    });

    it('reports the uncovered hours when no window covers them', () => {
        // a single Mon-Fri 16-21 peak window, no base -> everything else is a gap
        const cov = windowCoverage(season({ schedules: [win({ from_day_of_week: 0, to_day_of_week: 4, from_hour: 16, to_hour: 21 })] }));
        expect(cov.gaps.length).toBeGreaterThan(0);
        // Saturday (tesla weekday 5) hour 0 is uncovered
        expect(cov.gaps).toContainEqual({ weekday: 5, hour: 0 });
        // Monday (tesla weekday 0) hour 17 IS covered
        expect(cov.gaps).not.toContainEqual({ weekday: 0, hour: 17 });
    });

    it('covers a midnight-crossing window (21->6)', () => {
        const cov = windowCoverage(season({ schedules: [win({ from_hour: 21, to_hour: 6 })] }));
        // hours 21,22,23,0..5 covered; hour 12 NOT
        expect(cov.gaps).not.toContainEqual({ weekday: 0, hour: 23 });
        expect(cov.gaps).not.toContainEqual({ weekday: 0, hour: 3 });
        expect(cov.gaps).toContainEqual({ weekday: 0, hour: 12 });
    });

    it('lets a narrower Sat-Sun all-day window override an Every-Day peak with no false gap', () => {
        const cov = windowCoverage(season({ schedules: [
            win({ name: 'base', from_hour: 0, to_hour: 24 }),                       // all-day base
            win({ name: 'peak', from_day_of_week: 0, to_day_of_week: 6, from_hour: 16, to_hour: 21 }),
            win({ name: 'weekend', from_day_of_week: 5, to_day_of_week: 6, from_hour: 0, to_hour: 24 }),
        ] }));
        expect(cov.gaps).toEqual([]);
    });
});

describe('seasonCalendarGaps', () => {
    it('is empty for a single all-year season', () => {
        expect(seasonCalendarGaps([season({})])).toEqual([]);
    });
    it('flags a month not covered by any season', () => {
        const summer = season({ from_month: 6, from_day: 1, to_month: 9, to_day: 30 });
        const gaps = seasonCalendarGaps([summer]);
        // January 15 is uncovered
        expect(gaps).toContainEqual({ month: 1, day: 15, count: 0 });
    });
    it('flags a day covered by two seasons', () => {
        const a = season({ from_month: 1, from_day: 1, to_month: 12, to_day: 31 });
        const b = season({ from_month: 6, from_day: 1, to_month: 6, to_day: 30 });
        const gaps = seasonCalendarGaps([a, b]);
        expect(gaps).toContainEqual({ month: 6, day: 15, count: 2 });
    });
});

describe('canonicalizeSeasons + isFixedSchedule', () => {
    it('collapses an all-same-rate season to one 24/7 window and reads Fixed', () => {
        const multi = season({ schedules: [
            win({ from_hour: 0, to_hour: 16, buy_rate: 0.2, sell_rate: 0.05 }),
            win({ from_hour: 16, to_hour: 24, buy_rate: 0.2, sell_rate: 0.05 }),
        ] });
        const out = canonicalizeSeasons([multi]);
        expect(out[0].schedules.length).toBe(1);
        expect(out[0].schedules[0]).toMatchObject({ from_day_of_week: 0, to_day_of_week: 6, from_hour: 0, to_hour: 24, buy_rate: 0.2 });
        expect(isFixedSchedule(out)).toBe(true);
    });
    it('leaves a genuinely differing season intact and reads TOU', () => {
        const multi = season({ schedules: [
            win({ from_hour: 0, to_hour: 16, buy_rate: 0.18 }),
            win({ from_hour: 16, to_hour: 21, buy_rate: 0.45 }),
            win({ from_hour: 21, to_hour: 24, buy_rate: 0.18 }),
        ] });
        const out = canonicalizeSeasons([multi]);
        expect(out[0].schedules.length).toBe(3);
        expect(isFixedSchedule(out)).toBe(false);
    });
    it('reads TOU when seasons differ in rate even if each season is internally flat', () => {
        const summer = season({ from_month: 6, from_day: 1, to_month: 9, to_day: 30, schedules: [win({ buy_rate: 0.30 })] });
        const winter = season({ from_month: 10, from_day: 1, to_month: 5, to_day: 31, schedules: [win({ buy_rate: 0.20 })] });
        expect(isFixedSchedule([summer, winter])).toBe(false);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/lib/roi/tou-coverage`
Expected: FAIL — module `./tou-coverage` not found.

- [ ] **Step 3: Implement `tou-coverage.ts`**

Create `src/lib/roi/tou-coverage.ts`:

```ts
import type { ParsedSeason, ParsedSchedule } from '../importer/tariff-parser';

export interface Cell { weekday: number; hour: number }   // weekday: Tesla 0=Mon … 6=Sun
export interface WindowCoverage { grid: boolean[][]; gaps: Cell[] }  // grid[weekday][hour] = covered?
export interface CalendarGap { month: number; day: number; count: number }  // count 0 = gap, >1 = overlap

const EPS = 1e-9;
const isAllDay = (s: ParsedSchedule) => s.from_hour === 0 && s.to_hour === 24;
const dayRange = (s: ParsedSchedule) => s.to_day_of_week - s.from_day_of_week;

/** Most-specific-wins order, mirroring schedule.ts: narrower day-range first, then
 *  time-specific (not all-day) before all-day. */
function sortSchedules(schedules: ParsedSchedule[]): ParsedSchedule[] {
    return [...schedules].sort((a, b) => {
        if (dayRange(a) !== dayRange(b)) return dayRange(a) - dayRange(b);
        const aSpecific = !isAllDay(a), bSpecific = !isAllDay(b);
        if (aSpecific && !bSpecific) return -1;
        if (!aSpecific && bSpecific) return 1;
        return 0;
    });
}

function matchDay(twd: number, s: ParsedSchedule): boolean {
    return twd >= s.from_day_of_week && twd <= s.to_day_of_week;
}
function matchHour(hour: number, s: ParsedSchedule): boolean {
    if (s.from_hour <= s.to_hour) return hour >= s.from_hour && hour < s.to_hour;
    return hour >= s.from_hour || hour < s.to_hour;   // midnight-crossing
}

/** The 7×24 (Tesla-weekday × hour) coverage grid for one season + the list of gap cells. */
export function windowCoverage(season: ParsedSeason): WindowCoverage {
    const sorted = sortSchedules(season.schedules);
    const grid: boolean[][] = [];
    const gaps: Cell[] = [];
    for (let weekday = 0; weekday < 7; weekday++) {
        const row: boolean[] = [];
        for (let hour = 0; hour < 24; hour++) {
            const covered = sorted.some(s => matchDay(weekday, s) && matchHour(hour, s));
            row.push(covered);
            if (!covered) gaps.push({ weekday, hour });
        }
        grid.push(row);
    }
    return { grid, gaps };
}

/** Mirrors schedule.ts matchSeason (inclusive bounds; wrap-around year). */
function matchSeason(month: number, day: number, s: ParsedSeason): boolean {
    const wraps = s.to_month < s.from_month;
    if (!wraps) {
        if (s.from_month === s.to_month) return month === s.from_month && day >= s.from_day && day <= s.to_day;
        if (month > s.from_month && month < s.to_month) return true;
        if (month === s.from_month && day >= s.from_day) return true;
        if (month === s.to_month && day <= s.to_day) return true;
        return false;
    }
    if (month > s.from_month || month < s.to_month) return true;
    if (month === s.from_month && day >= s.from_day) return true;
    if (month === s.to_month && day <= s.to_day) return true;
    return false;
}

/** Days of a leap reference year matched by zero seasons (gap) or more than one (overlap). */
export function seasonCalendarGaps(seasons: ParsedSeason[]): CalendarGap[] {
    const out: CalendarGap[] = [];
    const daysInMonth = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]; // 2024 (leap)
    for (let month = 1; month <= 12; month++) {
        for (let day = 1; day <= daysInMonth[month - 1]; day++) {
            const count = seasons.filter(s => matchSeason(month, day, s)).length;
            if (count !== 1) out.push({ month, day, count });
        }
    }
    return out;
}

/** Collapse each season whose windows all share one (buy,sell) rate into a single
 *  24/7 all-week window (decision 9). Genuinely differing seasons pass through. */
export function canonicalizeSeasons(seasons: ParsedSeason[]): ParsedSeason[] {
    return seasons.map(s => {
        const first = s.schedules[0];
        const uniform = first && s.schedules.every(w =>
            Math.abs(w.buy_rate - first.buy_rate) < EPS && Math.abs(w.sell_rate - first.sell_rate) < EPS);
        if (!uniform) return s;
        return {
            ...s,
            buy_rate: first.buy_rate,
            sell_rate: first.sell_rate,
            schedules: [{
                name: 'Flat', buy_rate: first.buy_rate, sell_rate: first.sell_rate,
                from_day_of_week: 0, to_day_of_week: 6,
                from_hour: 0, from_minute: 0, to_hour: 24, to_minute: 0,
            }],
        };
    });
}

/** Rate-based Fixed/TOU (mirrors classifyTariff): Fixed iff every window buy rate is equal. */
export function isFixedSchedule(seasons: ParsedSeason[]): boolean {
    const rates: number[] = [];
    for (const s of seasons) for (const w of s.schedules) rates.push(w.buy_rate);
    if (rates.length === 0) return true;
    return rates.every(r => Math.abs(r - rates[0]) < EPS);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/lib/roi/tou-coverage`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cmd/next-app/src/lib/roi/tou-coverage.ts cmd/next-app/src/lib/roi/tou-coverage.test.ts
git commit -m "feat(roi): tou-coverage — window/season coverage + same-rate canonicalization"
```

---

## Task 2: `getPlanStructure` — read a version's full parsed structure

Read one tariff version (metered **or** comparison — reads need no `reporting_only` guard since the metered plan is a valid clone seed) as `ParsedSeason[]`.

**Files:**
- Modify: `cmd/next-app/src/lib/roi/comparison-tariff-repo.ts`
- Test: `cmd/next-app/src/lib/roi/comparison-tariff-repo.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/lib/roi/comparison-tariff-repo.test.ts`:

```ts
describe('ComparisonTariffRepo.getPlanStructure', () => {
    beforeEach(() => { poolQueryMock.mockReset(); });

    it('assembles seasons + windows for (site, name, version) without a reporting_only guard', async () => {
        poolQueryMock.mockResolvedValue({ rows: [
            { tariff_name: 'EV', season_id: 1, season_name: 'All Year', from_month: 1, from_day: 1, to_month: 12, to_day: 31,
              season_buy_rate: 0, season_sell_rate: 0, schedule_id: 10, schedule_name: 'Peak',
              schedule_buy_rate: 0.45, schedule_sell_rate: 0.06, from_day_of_week: 0, to_day_of_week: 4,
              from_hour: 16, from_minute: 0, to_hour: 21, to_minute: 0 },
            { tariff_name: 'EV', season_id: 1, season_name: 'All Year', from_month: 1, from_day: 1, to_month: 12, to_day: 31,
              season_buy_rate: 0, season_sell_rate: 0, schedule_id: 11, schedule_name: 'Off',
              schedule_buy_rate: 0.18, schedule_sell_rate: 0.06, from_day_of_week: 0, to_day_of_week: 6,
              from_hour: 0, from_minute: 0, to_hour: 24, to_minute: 0 },
        ] });
        const out = await new ComparisonTariffRepo().getPlanStructure('site-1', 'EV', 2);
        const sql = sqlOf(poolQueryMock.mock.calls[0]);
        expect(sql).not.toMatch(/reporting_only/);  // reads span metered + comparison
        expect(sql).toMatch(/version = \$3/);
        expect(out?.name).toBe('EV');
        expect(out?.seasons.length).toBe(1);
        expect(out?.seasons[0].schedules.length).toBe(2);
        expect(out?.seasons[0].schedules[0].buy_rate).toBe(0.45);
    });

    it('returns null when nothing matches', async () => {
        poolQueryMock.mockResolvedValue({ rows: [] });
        const out = await new ComparisonTariffRepo().getPlanStructure('site-1', 'Nope', 1);
        expect(out).toBeNull();
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/lib/roi/comparison-tariff-repo`
Expected: FAIL — `getPlanStructure` is not a function.

- [ ] **Step 3: Implement `getPlanStructure`**

In `src/lib/roi/comparison-tariff-repo.ts`, add the import at the top:

```ts
import type { ParsedSeason, ParsedTariff } from '../importer/tariff-parser';
```

Add this method inside `ComparisonTariffRepo` (after `listFixedComparisons`):

```ts
    /** Full parsed structure for one tariff version (metered or comparison). Reads need no
     *  reporting_only guard — the metered plan is a valid clone seed. Null when absent. */
    async getPlanStructure(siteId: string, name: string, version: number): Promise<ParsedTariff | null> {
        const res = await pool.query(
            `SELECT t.name AS tariff_name,
                    se.id AS season_id, se.name AS season_name,
                    se.from_month, se.from_day, se.to_month, se.to_day,
                    se.buy_rate AS season_buy_rate, se.sell_rate AS season_sell_rate,
                    sc.id AS schedule_id, sc.name AS schedule_name,
                    sc.buy_rate AS schedule_buy_rate, sc.sell_rate AS schedule_sell_rate,
                    sc.from_day_of_week, sc.from_hour, sc.from_minute,
                    sc.to_day_of_week, sc.to_hour, sc.to_minute
               FROM "Tariff" t
               JOIN "TariffSeason" se ON se.tariff_id = t.id
               LEFT JOIN "TariffSchedule" sc ON sc.season_id = se.id
              WHERE t.site_id = $1 AND t.name = $2 AND t.version = $3
              ORDER BY se.id, sc.id`,
            [siteId, name, version],
        );
        if (res.rows.length === 0) return null;
        const bySeason = new Map<number, ParsedSeason>();
        for (const r of res.rows) {
            const sid = Number(r.season_id);
            if (!bySeason.has(sid)) {
                bySeason.set(sid, {
                    name: r.season_name ?? '',
                    from_month: Number(r.from_month), from_day: Number(r.from_day),
                    to_month: Number(r.to_month), to_day: Number(r.to_day),
                    buy_rate: Number(r.season_buy_rate), sell_rate: Number(r.season_sell_rate),
                    schedules: [],
                });
            }
            if (r.schedule_id != null) {
                bySeason.get(sid)!.schedules.push({
                    name: r.schedule_name ?? '',
                    buy_rate: r.schedule_buy_rate != null ? Number(r.schedule_buy_rate) : Number(r.season_buy_rate),
                    sell_rate: r.schedule_sell_rate != null ? Number(r.schedule_sell_rate) : Number(r.season_sell_rate),
                    from_day_of_week: Number(r.from_day_of_week), to_day_of_week: Number(r.to_day_of_week),
                    from_hour: Number(r.from_hour), from_minute: Number(r.from_minute),
                    to_hour: Number(r.to_hour), to_minute: Number(r.to_minute),
                });
            }
        }
        return { name: res.rows[0].tariff_name as string, seasons: Array.from(bySeason.values()) };
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/lib/roi/comparison-tariff-repo`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cmd/next-app/src/lib/roi/comparison-tariff-repo.ts cmd/next-app/src/lib/roi/comparison-tariff-repo.test.ts
git commit -m "feat(roi): getPlanStructure — read a version's full parsed schedule"
```

---

## Task 3: `saveComparisonStructure` — persist a full structure (create / append / replace)

Persist any `ParsedSeason[]` as a `reporting_only` chain, canonicalizing same-rate seasons first. `intent` gates create/append vs in-place replace. Retire the Fixed-only `appendFixedComparison` and rate-only `editComparisonVersion`.

**Files:**
- Modify: `cmd/next-app/src/lib/roi/comparison-tariff-repo.ts`
- Test: `cmd/next-app/src/lib/roi/comparison-tariff-repo.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/lib/roi/comparison-tariff-repo.test.ts`:

```ts
describe('ComparisonTariffRepo.saveComparisonStructure', () => {
    const seasons = [{
        name: 'All Year', from_month: 1, from_day: 1, to_month: 12, to_day: 31, buy_rate: 0, sell_rate: 0,
        schedules: [
            { name: 'Peak', buy_rate: 0.45, sell_rate: 0.06, from_day_of_week: 0, to_day_of_week: 4, from_hour: 16, from_minute: 0, to_hour: 21, to_minute: 0 },
            { name: 'Off', buy_rate: 0.18, sell_rate: 0.06, from_day_of_week: 0, to_day_of_week: 6, from_hour: 0, from_minute: 0, to_hour: 24, to_minute: 0 },
        ],
    }];

    beforeEach(() => {
        clientQueryMock.mockReset();
        connectMock.mockResolvedValue({ query: clientQueryMock, release: releaseMock });
        clientQueryMock.mockResolvedValue({ rows: [{ next: 3, id: 42 }], rowCount: 1 });
    });

    it('create: demotes current, inserts a reporting-only Tariff + season + each window', async () => {
        await new ComparisonTariffRepo().saveComparisonStructure('site-1', 'EV', '2025-01-01', seasons, 'create');
        const sqls = clientQueryMock.mock.calls.map(sqlOf);
        expect(sqls.find(s => s.includes('SET is_current = false'))).toMatch(/reporting_only/);
        expect(sqls.find(s => s.includes('INSERT INTO "Tariff"'))).toMatch(/reporting_only/);
        expect(sqls.some(s => s.includes('INSERT INTO "TariffSeason"'))).toBe(true);
        const insertScheduleCalls = sqls.filter(s => s.includes('INSERT INTO "TariffSchedule"'));
        expect(insertScheduleCalls.length).toBe(2); // two windows
        expect(sqls).toContain('COMMIT');
    });

    it('replace: deletes the version\'s existing seasons (guarded reporting_only) then re-inserts', async () => {
        await new ComparisonTariffRepo().saveComparisonStructure('site-1', 'EV', '2025-01-01', seasons, 'replace', 2);
        const sqls = clientQueryMock.mock.calls.map(sqlOf);
        const del = sqls.find(s => s.includes('DELETE FROM "TariffSeason"'));
        expect(del).toMatch(/reporting_only/);
        expect(del).toMatch(/version = \$3/);
        expect(sqls.some(s => s.includes('INSERT INTO "TariffSeason"'))).toBe(true);
        expect(sqls).toContain('COMMIT');
    });

    it('canonicalizes an all-same-rate season to a single window before persisting', async () => {
        const flatish = [{
            name: 'All Year', from_month: 1, from_day: 1, to_month: 12, to_day: 31, buy_rate: 0, sell_rate: 0,
            schedules: [
                { name: 'A', buy_rate: 0.2, sell_rate: 0.05, from_day_of_week: 0, to_day_of_week: 6, from_hour: 0, from_minute: 0, to_hour: 16, to_minute: 0 },
                { name: 'B', buy_rate: 0.2, sell_rate: 0.05, from_day_of_week: 0, to_day_of_week: 6, from_hour: 16, from_minute: 0, to_hour: 24, to_minute: 0 },
            ],
        }];
        await new ComparisonTariffRepo().saveComparisonStructure('site-1', 'Flat', null, flatish, 'create');
        const sqls = clientQueryMock.mock.calls.map(sqlOf);
        expect(sqls.filter(s => s.includes('INSERT INTO "TariffSchedule"')).length).toBe(1); // collapsed
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/lib/roi/comparison-tariff-repo`
Expected: FAIL — `saveComparisonStructure` is not a function.

- [ ] **Step 3: Implement `saveComparisonStructure`**

In `src/lib/roi/comparison-tariff-repo.ts`, add the import:

```ts
import { canonicalizeSeasons } from './tou-coverage';
```

Add this method inside `ComparisonTariffRepo` (after `getPlanStructure`). **Keep `appendFixedComparison` and `editComparisonVersion` for now** — the route still calls them until Task 5, which deletes them in the same commit that removes their callers (this keeps every commit building):

```ts
    /** Persist a full parsed schedule as a reporting-only chain. Same-rate seasons are
     *  canonicalized to one 24/7 window first (decision 9). intent:
     *   - 'create'        : new plan/version 1 (or next version of an existing name)
     *   - 'append-version': append the next effective-dated version, demoting the prior current
     *   - 'replace'       : replace the structure of an existing version in place (requires `version`)
     *  All writes are reporting_only-guarded. */
    async saveComparisonStructure(
        siteId: string, name: string, effectiveFrom: string | null,
        seasons: ParsedSeason[], intent: 'create' | 'append-version' | 'replace', version?: number,
    ): Promise<void> {
        const canon = canonicalizeSeasons(seasons);
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('SELECT 1 FROM "Site" WHERE id = $1 FOR UPDATE', [siteId]);

            let tariffId: number;
            if (intent === 'replace') {
                const tRes = await client.query(
                    `UPDATE "Tariff" SET effective_from = $4, updated = NOW()
                      WHERE site_id = $1 AND name = $2 AND version = $3 AND reporting_only
                      RETURNING id`,
                    [siteId, name, version, effectiveFrom],
                );
                if (tRes.rowCount === 0) { await client.query('ROLLBACK'); return; }
                tariffId = tRes.rows[0].id;
                await client.query(
                    `DELETE FROM "TariffSeason"
                      WHERE tariff_id IN (
                        SELECT id FROM "Tariff" WHERE site_id = $1 AND name = $2 AND version = $3 AND reporting_only)`,
                    [siteId, name, version],
                );
            } else {
                await client.query(
                    `UPDATE "Tariff" SET is_current = false
                      WHERE site_id = $1 AND name = $2 AND reporting_only AND is_current`,
                    [siteId, name],
                );
                const verRes = await client.query(
                    `SELECT COALESCE(MAX(version), 0) + 1 AS next FROM "Tariff" WHERE site_id = $1 AND name = $2`,
                    [siteId, name],
                );
                const tRes = await client.query(
                    `INSERT INTO "Tariff"(site_id, name, version, is_current, reporting_only, effective_from, updated)
                     VALUES ($1, $2, $3, true, true, $4, NOW()) RETURNING id`,
                    [siteId, name, verRes.rows[0].next, effectiveFrom],
                );
                tariffId = tRes.rows[0].id;
            }

            for (const se of canon) {
                const sRes = await client.query(
                    `INSERT INTO "TariffSeason"(tariff_id, name, from_month, from_day, to_month, to_day, buy_rate, sell_rate)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
                    [tariffId, se.name, se.from_month, se.from_day, se.to_month, se.to_day, se.buy_rate, se.sell_rate],
                );
                const seasonId = sRes.rows[0].id;
                for (const w of se.schedules) {
                    await client.query(
                        `INSERT INTO "TariffSchedule"(season_id, name, buy_rate, sell_rate, from_day_of_week, to_day_of_week, from_hour, from_minute, to_hour, to_minute)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
                        [seasonId, w.name, w.buy_rate, w.sell_rate, w.from_day_of_week, w.to_day_of_week, w.from_hour, w.from_minute, w.to_hour, w.to_minute],
                    );
                }
            }
            await client.query('COMMIT');
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/lib/roi/comparison-tariff-repo`
Expected: PASS (the existing `appendFixedComparison`/`editComparisonVersion` describe blocks still pass — they are removed in Task 5).

- [ ] **Step 5: Commit**

```bash
git add cmd/next-app/src/lib/roi/comparison-tariff-repo.ts cmd/next-app/src/lib/roi/comparison-tariff-repo.test.ts
git commit -m "feat(roi): saveComparisonStructure — persist full schedules; retire Fixed-only path"
```

---

## Task 4: `renameComparisonPlan` + kind-aware listing

Rename a whole plan (guarded), and extend the listing so each version carries its Fixed/TOU `kind` (rate-variation) for the Phase-B badge.

**Files:**
- Modify: `cmd/next-app/src/lib/roi/comparison-tariff-repo.ts`
- Test: `cmd/next-app/src/lib/roi/comparison-tariff-repo.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/lib/roi/comparison-tariff-repo.test.ts`:

```ts
describe('ComparisonTariffRepo.renameComparisonPlan', () => {
    beforeEach(() => { poolQueryMock.mockReset(); });
    it('renames all reporting-only versions of the name, guarded reporting_only', async () => {
        poolQueryMock.mockResolvedValue({ rows: [], rowCount: 2 });
        await new ComparisonTariffRepo().renameComparisonPlan('site-1', 'Old', 'New');
        const sql = sqlOf(poolQueryMock.mock.calls[0]);
        expect(sql).toMatch(/UPDATE "Tariff" SET name = \$3/);
        expect(sql).toMatch(/reporting_only/);
        expect(poolQueryMock.mock.calls[0][1]).toEqual(['site-1', 'Old', 'New']);
    });
});

describe('ComparisonTariffRepo.listFixedComparisons kind', () => {
    beforeEach(() => { poolQueryMock.mockReset(); });
    it('marks a version TOU when its windows have differing buy rates, else fixed', async () => {
        poolQueryMock.mockResolvedValue({ rows: [
            { name: 'EV', version: 2, is_current: true, effective_from: '2025-01-01', buy_rate: 0, sell_rate: 0, distinct_buy_rates: 2 },
            { name: 'Flat', version: 1, is_current: true, effective_from: null, buy_rate: 0.2, sell_rate: 0.05, distinct_buy_rates: 1 },
        ] });
        const plans = await new ComparisonTariffRepo().listFixedComparisons('site-1');
        const ev = plans.find(p => p.name === 'EV')!;
        const flat = plans.find(p => p.name === 'Flat')!;
        expect(ev.versions[0].kind).toBe('tou');
        expect(flat.versions[0].kind).toBe('fixed');
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/lib/roi/comparison-tariff-repo`
Expected: FAIL — `renameComparisonPlan` missing; `kind` undefined.

- [ ] **Step 3: Implement rename + extend listing**

In `src/lib/roi/comparison-tariff-repo.ts`, extend the `ComparisonVersion` interface with a `kind` field:

```ts
export interface ComparisonVersion {
    version: number;
    is_current: boolean;
    effective_from: string | null;
    buy_rate: number;
    sell_rate: number;
    kind: 'fixed' | 'tou';
}
```

Add the rename method inside `ComparisonTariffRepo` (after `comparisonNameInUse`):

```ts
    /** Rename every reporting-only version of a comparison plan. Guarded reporting_only so a
     *  metered tariff is never relabeled. Callers run the collision guards first. */
    async renameComparisonPlan(siteId: string, oldName: string, newName: string): Promise<void> {
        await pool.query(
            `UPDATE "Tariff" SET name = $3, updated = NOW()
              WHERE site_id = $1 AND name = $2 AND reporting_only`,
            [siteId, oldName, newName],
        );
    }
```

Replace the `listFixedComparisons` query + assembly so it derives `kind` from rate-variation across each version's windows:

```ts
    /** All reporting-only plans for a site, grouped by name, newest first. Each version
     *  carries a rate-based `kind` (fixed iff its windows share one buy rate). */
    async listFixedComparisons(siteId: string): Promise<ComparisonPlan[]> {
        const res = await pool.query(
            `SELECT t.name, t.version, t.is_current, t.effective_from::text AS effective_from,
                    se.buy_rate, se.sell_rate,
                    COUNT(DISTINCT sc.buy_rate) AS distinct_buy_rates,
                    MIN(sc.buy_rate) AS window_buy_rate, MIN(sc.sell_rate) AS window_sell_rate
               FROM "Tariff" t
               JOIN "TariffSeason" se ON se.tariff_id = t.id
               LEFT JOIN "TariffSchedule" sc ON sc.season_id = se.id
              WHERE t.site_id = $1 AND t.reporting_only
              GROUP BY t.name, t.version, t.is_current, t.effective_from, se.buy_rate, se.sell_rate
              ORDER BY t.name ASC, t.effective_from DESC NULLS LAST, t.version DESC`,
            [siteId],
        );
        const byName = new Map<string, ComparisonPlan>();
        for (const r of res.rows) {
            const name = r.name as string;
            if (!byName.has(name)) byName.set(name, { name, versions: [] });
            const distinct = Number(r.distinct_buy_rates);
            const kind: 'fixed' | 'tou' = distinct > 1 ? 'tou' : 'fixed';
            // Fixed plans carry the rate on the window (or the season for legacy flat rows).
            const buy = r.window_buy_rate != null ? Number(r.window_buy_rate) : Number(r.buy_rate);
            const sell = r.window_sell_rate != null ? Number(r.window_sell_rate) : Number(r.sell_rate);
            byName.get(name)!.versions.push({
                version: Number(r.version),
                is_current: r.is_current === true,
                effective_from: r.effective_from ?? null,
                buy_rate: buy, sell_rate: sell, kind,
            });
        }
        return Array.from(byName.values());
    }
```

> Note: any other code constructing a `ComparisonVersion` literal (e.g. existing tests) must now include `kind`. Add `kind: 'fixed'` to such fixtures.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/lib/roi/comparison-tariff-repo`
Expected: PASS.

- [ ] **Step 5: Filter the ROI-summary baseline to Fixed plans**

Now that comparison plans can be TOU, `pickCurrentFixedBaseline` must skip them — otherwise a TOU plan's representative rate would be adopted as the flat baseline (the spec caveat assumes it only picks Fixed plans). Add a failing test to `src/lib/roi/resolve-fixed-baseline.test.ts`:

```ts
it('ignores a TOU comparison plan when choosing the fixed baseline', () => {
    const plans = [
        { name: 'EV', versions: [{ version: 1, is_current: true, effective_from: '2025-01-01', buy_rate: 0.18, sell_rate: 0.06, kind: 'tou' as const }] },
        { name: 'Flat', versions: [{ version: 1, is_current: true, effective_from: '2024-01-01', buy_rate: 0.20, sell_rate: 0.05, kind: 'fixed' as const }] },
    ];
    expect(pickCurrentFixedBaseline(plans)).toEqual({ fixedBuyRate: 0.20, fixedSellRate: 0.05 });
});
```

Then in `src/lib/roi/resolve-fixed-baseline.ts`, skip non-Fixed current versions:

```ts
    for (const plan of plans) {
        const current = plan.versions.find(v => v.is_current && v.kind === 'fixed');
        if (!current) continue;
        const eff = current.effective_from ?? '0000-01-01';
        if (!best || eff > best.eff) best = { eff, v: current };
    }
```

- [ ] **Step 6: Verify nothing else broke from the `kind` field**

Run: `npm test -- src/lib/roi && npx tsc --noEmit`
Expected: PASS. Fix any `ComparisonVersion` fixtures missing `kind` (e.g. in `plan-timeline.test.ts` / `resolve-fixed-baseline.test.ts`) by adding `kind: 'fixed'`.

- [ ] **Step 7: Commit**

```bash
git add cmd/next-app/src/lib/roi/comparison-tariff-repo.ts cmd/next-app/src/lib/roi/comparison-tariff-repo.test.ts cmd/next-app/src/lib/roi/resolve-fixed-baseline.ts cmd/next-app/src/lib/roi/resolve-fixed-baseline.test.ts
git commit -m "feat(roi): renameComparisonPlan + rate-based kind; baseline ignores TOU plans"
```

---

## Task 5: Route — `GET` structure, full-`seasons` `POST`/`PATCH`, rename, coverage 400

Wire the new repo methods to HTTP. `GET` returns a version's structure. `POST` (create/append) and `PATCH` (replace) accept a full `seasons[]` payload and reject a coverage gap with 400. `PATCH` also handles a `rename` intent.

**Files:**
- Modify: `cmd/next-app/src/app/api/site/[id]/comparison-tariff/route.ts`
- Test: `cmd/next-app/src/app/api/site/[id]/comparison-tariff/route.test.ts`

- [ ] **Step 1: Write the failing test**

Replace `src/app/api/site/[id]/comparison-tariff/route.test.ts` with:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { verifyMock, saveMock, getMock, renameMock, delVersionMock, delPlanMock, meteredMock, compMock } = vi.hoisted(() => ({
    verifyMock: vi.fn(), saveMock: vi.fn(), getMock: vi.fn(), renameMock: vi.fn(),
    delVersionMock: vi.fn(), delPlanMock: vi.fn(), meteredMock: vi.fn(), compMock: vi.fn(),
}));

vi.mock('@/lib/auth-checks', () => ({ verifySiteAccess: verifyMock }));
vi.mock('@/lib/roi/comparison-tariff-repo', () => ({
    ComparisonTariffRepo: class {
        saveComparisonStructure = saveMock;
        getPlanStructure = getMock;
        renameComparisonPlan = renameMock;
        deleteComparisonVersion = delVersionMock;
        deleteComparisonPlan = delPlanMock;
        nameInUseByMetered = meteredMock;
        comparisonNameInUse = compMock;
    },
}));

import { GET, POST, PATCH, DELETE } from './route';

function req(body?: unknown, url = 'http://x/api/site/site-1/comparison-tariff') {
    return { json: async () => body, url } as unknown as Request;
}
const ctx = { params: Promise.resolve({ id: 'site-1' }) };

// One all-year season with a single 24/7 window — full coverage.
const flatSeasons = [{
    name: 'All Year', from_month: 1, from_day: 1, to_month: 12, to_day: 31, buy_rate: 0, sell_rate: 0,
    schedules: [{ name: 'Flat', buy_rate: 0.2, sell_rate: 0.05, from_day_of_week: 0, to_day_of_week: 6, from_hour: 0, from_minute: 0, to_hour: 24, to_minute: 0 }],
}];
// A season with an obvious gap (only Mon-Fri 16-21).
const gappySeasons = [{
    name: 'All Year', from_month: 1, from_day: 1, to_month: 12, to_day: 31, buy_rate: 0, sell_rate: 0,
    schedules: [{ name: 'Peak', buy_rate: 0.45, sell_rate: 0.06, from_day_of_week: 0, to_day_of_week: 4, from_hour: 16, from_minute: 0, to_hour: 21, to_minute: 0 }],
}];

describe('comparison-tariff route', () => {
    beforeEach(() => {
        for (const m of [verifyMock, saveMock, getMock, renameMock, delVersionMock, delPlanMock, meteredMock, compMock]) m.mockReset();
        verifyMock.mockResolvedValue(true);
        meteredMock.mockResolvedValue(false);
        compMock.mockResolvedValue(false);
    });

    it('GET returns the version structure', async () => {
        getMock.mockResolvedValue({ name: 'EV', seasons: flatSeasons });
        const res = await GET(req(undefined, 'http://x/api/site/site-1/comparison-tariff?name=EV&version=2') as never, ctx as never);
        expect(res.status).toBe(200);
        expect(getMock).toHaveBeenCalledWith('site-1', 'EV', 2);
    });

    it('POST create persists a full structure', async () => {
        const res = await POST(req({ name: 'EV', effective_from: '2025-01-01', seasons: flatSeasons }) as never, ctx as never);
        expect(res.status).toBe(200);
        expect(saveMock).toHaveBeenCalledWith('site-1', 'EV', '2025-01-01', flatSeasons, 'create', undefined);
    });

    it('POST 400 when the structure has a coverage gap', async () => {
        const res = await POST(req({ name: 'EV', seasons: gappySeasons }) as never, ctx as never);
        expect(res.status).toBe(400);
        expect(saveMock).not.toHaveBeenCalled();
    });

    it('POST 409 on metered-name collision', async () => {
        meteredMock.mockResolvedValue(true);
        const res = await POST(req({ name: 'Standard', seasons: flatSeasons }) as never, ctx as never);
        expect(res.status).toBe(409);
    });

    it('POST create 409 when the comparison name already exists', async () => {
        compMock.mockResolvedValue(true);
        const res = await POST(req({ name: 'EV', seasons: flatSeasons }) as never, ctx as never);
        expect(res.status).toBe(409);
    });

    it('POST append-version skips the comparison-name check', async () => {
        compMock.mockResolvedValue(true);
        const res = await POST(req({ intent: 'append-version', name: 'EV', seasons: flatSeasons }) as never, ctx as never);
        expect(res.status).toBe(200);
        expect(saveMock).toHaveBeenCalledWith('site-1', 'EV', null, flatSeasons, 'append-version', undefined);
    });

    it('PATCH replace persists with the version', async () => {
        const res = await PATCH(req({ name: 'EV', version: 2, effective_from: '2025-06-01', seasons: flatSeasons }) as never, ctx as never);
        expect(res.status).toBe(200);
        expect(saveMock).toHaveBeenCalledWith('site-1', 'EV', '2025-06-01', flatSeasons, 'replace', 2);
    });

    it('PATCH replace 400 on a coverage gap', async () => {
        const res = await PATCH(req({ name: 'EV', version: 2, seasons: gappySeasons }) as never, ctx as never);
        expect(res.status).toBe(400);
        expect(saveMock).not.toHaveBeenCalled();
    });

    it('PATCH rename calls renameComparisonPlan after the guards', async () => {
        const res = await PATCH(req({ intent: 'rename', name: 'EV', newName: 'EV Plan' }) as never, ctx as never);
        expect(res.status).toBe(200);
        expect(renameMock).toHaveBeenCalledWith('site-1', 'EV', 'EV Plan');
    });

    it('PATCH rename 409 when the new name collides', async () => {
        compMock.mockResolvedValue(true);
        const res = await PATCH(req({ intent: 'rename', name: 'EV', newName: 'Taken' }) as never, ctx as never);
        expect(res.status).toBe(409);
        expect(renameMock).not.toHaveBeenCalled();
    });

    it('DELETE with a version removes that version', async () => {
        const res = await DELETE(req({ name: 'EV', version: 1 }) as never, ctx as never);
        expect(res.status).toBe(200);
        expect(delVersionMock).toHaveBeenCalledWith('site-1', 'EV', 1);
    });

    it('DELETE without a version removes the whole plan', async () => {
        const res = await DELETE(req({ name: 'EV' }) as never, ctx as never);
        expect(res.status).toBe(200);
        expect(delPlanMock).toHaveBeenCalledWith('site-1', 'EV');
    });

    it('POST 403 when unauthorized', async () => {
        verifyMock.mockResolvedValue(false);
        const res = await POST(req({ name: 'EV', seasons: flatSeasons }) as never, ctx as never);
        expect(res.status).toBe(403);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- comparison-tariff/route`
Expected: FAIL — `GET` not exported; structure/coverage/rename behavior absent.

- [ ] **Step 3: Implement the route**

Replace `src/app/api/site/[id]/comparison-tariff/route.ts` with:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { verifySiteAccess } from '@/lib/auth-checks';
import { ComparisonTariffRepo } from '@/lib/roi/comparison-tariff-repo';
import { seasonCalendarGaps, windowCoverage } from '@/lib/roi/tou-coverage';
import type { ParsedSeason } from '@/lib/importer/tariff-parser';

export const dynamic = 'force-dynamic';

/** First human-readable coverage problem in a structure, or null when fully covered. */
function coverageError(seasons: ParsedSeason[]): string | null {
    if (!Array.isArray(seasons) || seasons.length === 0) return 'At least one season is required.';
    const calGaps = seasonCalendarGaps(seasons);
    if (calGaps.length > 0) {
        const g = calGaps[0];
        return g.count === 0
            ? `No season covers ${g.month}/${g.day} — every day of the year must belong to a season.`
            : `${g.month}/${g.day} is covered by ${g.count} seasons — seasons must not overlap.`;
    }
    for (const s of seasons) {
        const { gaps } = windowCoverage(s);
        if (gaps.length > 0) {
            const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
            const c = gaps[0];
            return `Season "${s.name}" leaves ${days[c.weekday]} ${String(c.hour).padStart(2, '0')}:00 unpriced — every hour must be covered by a window.`;
        }
    }
    return null;
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    if (!(await verifySiteAccess(id))) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    const url = new URL(request.url);
    const name = (url.searchParams.get('name') ?? '').trim();
    const version = Number(url.searchParams.get('version'));
    if (!name || !Number.isInteger(version)) {
        return NextResponse.json({ error: 'name and version are required' }, { status: 400 });
    }
    const structure = await new ComparisonTariffRepo().getPlanStructure(id, name, version);
    if (!structure) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json(structure);
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    if (!(await verifySiteAccess(id))) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    const body = await request.json();
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const effectiveFrom = body.effective_from ? String(body.effective_from) : null;
    const intent = body.intent === 'append-version' ? 'append-version' : 'create';
    const seasons = body.seasons as ParsedSeason[];

    if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 });
    const covErr = coverageError(seasons);
    if (covErr) return NextResponse.json({ error: covErr }, { status: 400 });

    const repo = new ComparisonTariffRepo();
    if (await repo.nameInUseByMetered(id, name)) {
        return NextResponse.json({ error: `"${name}" is your metered plan's name — choose a different name.` }, { status: 409 });
    }
    if (intent === 'create' && (await repo.comparisonNameInUse(id, name))) {
        return NextResponse.json({ error: `"${name}" already exists — use "+ add version" on that plan instead.` }, { status: 409 });
    }

    await repo.saveComparisonStructure(id, name, effectiveFrom, seasons, intent, undefined);
    return NextResponse.json({ success: true });
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    if (!(await verifySiteAccess(id))) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    const body = await request.json();
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 });
    const repo = new ComparisonTariffRepo();

    if (body.intent === 'rename') {
        const newName = typeof body.newName === 'string' ? body.newName.trim() : '';
        if (!newName) return NextResponse.json({ error: 'newName is required' }, { status: 400 });
        if (await repo.nameInUseByMetered(id, newName) || await repo.comparisonNameInUse(id, newName)) {
            return NextResponse.json({ error: `"${newName}" is already in use — choose a different name.` }, { status: 409 });
        }
        await repo.renameComparisonPlan(id, name, newName);
        return NextResponse.json({ success: true });
    }

    const version = Number(body.version);
    if (!Number.isInteger(version)) {
        return NextResponse.json({ error: 'version is required' }, { status: 400 });
    }
    const effectiveFrom = body.effective_from ? String(body.effective_from) : null;
    const seasons = body.seasons as ParsedSeason[];
    const covErr = coverageError(seasons);
    if (covErr) return NextResponse.json({ error: covErr }, { status: 400 });

    await repo.saveComparisonStructure(id, name, effectiveFrom, seasons, 'replace', version);
    return NextResponse.json({ success: true });
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    if (!(await verifySiteAccess(id))) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    const body = await request.json();
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 });

    const repo = new ComparisonTariffRepo();
    if (body.version === undefined || body.version === null) {
        await repo.deleteComparisonPlan(id, name);
    } else {
        const version = Number(body.version);
        if (!Number.isInteger(version)) {
            return NextResponse.json({ error: 'version must be an integer' }, { status: 400 });
        }
        await repo.deleteComparisonVersion(id, name, version);
    }
    return NextResponse.json({ success: true });
}
```

- [ ] **Step 4: Retire the now-unused Fixed-only repo methods**

The route no longer calls `appendFixedComparison` or the rate-only `editComparisonVersion` (nothing else does — verify with `grep -rn "appendFixedComparison\|editComparisonVersion" src/ | grep -v test`). Delete both methods from `src/lib/roi/comparison-tariff-repo.ts`, plus the now-unused `FixedComparisonInputRow` / `EditVersionInput` interfaces and the `buildFixedComparisonInput` import. Remove their `describe('ComparisonTariffRepo.appendFixedComparison' …)` and `…editComparisonVersion …` blocks from `comparison-tariff-repo.test.ts`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- comparison-tariff && npx tsc --noEmit`
Expected: PASS — route tests green and no dangling reference to the retired methods.

- [ ] **Step 6: Commit**

```bash
git add cmd/next-app/src/app/api/site/\[id\]/comparison-tariff/route.ts cmd/next-app/src/app/api/site/\[id\]/comparison-tariff/route.test.ts cmd/next-app/src/lib/roi/comparison-tariff-repo.ts cmd/next-app/src/lib/roi/comparison-tariff-repo.test.ts
git commit -m "feat(api): comparison-tariff GET + full-structure POST/PATCH + rename; retire Fixed-only path"
```

---

## Task 6: Grid prices comparison columns from their real structure

Generalize comparison pricing to a date-resolved schedule timeline, and feed the page's grid columns from full structures so TOU comparison plans price correctly. Fixed plans regress to the same totals.

**Files:**
- Modify: `cmd/next-app/src/lib/roi/plan-timeline.ts`
- Modify: `cmd/next-app/src/lib/roi/comparison-tariff-repo.ts` (add `listComparisonStructures`)
- Modify: `cmd/next-app/src/app/site/[id]/page.tsx`
- Test: `cmd/next-app/src/lib/roi/plan-timeline.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/lib/roi/plan-timeline.test.ts` (import `comparisonStructTimeline` alongside the existing imports):

```ts
import { comparisonStructTimeline } from './plan-timeline';
import type { Tariff } from '../db';

function touTariff(): Tariff {
    return {
        id: 1, site_id: 's', updated: new Date(), name: 'EV', reporting_only: true, effective_from: null,
        seasons: [{
            id: 1, tariff_id: 1, name: 'All Year', from_month: 1, from_day: 1, to_month: 12, to_day: 31, buy_rate: 0, sell_rate: 0,
            schedules: [
                { id: 1, season_id: 1, name: 'Peak', buy_rate: 0.45, sell_rate: 0.06, from_day_of_week: 0, to_day_of_week: 6, from_hour: 16, from_minute: 0, to_hour: 21, to_minute: 0 },
                { id: 2, season_id: 1, name: 'Off', buy_rate: 0.18, sell_rate: 0.06, from_day_of_week: 0, to_day_of_week: 6, from_hour: 0, from_minute: 0, to_hour: 24, to_minute: 0 },
            ],
        }],
    };
}

describe('comparisonStructTimeline', () => {
    it('prices a TOU comparison plan per-window (peak vs off-peak)', () => {
        const tl = comparisonStructTimeline([touTariff()], 'America/Los_Angeles');
        // 2025-01-06 is a Monday. 17:00 is peak; 03:00 is off-peak.
        expect(tl.rateAt('2025-01-06', 17).buy).toBeCloseTo(0.45, 5);
        expect(tl.rateAt('2025-01-06', 3).buy).toBeCloseTo(0.18, 5);
    });

    it('prices a degenerate one-window plan as flat (Fixed regression)', () => {
        const flat = touTariff();
        flat.seasons![0].schedules = [
            { id: 1, season_id: 1, name: 'Flat', buy_rate: 0.2, sell_rate: 0.05, from_day_of_week: 0, to_day_of_week: 6, from_hour: 0, from_minute: 0, to_hour: 24, to_minute: 0 },
        ];
        const tl = comparisonStructTimeline([flat], 'America/Los_Angeles');
        expect(tl.rateAt('2025-01-06', 17).buy).toBeCloseTo(0.2, 5);
        expect(tl.rateAt('2025-07-04', 3).buy).toBeCloseTo(0.2, 5);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/lib/roi/plan-timeline`
Expected: FAIL — `comparisonStructTimeline` not exported.

- [ ] **Step 3: Implement `comparisonStructTimeline` and the structure loader**

In `src/lib/roi/plan-timeline.ts`, add (it mirrors `meteredTimeline`, but for one plan's reporting-only versions):

```ts
/** A date-resolved timeline for one comparison plan, built from its full Tariff→Season→Schedule
 *  versions (Fixed = the degenerate one-window schedule). Replaces the flat comparisonPlanTimeline. */
export function comparisonStructTimeline(tariffs: Tariff[], timeZone: string): PlanTimeline {
    const versions: TimelineVersion[] = tariffs.map(t => ({
        effectiveFrom: t.effective_from ?? null,
        schedule: new Schedule([t], timeZone),
    }));
    return scheduleTimeline(versions);
}
```

Delete the old flat `comparisonPlanTimeline` (and its now-unused `ComparisonPlan` import if nothing else uses it in this file), plus any `describe('comparisonPlanTimeline' …)` block in `plan-timeline.test.ts` that references it.

In `src/lib/roi/comparison-tariff-repo.ts`, add a loader returning each plan's full Tariff versions grouped by name (assembly mirrors `site-repo.assembleFromRows`):

```ts
    /** All reporting-only plans for a site as full Tariff→Season→Schedule structures, grouped
     *  by name (newest effective_from first). Powers date-resolved grid column pricing. */
    async listComparisonStructures(siteId: string): Promise<{ name: string; tariffs: Tariff[] }[]> {
        const res = await pool.query(
            `SELECT t.id AS tariff_id, t.name AS tariff_name, t.updated AS tariff_updated,
                    t.site_id AS tariff_site_id, t.reporting_only AS tariff_reporting_only,
                    t.effective_from::text AS tariff_effective_from,
                    se.id AS season_id, se.name AS season_name,
                    se.from_month, se.from_day, se.to_month, se.to_day,
                    se.buy_rate AS season_buy_rate, se.sell_rate AS season_sell_rate,
                    sc.id AS schedule_id, sc.name AS schedule_name,
                    sc.buy_rate AS schedule_buy_rate, sc.sell_rate AS schedule_sell_rate,
                    sc.from_day_of_week, sc.from_hour, sc.from_minute,
                    sc.to_day_of_week, sc.to_hour, sc.to_minute
               FROM "Tariff" t
               JOIN "TariffSeason" se ON se.tariff_id = t.id
               LEFT JOIN "TariffSchedule" sc ON sc.season_id = se.id
              WHERE t.site_id = $1 AND t.reporting_only
              ORDER BY t.name ASC, t.effective_from DESC NULLS LAST, t.version DESC, se.id, sc.id`,
            [siteId],
        );
        const tariffMap = new Map<number, Tariff>();
        const seasonMap = new Map<number, TariffSeason>();
        const order: { name: string; tariffs: Tariff[] }[] = [];
        const groupByName = new Map<string, { name: string; tariffs: Tariff[] }>();
        for (const r of res.rows) {
            const tid = Number(r.tariff_id);
            if (!tariffMap.has(tid)) {
                const tariff: Tariff = {
                    id: tid, site_id: r.tariff_site_id as string, updated: new Date(r.tariff_updated as string | Date),
                    name: (r.tariff_name as string | null) ?? null, reporting_only: r.tariff_reporting_only === true,
                    effective_from: (r.tariff_effective_from as string | null) ?? null, seasons: [],
                };
                tariffMap.set(tid, tariff);
                const name = tariff.name ?? '';
                if (!groupByName.has(name)) { const g = { name, tariffs: [] as Tariff[] }; groupByName.set(name, g); order.push(g); }
                groupByName.get(name)!.tariffs.push(tariff);
            }
            const tariff = tariffMap.get(tid)!;
            const sid = Number(r.season_id);
            if (!seasonMap.has(sid)) {
                const season: TariffSeason = {
                    id: sid, tariff_id: tid, name: (r.season_name as string | null) ?? null,
                    from_month: Number(r.from_month), from_day: Number(r.from_day),
                    to_month: Number(r.to_month), to_day: Number(r.to_day),
                    buy_rate: Number(r.season_buy_rate), sell_rate: Number(r.season_sell_rate), schedules: [],
                };
                seasonMap.set(sid, season);
                tariff.seasons!.push(season);
            }
            if (r.schedule_id != null) {
                seasonMap.get(sid)!.schedules!.push({
                    id: Number(r.schedule_id), season_id: sid, name: (r.schedule_name as string | null) ?? null,
                    buy_rate: r.schedule_buy_rate != null ? Number(r.schedule_buy_rate) : null,
                    sell_rate: r.schedule_sell_rate != null ? Number(r.schedule_sell_rate) : null,
                    from_day_of_week: r.from_day_of_week as number | null, from_hour: r.from_hour as number | null,
                    from_minute: r.from_minute as number | null, to_day_of_week: r.to_day_of_week as number | null,
                    to_hour: r.to_hour as number | null, to_minute: r.to_minute as number | null,
                });
            }
        }
        return order;
    }
```

Add `TariffSeason` to the existing `db` import at the top of `comparison-tariff-repo.ts` (it currently imports `{ pool }`):

```ts
import { pool, Tariff, TariffSeason } from '../db';
```

- [ ] **Step 4: Wire the page's grid columns to full structures**

In `src/app/site/[id]/page.tsx`, replace the comparison-column build (around [page.tsx:337](../../cmd/next-app/src/app/site/[id]/page.tsx)) so columns come from full structures via `comparisonStructTimeline`. First, near the existing `comparisonPlans` load (line ~296), also load structures:

```ts
        const comparisonStructures = await new ComparisonTariffRepo().listComparisonStructures(finalSite.id);
```

Then update the `gridColumns` build to use them (replacing the `...comparisonPlans.map(...)` block):

```ts
        const gridColumns: GridColumnInput[] = [
            { name: meteredPlanName, type: 'metered', isMetered: true, timeline: meteredTl },
            ...comparisonStructures.map(g => ({
                name: g.name,
                // g.tariffs is ordered newest effective_from first, so [0] is the current version.
                type: classifyTariff(g.tariffs[0]),
                isMetered: false,
                timeline: comparisonStructTimeline(g.tariffs, finalSite.timezone),
            })),
        ];
```

`classifyTariff` returns `'fixed' | 'tou'`, which is assignable to `GridColumnInput.type` (`ColumnType = 'metered' | 'fixed' | 'tou'`, already defined in `extended-grid.ts`) — no widening needed.

Update the imports in `page.tsx`: add `comparisonStructTimeline` to the `plan-timeline` import and ensure `classifyTariff` is imported from `@/lib/roi/classify-tariff`. Remove the now-unused `comparisonPlanTimeline` import.

- [ ] **Step 5: Run the tests + typecheck**

Run: `npm test -- src/lib/roi/plan-timeline && npx tsc --noEmit`
Expected: PASS. Resolve any remaining references to the deleted `comparisonPlanTimeline`.

- [ ] **Step 6: Commit**

```bash
git add cmd/next-app/src/lib/roi/plan-timeline.ts cmd/next-app/src/lib/roi/plan-timeline.test.ts cmd/next-app/src/lib/roi/comparison-tariff-repo.ts cmd/next-app/src/app/site/\[id\]/page.tsx
git commit -m "feat(roi): price comparison grid columns from real structure (TOU date-resolved)"
```

---

## Task 7: Final verification

- [ ] **Step 1: Full test suite**

Run: `cd cmd/next-app && npm test`
Expected: all pass — including `tou-coverage`, the new `comparison-tariff-repo` methods, `comparison-tariff/route`, and `plan-timeline`.

- [ ] **Step 2: Build + lint + typecheck**

Run: `cd cmd/next-app && npm run build && npm run lint && npx tsc --noEmit`
Expected: all pass. In particular, confirm no remaining import of the retired `appendFixedComparison` / `comparisonPlanTimeline` / rate-only `editComparisonVersion`.

- [ ] **Step 3: Confirm the `reporting_only` guard on every write**

Run: `cd cmd/next-app && grep -n "reporting_only" src/lib/roi/comparison-tariff-repo.ts`
Expected: every `INSERT`/`UPDATE`/`DELETE`/rename write path carries the guard (reads — `getPlanStructure` — intentionally do not, so the metered plan can seed a clone).

- [ ] **Step 4: Commit any fixups**

```bash
git add -A && git commit -m "test(roi): schedule-structures phase A green" || echo "nothing to commit"
```

---

## Self-review notes (for the implementer)

- **Coverage parity.** `tou-coverage` reimplements the day/hour/season matching of `schedule.ts` (it cannot call the private matchers). Keep the two in sync: the sort (narrower day-range first, then time-specific before all-day), the `[from, to)` hour convention, and the midnight-crossing union must match, or the heatmap/validation will disagree with pricing. The Sat-Sun-override test is the canary.
- **Canonicalization is server-authoritative.** `saveComparisonStructure` canonicalizes before persisting, so the stored shape always matches the rate-based kind even if a client posts an un-collapsed same-rate structure.
- **`reporting_only` everywhere on writes.** Mirrors the manager-CRUD safety invariant: `EnergyData.tariff_id → Tariff` is `ON DELETE CASCADE`, so the metered lineage must never be written through this path. Reads (`getPlanStructure`) are deliberately unguarded so the metered plan can seed a clone — reads are safe.
- **Fixed is the degenerate schedule.** A one-season/one-24-7-window structure round-trips as Fixed, prices flat (Task 6 regression test), and lists with `kind: 'fixed'`. No Fixed-specific code path remains.
- **Phase B (the editor) consumes this API unchanged.** `GET` seeds/edits; `POST`/`PATCH` persist; the listing's `kind` drives the badge; coverage 400s surface as inline errors. Building the editor requires no further repo/route change.
- **Deferred (unchanged):** historical metered entry, the ROI-summary fixed baseline (`resolve-fixed-baseline.ts` stays flat), sub-hour windows.
```

