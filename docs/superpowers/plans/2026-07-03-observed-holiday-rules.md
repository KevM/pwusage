# Observed Holiday Rules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make TOU schedule resolution treat *observed* holidays correctly (July 4, 2026 falls on a Saturday, so Friday July 3 is the observed holiday and should get weekend/off-peak rates), by replacing the hardcoded, untested `isHoliday` conditionals with a data-driven, fully tested holiday-rules module — plus a scoped repair script for rows already persisted with the wrong schedule id.

**Architecture:** New pure module `src/lib/holidays.ts`: a holiday is *data* (a fixed date with a weekend-observance policy, or an nth-weekday rule), and `isObservedHoliday(year, month, day, rules)` evaluates them with UTC date arithmetic so Saturday→Friday and Sunday→Monday shifts work across month/year boundaries for free. `Schedule` delegates to it (optional constructor param, defaulting to the US TOU set), which fixes read-time display, import-time `tariff_schedule_id` assignment, and load-timing in one place. A new `scripts/fix-tariff-schedule-range.ts` recomputes stored schedule ids for a bounded date range to repair rows persisted before the fix.

**Tech Stack:** Next.js app in `cmd/next-app`, Vitest, `npx tsx` for scripts.

---

## Context for a zero-context engineer

- All app code lives under `cmd/next-app`; run npm commands from there.
- **The bug:** `cmd/next-app/src/lib/schedule.ts` `isHoliday()` (~line 128) hardcodes US holidays and only shifts **Sunday → Monday** (e.g. checks "is today Jul 5 and was Jul 4 a Sunday"). There is no **Saturday → Friday** shift, so Friday 2026-07-03 (observed Independence Day — Jul 4 is a Saturday) is treated as a normal weekday and billed On-Peak. There are **zero tests** mentioning holidays, which is why this survived.
- **How holidays affect rates:** `Schedule.getTariffPeriodByComponents` sets `effectiveWeekday = 6` (Saturday) when the date is a holiday, so weekend schedules match. Keep that mechanism — this plan only replaces *which dates count as holidays*.
- **Why fixing `Schedule` fixes everything:** all three consumers resolve TOU through the same code path — read-time aggregation of today's rows (`energy-repo.ts` pass 2, `tou-aggregation.ts`), import-time `tariff_schedule_id` assignment (`importer/index.ts` → `transformEnergyPoints`), and load timing. No other call sites hardcode holidays (verified: `isHoliday` is private; `getTariffPeriodByComponents` has no callers outside `schedule.ts`).
- **The data-repair problem:** 5-minute rows persist `tariff_schedule_id` at import time. Rows imported during the misclassified window (2026-07-03 before the fix deploys) carry On-Peak schedule ids. For *today* the UI stays correct because today's rows are re-resolved at read time (energy-repo pass 2), but once the day rolls over, aggregation uses the stored ids (pass 1) — so the stored ids must be repaired. Within the 365-day retention window, 2026-07-03 is the only Saturday/Friday-observed holiday, so the repair is a single day. `scripts/backfill-tariff-schedule.ts` shows the recompute pattern; we add a *range-scoped* variant because recomputing all history with current-version tariffs would mis-assign rows that belong to older tariff versions (append-only tariff versioning, PR #63).
- **Known limitation to preserve, not fix:** the app applies US holidays to every site, including any future non-US ones (the app already handles GBP/EUR currencies). That is pre-existing behavior. The module's rule-set parameter is the seam where per-utility calendars plug in later — do not build that now (YAGNI).
- **Weekday math note:** the calendar weekday of a *calendar date* is timezone-independent, so `new Date(Date.UTC(y, m-1, d)).getUTCDay()` is correct and server-timezone-proof. `Schedule` already converts wall-clock timestamps to site-local Y/M/D via `Intl.DateTimeFormat` before any holiday check.
- **Test conventions:** co-located Vitest files; `schedule.test.ts` builds a realistic "Harrison" We Energies tariff via `makeHarrisonTariff()` (Tesla day-of-week encoding 0=Mon…6=Sun; weekend all-day Off-Peak schedule has `from_day_of_week: 5, to_day_of_week: 6, from_hour: null`).
- **Ground rules:** do not `git push` — the user pushes. Git commands without a leading `cd`. Never run scripts with DML against the `.env` `DATABASE_URL` (live-ish dev DB) unless a task explicitly says how. `npm run lint`, `npm run build`, `npm test` must pass.

## File Structure

- Create: `cmd/next-app/src/lib/holidays.ts` — rule types, US default set, `isObservedHoliday`
- Create: `cmd/next-app/src/lib/holidays.test.ts`
- Modify: `cmd/next-app/src/lib/schedule.ts` — delete private `isHoliday`, delegate to the module
- Modify: `cmd/next-app/src/lib/schedule.test.ts` — observed-holiday integration tests
- Create: `cmd/next-app/scripts/fix-tariff-schedule-range.ts` — scoped stored-id repair

---

### Task 1: Branch

- [ ] **Step 1: Branch off up-to-date main**

```bash
git -C /Users/kevm/github/pwusage checkout main
git -C /Users/kevm/github/pwusage pull
git -C /Users/kevm/github/pwusage checkout -b fix/observed-holidays
cd /Users/kevm/github/pwusage/cmd/next-app && npm install
```

---

### Task 2: The holidays module

**Files:**
- Create: `cmd/next-app/src/lib/holidays.ts`
- Create: `cmd/next-app/src/lib/holidays.test.ts`

- [ ] **Step 1: Write the failing tests** — create `cmd/next-app/src/lib/holidays.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { isObservedHoliday, US_TOU_HOLIDAYS } from './holidays';

describe('isObservedHoliday', () => {
    it('marks fixed holidays on their actual date', () => {
        expect(isObservedHoliday(2026, 1, 1)).toBe(true);   // New Year's Day (Thu)
        expect(isObservedHoliday(2026, 7, 4)).toBe(true);   // Independence Day (Sat)
        expect(isObservedHoliday(2026, 12, 25)).toBe(true); // Christmas (Fri)
    });

    it('observes a Saturday holiday on the preceding Friday (the 2026-07-03 bug)', () => {
        // Jul 4 2026 is a Saturday -> Friday Jul 3 is the observed holiday.
        expect(isObservedHoliday(2026, 7, 3)).toBe(true);
        // The Thursday before is NOT a holiday.
        expect(isObservedHoliday(2026, 7, 2)).toBe(false);
    });

    it('observes a Sunday holiday on the following Monday', () => {
        // Jul 4 2027 is a Sunday -> Monday Jul 5 2027 observed.
        expect(isObservedHoliday(2027, 7, 5)).toBe(true);
        expect(isObservedHoliday(2027, 7, 6)).toBe(false);
    });

    it('handles the cross-year shift: New Year 2028 (Saturday) observed Friday Dec 31 2027', () => {
        expect(isObservedHoliday(2027, 12, 31)).toBe(true);
        expect(isObservedHoliday(2028, 1, 1)).toBe(true); // actual date still counts
    });

    it('does not shift when the holiday falls on a weekday', () => {
        // Jul 4 2025 is a Friday: Jul 3 (Thu) and Jul 5 (Sat) are not observed.
        expect(isObservedHoliday(2025, 7, 3)).toBe(false);
        expect(isObservedHoliday(2025, 7, 5)).toBe(false);
        expect(isObservedHoliday(2025, 7, 4)).toBe(true);
    });

    it('computes floating holidays', () => {
        expect(isObservedHoliday(2026, 5, 25)).toBe(true);   // Memorial Day: last Mon of May 2026
        expect(isObservedHoliday(2026, 5, 18)).toBe(false);  // a Monday, but not the last
        expect(isObservedHoliday(2026, 9, 7)).toBe(true);    // Labor Day: first Mon of Sep 2026
        expect(isObservedHoliday(2026, 11, 26)).toBe(true);  // Thanksgiving: 4th Thu of Nov 2026
        expect(isObservedHoliday(2026, 11, 19)).toBe(false); // 3rd Thu
    });

    it('returns false for ordinary days', () => {
        expect(isObservedHoliday(2026, 3, 11)).toBe(false);
        expect(isObservedHoliday(2026, 8, 14)).toBe(false);
    });

    it('exposes the default US rule set for callers that need to customize', () => {
        expect(US_TOU_HOLIDAYS.length).toBe(6);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/kevm/github/pwusage/cmd/next-app && npx vitest run src/lib/holidays.test.ts`
Expected: FAIL — module `./holidays` does not exist.

- [ ] **Step 3: Implement** — create `cmd/next-app/src/lib/holidays.ts`:

```ts
/**
 * Data-driven utility-holiday calendar for TOU schedule resolution.
 *
 * Utilities bill designated holidays at weekend/off-peak rates. When a fixed
 * holiday falls on a weekend it is *observed* on the adjacent weekday
 * (Saturday -> preceding Friday, Sunday -> following Monday), and that
 * observed day gets holiday rates. Holidays are data, not code, so a
 * per-utility calendar can be swapped in later via the `rules` parameter.
 */

export type HolidayRule =
    | {
        kind: 'fixed';
        month: number; // 1-12
        day: number;   // 1-31
        /** Shift observance to Friday/Monday when the date falls on Sat/Sun. */
        shiftWeekendObservance: boolean;
    }
    | {
        kind: 'nth-weekday';
        month: number;   // 1-12
        weekday: number; // 0=Sun ... 6=Sat (JS Date convention)
        nth: number;     // 1-4, or -1 for the last occurrence in the month
    };

/** The standard six US utility TOU holidays (e.g. We Energies). */
export const US_TOU_HOLIDAYS: HolidayRule[] = [
    { kind: 'fixed', month: 1, day: 1, shiftWeekendObservance: true },    // New Year's Day
    { kind: 'nth-weekday', month: 5, weekday: 1, nth: -1 },               // Memorial Day
    { kind: 'fixed', month: 7, day: 4, shiftWeekendObservance: true },    // Independence Day
    { kind: 'nth-weekday', month: 9, weekday: 1, nth: 1 },                // Labor Day
    { kind: 'nth-weekday', month: 11, weekday: 4, nth: 4 },               // Thanksgiving
    { kind: 'fixed', month: 12, day: 25, shiftWeekendObservance: true },  // Christmas
];

const DAY_MS = 24 * 60 * 60 * 1000;

// The calendar weekday of a calendar date is timezone-independent; UTC
// arithmetic makes month/year wrap (Dec 31 <-> Jan 1) fall out for free.
function utcMs(year: number, month: number, day: number): number {
    return Date.UTC(year, month - 1, day);
}

function matchesFixedDate(ms: number, rule: { month: number; day: number }): boolean {
    const d = new Date(ms);
    return d.getUTCMonth() + 1 === rule.month && d.getUTCDate() === rule.day;
}

/**
 * True when the site-local calendar date (year, month, day) should be billed
 * as a holiday: either an actual holiday, or the observed weekday for a fixed
 * holiday that falls on the adjacent weekend day.
 */
export function isObservedHoliday(
    year: number,
    month: number,
    day: number,
    rules: HolidayRule[] = US_TOU_HOLIDAYS
): boolean {
    const ms = utcMs(year, month, day);
    const weekday = new Date(ms).getUTCDay();

    for (const rule of rules) {
        if (rule.kind === 'fixed') {
            if (matchesFixedDate(ms, rule)) return true;
            if (rule.shiftWeekendObservance) {
                // Friday observing a Saturday holiday (incl. Dec 31 for a Sat Jan 1).
                if (weekday === 5 && matchesFixedDate(ms + DAY_MS, rule)
                    && new Date(ms + DAY_MS).getUTCDay() === 6) return true;
                // Monday observing a Sunday holiday.
                if (weekday === 1 && matchesFixedDate(ms - DAY_MS, rule)
                    && new Date(ms - DAY_MS).getUTCDay() === 0) return true;
            }
        } else {
            if (month !== rule.month || weekday !== rule.weekday) continue;
            if (rule.nth === -1) {
                // Last occurrence: no same-weekday date remains in the month.
                const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
                if (day + 7 > daysInMonth) return true;
            } else if (Math.ceil(day / 7) === rule.nth) {
                return true;
            }
        }
    }
    return false;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/holidays.test.ts`
Expected: PASS — all cases including 2026-07-03 and the 2027→2028 cross-year shift.

- [ ] **Step 5: Commit**

```bash
git -C /Users/kevm/github/pwusage add cmd/next-app/src/lib/holidays.ts cmd/next-app/src/lib/holidays.test.ts
git -C /Users/kevm/github/pwusage commit -m "feat(holidays): data-driven holiday rules with weekend observance shifts"
```

---

### Task 3: Wire into Schedule

**Files:**
- Modify: `cmd/next-app/src/lib/schedule.ts`
- Test: `cmd/next-app/src/lib/schedule.test.ts`

- [ ] **Step 1: Write the failing integration tests** — append to `cmd/next-app/src/lib/schedule.test.ts`, reusing the file's existing `makeHarrisonTariff()` helper and `HARRISON_TIMEZONE` constant:

```ts
describe('Schedule observed holidays', () => {
    it('bills observed Independence Day (Fri 2026-07-03, Jul 4 is a Saturday) as weekend Off-Peak', () => {
        const schedule = new Schedule(makeHarrisonTariff(), HARRISON_TIMEZONE);
        // 14:00 Central on Friday Jul 3 2026 — normally On-Peak (08:00-20:00 weekday).
        const period = schedule.getTariffPeriod(new Date('2026-07-03T19:00:00Z'));

        expect(period).not.toBeNull();
        expect(period!.schedule.name).toBe('Off-Peak');
        // Must be the all-day weekend schedule, not the overnight window.
        expect(period!.schedule.from_hour).toBeNull();
    });

    it('bills an ordinary summer Friday afternoon as On-Peak', () => {
        const schedule = new Schedule(makeHarrisonTariff(), HARRISON_TIMEZONE);
        // 14:00 Central on Friday Jul 10 2026.
        const period = schedule.getTariffPeriod(new Date('2026-07-10T19:00:00Z'));

        expect(period).not.toBeNull();
        expect(period!.schedule.name).toBe('On-Peak');
    });

    it('bills a Monday observing a Sunday holiday as weekend Off-Peak (Jul 5 2027)', () => {
        const schedule = new Schedule(makeHarrisonTariff(), HARRISON_TIMEZONE);
        const period = schedule.getTariffPeriod(new Date('2027-07-05T19:00:00Z'));

        expect(period).not.toBeNull();
        expect(period!.schedule.name).toBe('Off-Peak');
    });
});
```

Note: if `makeHarrisonTariff` / `HARRISON_TIMEZONE` are declared below the existing describes, that's fine — hoisting is irrelevant since they're function/const declarations at module scope; just place the new describe at the end of the file.

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx vitest run src/lib/schedule.test.ts`
Expected: the 2026-07-03 test FAILS (gets On-Peak — the bug). The ordinary-Friday test passes; the Jul-5-2027 test passes (Sunday→Monday already works today). All pre-existing tests pass.

- [ ] **Step 3: Implement** — in `cmd/next-app/src/lib/schedule.ts`:

1. Add the import at the top:

```ts
import { isObservedHoliday, HolidayRule } from './holidays';
```

2. Add an optional constructor parameter (keep the two-arg signature working):

```ts
    private holidayRules?: HolidayRule[];

    constructor(tariffs: Tariff[], timeZone: string, holidayRules?: HolidayRule[]) {
        this.tariffs = tariffs;
        this.timeZone = timeZone;
        this.holidayRules = holidayRules;
        // ... existing formatter setup unchanged
    }
```

3. In `getTariffPeriodByComponents`, replace:

```ts
        if (year) {
            if (this.isHoliday(month, day, year)) {
                effectiveWeekday = 6; // Treat as Saturday (Weekend)
            }
        }
```

with:

```ts
        if (year) {
            if (isObservedHoliday(year, month, day, this.holidayRules)) {
                effectiveWeekday = 6; // Treat as Saturday (Weekend)
            }
        }
```

(Passing `this.holidayRules` while it is `undefined` is correct: a default parameter kicks in on `undefined`, so uninjected Schedules get `US_TOU_HOLIDAYS` and tests can inject custom rules.)

4. Delete the entire private `isHoliday(month, day, year)` method (~lines 128-180). Nothing else references it (it is private and only called from the block replaced above).

- [ ] **Step 4: Run the schedule and downstream test files**

Run: `npx vitest run src/lib/schedule.test.ts src/lib/energy-repo.test.ts src/lib/tou-aggregation.test.ts src/lib/load-timing.test.ts src/lib/importer.test.ts`
Expected: PASS. If any pre-existing test used a date that is now correctly classified as an observed holiday (e.g. a fixture on Jul 3 2026 or Dec 31 2027), the test's expectation was encoding the bug — update the fixture to a non-holiday date rather than weakening the holiday logic, and say so in the commit message.

- [ ] **Step 5: Commit**

```bash
git -C /Users/kevm/github/pwusage add cmd/next-app/src/lib/schedule.ts cmd/next-app/src/lib/schedule.test.ts
git -C /Users/kevm/github/pwusage commit -m "fix(schedule): observe Saturday holidays on Friday via holiday-rules module"
```

---

### Task 4: Scoped repair script for stored schedule ids

Rows imported while the bug was live carry On-Peak `tariff_schedule_id` values for observed-holiday timestamps. Today's rows self-correct at read time until midnight; after that, aggregation trusts the stored ids. Within 365-day retention only 2026-07-03 is affected.

**Files:**
- Create: `cmd/next-app/scripts/fix-tariff-schedule-range.ts` (modeled on the existing `scripts/backfill-tariff-schedule.ts`, but bounded by a timestamp range)

- [ ] **Step 1: Create the script**

```ts
import 'dotenv/config';
import { pool } from '../src/lib/db';
import { SiteRepo } from '../src/lib/site-repo';
import { Schedule } from '../src/lib/schedule';

/**
 * Recompute EnergyData.tariff_schedule_id for rows in [start, end) using the
 * current read-time Schedule (including observed-holiday handling).
 *
 * Usage:
 *   npx tsx scripts/fix-tariff-schedule-range.ts --start 2026-07-03 --end 2026-07-04 [--site <siteId>] [--dry-run]
 *
 * IMPORTANT: keep the range narrow and recent. The Schedule is built from the
 * *current* tariff version; recomputing rows that belong to an older tariff
 * version (append-only tariff versioning) would mis-assign them. Only run this
 * over dates whose rows were imported under the current tariff — e.g. the
 * observed-holiday days misclassified before the fix deployed.
 */

function arg(name: string): string | undefined {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
    const startArg = arg('start');
    const endArg = arg('end');
    const siteFilter = arg('site');
    const dryRun = process.argv.includes('--dry-run');

    if (!startArg || !endArg) {
        console.error('Usage: npx tsx scripts/fix-tariff-schedule-range.ts --start YYYY-MM-DD --end YYYY-MM-DD [--site <siteId>] [--dry-run]');
        process.exit(1);
    }
    const start = new Date(`${startArg}T00:00:00Z`);
    const end = new Date(`${endArg}T00:00:00Z`);

    const repo = new SiteRepo();
    const sitesRes = siteFilter
        ? { rows: [{ site_id: siteFilter }] }
        : await pool.query('SELECT DISTINCT site_id FROM "EnergyData" WHERE timestamp >= $1 AND timestamp < $2', [start, end]);

    for (const { site_id: siteId } of sitesRes.rows) {
        const site = await repo.getSite(siteId);
        if (!site) {
            console.log(`[${siteId}] site not found, skipping`);
            continue;
        }
        const schedule = new Schedule(site.tariffs, site.timezone);

        const rowsRes = await pool.query(
            'SELECT id, timestamp, tariff_schedule_id FROM "EnergyData" WHERE site_id = $1 AND timestamp >= $2 AND timestamp < $3',
            [siteId, start, end]
        );

        let changed = 0;
        for (const row of rowsRes.rows) {
            const period = schedule.getTariffPeriod(new Date(row.timestamp));
            const newId = period && Number(period.schedule.id) >= 0 ? Number(period.schedule.id) : null;
            const oldId = row.tariff_schedule_id == null ? null : Number(row.tariff_schedule_id);
            if (newId === oldId) continue;
            changed++;
            if (dryRun) {
                console.log(`[${siteId}] would update row ${row.id} (${new Date(row.timestamp).toISOString()}): ${oldId} -> ${newId}`);
            } else {
                await pool.query('UPDATE "EnergyData" SET tariff_schedule_id = $1 WHERE id = $2', [newId, row.id]);
            }
        }
        console.log(`[${siteId}] rows=${rowsRes.rows.length} ${dryRun ? 'wouldChange' : 'changed'}=${changed}`);
    }
    await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Type-check the script**

Run: `npx tsc --noEmit -p tsconfig.json` (or `npm run build` if the scripts dir isn't in the tsconfig — in that case run `npx tsx --check scripts/fix-tariff-schedule-range.ts` to at least parse it).
Expected: no errors.

- [ ] **Step 3: Dry-run against the dev database (read-only mode)**

The dev DB is a copy of prod, so this previews exactly what the prod repair will do:

```bash
cd /Users/kevm/github/pwusage/cmd/next-app && npx tsx scripts/fix-tariff-schedule-range.ts --start 2026-07-03 --end 2026-07-04 --dry-run
```

Expected: per-site row counts, with `wouldChange > 0` on sites whose tariffs have weekend/holiday Off-Peak schedules (the misclassified On-Peak morning rows), listing `oldId -> newId` transitions. **Do not run without `--dry-run` against the dev DB** — include the dry-run output in your final report instead. The user runs the real repair against prod after the fix deploys (data keeps accruing until then, so it must be re-run post-deploy anyway).

- [ ] **Step 4: Commit**

```bash
git -C /Users/kevm/github/pwusage add cmd/next-app/scripts/fix-tariff-schedule-range.ts
git -C /Users/kevm/github/pwusage commit -m "feat(scripts): scoped tariff_schedule_id repair for misclassified holiday rows"
```

---

### Task 5: Full verification

- [ ] **Step 1: Full test suite** — Run: `cd /Users/kevm/github/pwusage/cmd/next-app && npm test -- --run` — Expected: all pass.
- [ ] **Step 2: Lint** — Run: `npm run lint` — Expected: exit 0.
- [ ] **Step 3: Build** — Run: `npm run build` — Expected: completes without errors.
- [ ] **Step 4: Report — do NOT push.** Include: the dry-run output from Task 4, and the post-deploy instruction for the user — after this lands on main, run against prod:

```bash
npx tsx scripts/fix-tariff-schedule-range.ts --start 2026-07-03 --end 2026-07-04
```

(with prod `DATABASE_URL`), which repairs the rows imported while the bug was live. Also note the deliberate non-goals: per-utility holiday calendars (the `rules` parameter is the seam; US-default applies to all sites, same as before) and any UI for holiday visibility.
