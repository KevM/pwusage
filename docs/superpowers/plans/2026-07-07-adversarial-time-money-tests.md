# Adversarial Time-and-Money Test Hunt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the adversarially-identified test gaps in the date/TOU/billing math — fix two suspected real bugs (billing-cycle short-month anchor, wrapped day-of-week ranges) and one crash path (zero-tariff aggregation), and pin correct DST/holiday/season-boundary behavior with regression tests so the next date bug can't survive silently the way the Saturday-holiday bug did.

**Architecture:** Pure-TS unit tests co-located with the modules under test (`schedule.ts`, `billing-cycle.ts`, `holidays.ts`, `date-utils.ts`, `importer/import-planner.ts`, `tou-aggregation.ts`). Tasks 1, 2, and 7 are TDD bug fixes: the test is written to the *correct* behavior, expected to FAIL, then a minimal fix makes it pass. Tasks 3–6 are probe tests expected to PASS; they exist to pin behavior that is currently correct but untested.

**Tech Stack:** Next.js app in `cmd/next-app`, Vitest, TypeScript.

---

## Context for a zero-context engineer

- All app code lives under `cmd/next-app`; run all npm commands from that directory. Test files are co-located (`foo.test.ts` next to `foo.ts`).
- **How TOU resolution works:** `src/lib/schedule.ts` `Schedule.getTariffPeriod(Date)` converts a UTC instant to site-local components via a memoized `Intl.DateTimeFormat` (15-minute buckets), then walks `Tariff → TariffSeason → TariffSchedule` to find the matching rate window. Day-of-week uses **Tesla encoding: 0=Mon … 6=Sun** (JS `getDay()` is remapped by `toTeslaWeekday`). Hours match with midnight-wrap support (`from_hour 20 → to_hour 8`). Holidays (via `src/lib/holidays.ts` `isObservedHoliday`) force `effectiveWeekday = 6` (Saturday) so weekend schedules apply.
- **How billing cycles work:** `src/lib/billing-cycle.ts` `getCurrentCycleStart(billingStartDay, now, timeZone)` returns the UTC instant of site-local midnight on the day the current cycle began, using the Temporal polyfill. Its docstring declares clamp semantics for short months: a day-31 anchor in February starts the cycle on Feb 28/29.
- **How money is computed:** `src/lib/tou-aggregation.ts` `aggregateUsage` buckets energy rows by (tariff, TOU name, rates) and prices the **net** grid energy per bucket (`net >= 0` → buy rate, else sell rate). Energy values are Wh per 5-minute sample; `wattsToKilowatts(x) = x/1000` converts summed Wh → kWh.
- **How import windows are planned:** `src/lib/importer/import-planner.ts` `auditDays`/`planImport` walk day windows between site-local midnights. Day stepping uses `getSiteMidnight(midnight + 30h)` — the 30-hour jump is deliberately DST-safe (a 23-, 24-, or 25-hour day always lands in the next local day).
- **Triage protocol for probe tests (Tasks 3–6):** each test encodes behavior derived from first principles (IANA tzdata facts, documented clamp semantics). Expected outcome per step is stated. If a probe test FAILS where the plan says PASS, you have found a real bug: stop, invoke `superpowers:systematic-debugging`, fix the code minimally (never bend the test expectation to match broken behavior), and record it in the results doc (Task 8).
- **Weekday facts used by the tests** (verify with the node one-liners given in each task before trusting them): Jul 12 2026 = Sunday, Jul 15 2026 = Wednesday, Jul 17 2026 = Friday, Dec 25 2027 = Saturday, Jan 1 2034 = Sunday. US DST 2026 in America/Chicago: spring-forward Sun Mar 8 (02:00 CST → 03:00 CDT), fall-back Sun Nov 1 (02:00 CDT → 01:00 CST). CST = UTC-6, CDT = UTC-5.
- **Why there is no tariff-versioning task:** the append-only tariff-versioning read path was audited and is already covered — `tou-aggregation.test.ts` has "resolves prior-cycle rows tagged with an older tariff version via historical maps" and "still reports Unknown/$0 without historical maps". No gap found there; do not add redundant tests.
- **Ground rules:** do NOT `git push` — the user pushes. Run git commands without a leading `cd` (use `git -C` if needed; npm commands run from `cmd/next-app`). `npm run lint`, `npm run build`, and `npm test` must all pass before finishing. Never run scripts against the `.env` `DATABASE_URL` — everything in this plan is pure unit-test work, no DB needed.

## Findings documented but deliberately NOT changed

Do not "fix" these while executing; they are known and accepted. List them in the results doc (Task 8) as confirmed-and-left-alone:

1. **Net-metering cost semantics** (`tou-aggregation.ts` cost loop): imports and exports are netted *within a bucket* before pricing. Pinned by the existing test "calculates credit correctly for negative net grid usage". Intentional.
2. **`Math.abs()` on rates** (`tou-aggregation.ts` cost loop): a negative `sell_rate` (export penalty, seen in some AU tariffs) would be inverted into a credit. No negative-rate tariffs exist in this product's data today; flag, don't fix.
3. **Pass-1 midpoint fallback** (`tou-aggregation.ts` ~line 103): rows with NULL `tariff_schedule_id` resolve TOU at `row.day + 12h` = UTC noon, which is early morning in US zones. Only affects legacy rows; best-effort by design.
4. **`date_trunc('day', timestamp)`** in `energy-repo.ts` `getCycleAggregates` groups prior-cycle aggregates by UTC day, not site-local day. TOU correctness doesn't depend on it (`tariff_schedule_id` is stored per-row); SQL-side, not reachable from unit tests.
5. **Same-month wrapped seasons** (`schedule.ts` `matchSeason`): `from_month === to_month && from_day > to_day` (e.g. "Jun 15 → next Jun 10") never matches. No evidence Tesla emits this encoding.

## File Structure

- Modify: `cmd/next-app/src/lib/billing-cycle.ts` — clamp anchor day to month length (Task 1)
- Modify: `cmd/next-app/src/lib/billing-cycle.test.ts` — clamped-anchor tests (Task 1)
- Modify: `cmd/next-app/src/lib/schedule.ts` — wrap-aware `matchDayOfWeek` + sort comparator (Task 2)
- Modify: `cmd/next-app/src/lib/schedule.test.ts` — wrapped day-range tests (Task 2), DST + season-boundary tests (Task 3)
- Modify: `cmd/next-app/src/lib/holidays.test.ts` — Christmas-Saturday and New-Year-Sunday tests (Task 4)
- Modify: `cmd/next-app/src/lib/date-utils.test.ts` — nonexistent-midnight test (Task 5)
- Modify: `cmd/next-app/src/lib/importer/import-planner.test.ts` — DST-day window tests (Task 6)
- Modify: `cmd/next-app/src/lib/tou-aggregation.ts` — zero-tariff guard (Task 7)
- Modify: `cmd/next-app/src/lib/tou-aggregation.test.ts` — zero-tariff test (Task 7)
- Create: `docs/superpowers/plans/2026-07-07-adversarial-time-money-tests-RESULTS.md` — outcome log (Task 8)

### Task 0: Branch setup

- [ ] **Step 1: Create a working branch from main**

```bash
git -C /Users/kevm/github/pwusage checkout main
git -C /Users/kevm/github/pwusage checkout -b fix/time-money-adversarial-tests
```

- [ ] **Step 2: Confirm the suite is green before starting**

Run (from `cmd/next-app`): `npm test`
Expected: all tests pass. If not, stop and report — do not build on a red base.

---

### Task 1: Billing cycle starts late in short months (suspected real bug)

**Files:**
- Modify: `cmd/next-app/src/lib/billing-cycle.ts`
- Test: `cmd/next-app/src/lib/billing-cycle.test.ts`

**The bug:** `getCurrentCycleStart` compares `zonedNow.day < billingStartDay` using the *unclamped* anchor. On the last day of a short month (Apr 30 with anchor 31), `30 < 31` sends it to the previous month (Mar 31) — but per the module's own documented clamp semantics, the April cycle starts Apr 30, and Apr 30 belongs to it. Every bill total shown on the clamped start day covers the wrong window.

- [ ] **Step 1: Write the failing tests**

Append to `billing-cycle.test.ts` (top-level, after the existing `describe` blocks; imports already present):

```ts
describe('getCurrentCycleStart — clamped anchor day in short months', () => {
    it('starts a new cycle on the clamped anchor day (day 31 on Apr 30)', () => {
        // April has 30 days: a day-31 anchor starts the April cycle on Apr 30
        // (documented constrain semantics). On Apr 30 itself the current cycle
        // is the one beginning that day — not the March 31 cycle.
        const now = new Date(Date.UTC(2026, 3, 30, 12, 0, 0)); // Apr 30 noon UTC
        const start = getCurrentCycleStart(31, now, 'UTC');
        expect(start).toEqual(new Date(Date.UTC(2026, 3, 30, 0, 0, 0)));
    });

    it('starts a new cycle on the clamped anchor day (day 30 on Feb 28, non-leap)', () => {
        const now = new Date(Date.UTC(2026, 1, 28, 12, 0, 0)); // Feb 28 2026 noon UTC
        const start = getCurrentCycleStart(30, now, 'UTC');
        expect(start).toEqual(new Date(Date.UTC(2026, 1, 28, 0, 0, 0)));
    });

    it('the day after a clamped cycle start still belongs to that cycle (Mar 1, anchor 31)', () => {
        // Mar 1 < clamped anchor 31 → previous month; Feb 31 constrains to Feb 28.
        // This pins the behavior the fix must NOT break.
        const now = new Date(Date.UTC(2026, 2, 1, 12, 0, 0)); // Mar 1 2026 noon UTC
        const start = getCurrentCycleStart(31, now, 'UTC');
        expect(start).toEqual(new Date(Date.UTC(2026, 1, 28, 0, 0, 0)));
    });
});
```

- [ ] **Step 2: Run and verify the first two fail, third passes**

Run: `npm test -- src/lib/billing-cycle`
Expected: test 1 FAILS (received Mar 31), test 2 FAILS (received Jan 30), test 3 PASSES.

- [ ] **Step 3: Fix — compare against the clamped anchor**

In `billing-cycle.ts`, replace the month-determination block (currently `let cycleMonth = zonedNow.month; ... if (zonedNow.day < day) {`) with:

```ts
    // Determine which month contains the billing cycle start. Compare against
    // the anchor clamped to this month's length: in a 30-day month a day-31
    // anchor starts the cycle on the 30th, so the 30th belongs to the new
    // cycle, not the previous month's.
    const clampedDay = Math.min(day, zonedNow.daysInMonth);
    let cycleMonth = zonedNow.month;
    let cycleYear = zonedNow.year;
    if (zonedNow.day < clampedDay) {
        cycleMonth -= 1;
        if (cycleMonth < 1) {
            cycleMonth = 12;
            cycleYear -= 1;
        }
    }
```

Leave the final `return getSiteLocalDate(cycleYear, cycleMonth, day);` passing the **unclamped** `day` — `Temporal`'s constrain mode clamps it per whichever month was chosen.

- [ ] **Step 4: Run the file — all pass, including the pre-existing tests**

Run: `npm test -- src/lib/billing-cycle`
Expected: PASS (the existing "preserves short-month overflow" and DST/Auckland tests must still pass — the clamp only changes behavior on days ≥ the clamped anchor in short months).

- [ ] **Step 5: Commit**

```bash
git -C /Users/kevm/github/pwusage add cmd/next-app/src/lib/billing-cycle.ts cmd/next-app/src/lib/billing-cycle.test.ts
git -C /Users/kevm/github/pwusage commit -m "fix(billing): start cycle on clamped anchor day in short months"
```

---

### Task 2: Wrapped day-of-week ranges never match (suspected real bug)

**Files:**
- Modify: `cmd/next-app/src/lib/schedule.ts` (`matchDayOfWeek` ~line 148, sort comparator ~line 97)
- Test: `cmd/next-app/src/lib/schedule.test.ts`

**The bug:** `matchHourOfDay` supports midnight-wrapping hour ranges (`20 → 8`), but `matchDayOfWeek` does not support week-wrapping day ranges: `from_day_of_week: 6, to_day_of_week: 3` (Sun→Thu in Tesla encoding) evaluates `twd >= 6 && twd <= 3`, which is always false. A "Sun–Thu nights" style schedule — expressible in the ScheduleEditor UI and in principle in Tesla tariff JSON — silently never matches, so those rows fall through to other schedules or resolve to `null`/$0. The sort comparator has the twin flaw: `to - from` goes negative for wrapped ranges.

- [ ] **Step 1: Verify the weekday facts**

```bash
node -e "console.log(new Date('2026-07-12T12:00:00Z').getUTCDay(), new Date('2026-07-15T12:00:00Z').getUTCDay(), new Date('2026-07-17T12:00:00Z').getUTCDay())"
```
Expected output: `0 3 5` (Sunday, Wednesday, Friday).

- [ ] **Step 2: Write the failing test**

Append to `schedule.test.ts` (uses the `Tariff` import already at the top of the file):

```ts
describe('Schedule – wrapped day-of-week ranges', () => {
    // Tesla day-of-week encoding: 0=Mon … 6=Sun. "Sunday through Thursday" can
    // only be expressed as from 6 wrapping to 3 — the same way hour windows
    // wrap midnight (20:00 → 08:00).
    function makeWrappedTariff(): Tariff[] {
        return [{
            id: 9,
            site_id: 'wrap_site',
            name: 'Wrap Test',
            updated: new Date('2026-01-01'),
            seasons: [{
                id: 901, tariff_id: 9, name: 'All Year',
                from_month: 1, from_day: 1, to_month: 12, to_day: 31,
                buy_rate: 0.2, sell_rate: 0.1,
                schedules: [{
                    id: 9011, season_id: 901, name: 'Sun-Thu',
                    buy_rate: 0.2, sell_rate: 0.1,
                    from_day_of_week: 6, to_day_of_week: 3, // Sun → Thu (wraps)
                    from_hour: null, from_minute: null,
                    to_hour: null, to_minute: null,
                }],
            }],
        }];
    }

    it('matches days inside a wrapped range (Sunday and Wednesday)', () => {
        const schedule = new Schedule(makeWrappedTariff(), 'UTC');
        // Sun Jul 12 2026 and Wed Jul 15 2026 (neither is a holiday)
        expect(schedule.getTariffPeriod(new Date('2026-07-12T12:00:00Z'))?.schedule.name).toBe('Sun-Thu');
        expect(schedule.getTariffPeriod(new Date('2026-07-15T12:00:00Z'))?.schedule.name).toBe('Sun-Thu');
    });

    it('does not match days outside a wrapped range (Friday)', () => {
        const schedule = new Schedule(makeWrappedTariff(), 'UTC');
        // Fri Jul 17 2026
        expect(schedule.getTariffPeriod(new Date('2026-07-17T12:00:00Z'))).toBeNull();
    });
});
```

- [ ] **Step 3: Run and verify the first test fails**

Run: `npm test -- src/lib/schedule`
Expected: "matches days inside a wrapped range" FAILS (`undefined` ≠ `'Sun-Thu'`); "does not match" passes trivially; all pre-existing tests pass.

- [ ] **Step 4: Fix `matchDayOfWeek` (wrap-aware, mirroring `matchHourOfDay`)**

In `schedule.ts`, replace the both-bounds branch of `matchDayOfWeek`:

```ts
        if (schedule.from_day_of_week !== null && schedule.to_day_of_week !== null) {
            if (schedule.from_day_of_week <= schedule.to_day_of_week) {
                // Normal range: e.g., Mon–Fri (0–4)
                return twd >= schedule.from_day_of_week && twd <= schedule.to_day_of_week;
            }
            // Week-wrapping range: e.g., Sun–Thu (6→3), mirroring
            // midnight-crossing hour windows.
            return twd >= schedule.from_day_of_week || twd <= schedule.to_day_of_week;
        }
```

- [ ] **Step 5: Fix the sort comparator's range width for wrapped ranges**

In `getTariffPeriodByComponents`, the comparator computes `a.to_day_of_week - a.from_day_of_week`, which is negative for wrapped ranges (sorting them as narrowest). Change both `aDayRange` and `bDayRange` to the mod-7 span — identical values for non-wrapped ranges, true width for wrapped ones:

```ts
                    const aDayRange = (a.from_day_of_week !== null && a.to_day_of_week !== null)
                        ? (a.to_day_of_week - a.from_day_of_week + 7) % 7
                        : 6;
                    const bDayRange = (b.from_day_of_week !== null && b.to_day_of_week !== null)
                        ? (b.to_day_of_week - b.from_day_of_week + 7) % 7
                        : 6;
```

- [ ] **Step 6: Run the whole schedule test file**

Run: `npm test -- src/lib/schedule`
Expected: PASS, including every pre-existing Harrison/Adelaide/holiday test (the comparator change is value-identical for all non-wrapped schedules).

- [ ] **Step 7: Commit**

```bash
git -C /Users/kevm/github/pwusage add cmd/next-app/src/lib/schedule.ts cmd/next-app/src/lib/schedule.test.ts
git -C /Users/kevm/github/pwusage commit -m "fix(schedule): support week-wrapping day-of-week ranges"
```

---

### Task 3: DST transition + season-boundary probes for Schedule (expected PASS)

**Files:**
- Test: `cmd/next-app/src/lib/schedule.test.ts`

These pin local-hour extraction across both 2026 Chicago DST transitions (including the 15-minute memo cache behavior) and the season flip at site-local — not UTC — midnight. US DST transitions always fall on Sundays, and the Harrison tariff is all-day Off-Peak on weekends, so a probe tariff with a rate boundary inside the transition hour is required to make hour errors visible.

- [ ] **Step 1: Write the probe tests**

Append to `schedule.test.ts`:

```ts
describe('Schedule – DST transitions (America/Chicago 2026)', () => {
    // Probe tariff with a boundary at the repeated/skipped hour:
    // "Late-Night" covers local hour 01:00–02:00 every day, all year.
    function makeHourProbeTariff(): Tariff[] {
        return [{
            id: 7,
            site_id: 'dst_site',
            name: 'DST Probe',
            updated: new Date('2026-01-01'),
            seasons: [{
                id: 701, tariff_id: 7, name: 'All Year',
                from_month: 1, from_day: 1, to_month: 12, to_day: 31,
                buy_rate: 0.2, sell_rate: 0.1,
                schedules: [
                    {
                        id: 7011, season_id: 701, name: 'Late-Night',
                        buy_rate: 0.1, sell_rate: 0.05,
                        from_day_of_week: 0, to_day_of_week: 6,
                        from_hour: 1, from_minute: 0,
                        to_hour: 2, to_minute: 0,
                    },
                    {
                        id: 7012, season_id: 701, name: 'Rest',
                        buy_rate: 0.3, sell_rate: 0.1,
                        from_day_of_week: 0, to_day_of_week: 6,
                        from_hour: null, from_minute: null,
                        to_hour: null, to_minute: null,
                    },
                ],
            }],
        }];
    }

    it('fall-back: both occurrences of the repeated 01:30 resolve to local hour 1', () => {
        const schedule = new Schedule(makeHourProbeTariff(), 'America/Chicago');
        // Nov 1 2026: clocks fall back 02:00 CDT → 01:00 CST; 01:00–02:00 happens twice.
        const firstOneThirty = new Date('2026-11-01T06:30:00Z');  // 01:30 CDT (UTC-5)
        const secondOneThirty = new Date('2026-11-01T07:30:00Z'); // 01:30 CST (UTC-6)
        expect(schedule.getTariffPeriod(firstOneThirty)?.schedule.name).toBe('Late-Night');
        expect(schedule.getTariffPeriod(secondOneThirty)?.schedule.name).toBe('Late-Night');
        // 02:30 CST is past the window.
        expect(schedule.getTariffPeriod(new Date('2026-11-01T08:30:00Z'))?.schedule.name).toBe('Rest');
    });

    it('spring-forward: instants adjacent to the skipped 02:xx hour resolve correctly', () => {
        const schedule = new Schedule(makeHourProbeTariff(), 'America/Chicago');
        // Mar 8 2026: clocks jump 02:00 CST → 03:00 CDT; local hour 2 never occurs.
        expect(schedule.getTariffPeriod(new Date('2026-03-08T07:30:00Z'))?.schedule.name).toBe('Late-Night'); // 01:30 CST
        expect(schedule.getTariffPeriod(new Date('2026-03-08T08:30:00Z'))?.schedule.name).toBe('Rest');       // 03:30 CDT
    });

    it('season boundary flips at site-local midnight, not UTC midnight', () => {
        const schedule = new Schedule(makeHarrisonTariff(), HARRISON_TIMEZONE);
        // Sun May 31 2026 23:00 CDT = Jun 1 04:00 UTC — locally still May 31 → Winter.
        const lateMay = schedule.getTariffPeriod(new Date('2026-06-01T04:00:00Z'));
        expect(lateMay?.season.name).toBe('Winter');
        // Mon Jun 1 2026 00:30 CDT = Jun 1 05:30 UTC — Summer, overnight Off-Peak.
        const earlyJune = schedule.getTariffPeriod(new Date('2026-06-01T05:30:00Z'));
        expect(earlyJune?.season.name).toBe('Summer');
        expect(earlyJune?.schedule.name).toBe('Off-Peak');
    });
});
```

- [ ] **Step 2: Run — expected PASS**

Run: `npm test -- src/lib/schedule`
Expected: PASS. If any of these fail, that is a discovered bug in local-time extraction — follow the triage protocol (systematic-debugging, fix code, keep test) and record it in the results doc.

- [ ] **Step 3: Commit**

```bash
git -C /Users/kevm/github/pwusage add cmd/next-app/src/lib/schedule.test.ts
git -C /Users/kevm/github/pwusage commit -m "test(schedule): pin DST-transition hours and site-local season boundary"
```

---

### Task 4: Complete the holiday observance matrix (expected PASS)

**Files:**
- Test: `cmd/next-app/src/lib/holidays.test.ts`

Existing tests cover July 4 Saturday→Friday, July 4 Sunday→Monday, and New Year Saturday→prior-year Friday. Missing: a Saturday **Christmas** (different fixed rule) and a Sunday **New Year** observed forward into January.

- [ ] **Step 1: Verify the weekday facts**

```bash
node -e "console.log(new Date(Date.UTC(2027,11,25)).getUTCDay(), new Date(Date.UTC(2034,0,1)).getUTCDay())"
```
Expected output: `6 0` (Dec 25 2027 = Saturday, Jan 1 2034 = Sunday).

- [ ] **Step 2: Write the tests**

Append inside the existing `describe('isObservedHoliday', ...)` block in `holidays.test.ts`:

```ts
    it('observes a Saturday Christmas on the preceding Friday (2027)', () => {
        // Dec 25 2027 is a Saturday → Friday Dec 24 is the observed holiday.
        expect(isObservedHoliday(2027, 12, 24)).toBe(true);
        expect(isObservedHoliday(2027, 12, 25)).toBe(true);
        expect(isObservedHoliday(2027, 12, 23)).toBe(false);
    });

    it('observes a Sunday New Year on the following Monday (2034)', () => {
        // Jan 1 2034 is a Sunday → Monday Jan 2 is the observed holiday.
        expect(isObservedHoliday(2034, 1, 2)).toBe(true);
        expect(isObservedHoliday(2034, 1, 3)).toBe(false);
    });
```

- [ ] **Step 3: Run — expected PASS**

Run: `npm test -- src/lib/holidays`
Expected: PASS. A failure means an observance-shift bug — triage protocol applies.

- [ ] **Step 4: Commit**

```bash
git -C /Users/kevm/github/pwusage add cmd/next-app/src/lib/holidays.test.ts
git -C /Users/kevm/github/pwusage commit -m "test(holidays): cover Saturday Christmas and Sunday New Year observance"
```

---

### Task 5: Nonexistent site-local midnight (expected PASS)

**Files:**
- Test: `cmd/next-app/src/lib/date-utils.test.ts`

Chile springs forward at local midnight, so on the transition day **00:00 does not exist** — the day starts at 01:00. Every midnight-anchored helper (`getSiteMidnight`, billing cycle starts, import windows) flows through `parseSiteLocalDateToMidnight`; this pins that it resolves to the first existing local time instead of throwing.

- [ ] **Step 1: Verify the transition date against local tzdata**

```bash
node -e "const f=(d)=>new Intl.DateTimeFormat('en-US',{timeZone:'America/Santiago',hour:'numeric',hour12:false}).format(new Date(d)); console.log(f('2026-09-06T03:59:00Z'), f('2026-09-06T04:01:00Z'))"
```
Expected output: `23 1` (23:59 Saturday, then 01:01 Sunday — hour 0 skipped). If you instead see `23 0`, the tzdata transition date differs from this plan's assumption; find the actual first Sunday of September that skips hour 0 (try adjacent Sundays with the same one-liner) and use that date in the test below, adjusting the comment.

- [ ] **Step 2: Write the test**

Append to `date-utils.test.ts`. Ensure `parseSiteLocalDateToMidnight` is included in the file's existing `./date-utils` import; add it if absent.

```ts
describe('parseSiteLocalDateToMidnight — nonexistent local midnight', () => {
    it('resolves a DST-skipped midnight to the first existing local time (America/Santiago)', () => {
        // Chile springs forward at 24:00 on the first Saturday of September:
        // Sep 6 2026 00:00 does not exist; the day starts at 01:00 CLST (UTC-3).
        // 01:00 UTC-3 = 04:00 UTC.
        const result = parseSiteLocalDateToMidnight('2026-09-06', 'America/Santiago');
        expect(result).toEqual(new Date(Date.UTC(2026, 8, 6, 4, 0, 0)));
    });
});
```

- [ ] **Step 3: Run — expected PASS**

Run: `npm test -- src/lib/date-utils`
Expected: PASS (Temporal's default `'compatible'` disambiguation shifts forward). A throw or a 03:00Z result is a real bug — triage protocol.

- [ ] **Step 4: Commit**

```bash
git -C /Users/kevm/github/pwusage add cmd/next-app/src/lib/date-utils.test.ts
git -C /Users/kevm/github/pwusage commit -m "test(date-utils): pin DST-skipped midnight resolution"
```

---

### Task 6: Import windows on 23- and 25-hour days (expected PASS)

**Files:**
- Test: `cmd/next-app/src/lib/importer/import-planner.test.ts`

The planner's 30-hour midnight jump is designed to be DST-safe, but no test exercises a transition day. These pin that a DST day is one window between true local midnights, and that a fully-covered 25-hour day is not re-planned.

- [ ] **Step 1: Write the tests**

Append to `import-planner.test.ts`. The file already imports from `./import-planner`; make sure both `auditDays` and `planImport` are in the import list.

```ts
describe('auditDays / planImport — DST transition days (America/Chicago)', () => {
    const TZ = 'America/Chicago';
    const FIVE_MIN = 5 * 60 * 1000;

    function timestampsEvery5Min(startMs: number, endMs: number): number[] {
        const out: number[] = [];
        for (let t = startMs; t < endMs; t += FIVE_MIN) out.push(t);
        return out;
    }

    it('spring-forward day is a single 23-hour window between true local midnights', () => {
        // Mar 8 2026: CST midnight = 06:00Z; Mar 9 CDT midnight = 05:00Z.
        const start = new Date('2026-03-08T06:00:00Z');
        const end = new Date('2026-03-09T05:00:00Z');
        const results = auditDays({
            requestedRange: { start, end },
            existingTimestamps: [],
            timezone: TZ,
            now: new Date('2026-03-15T12:00:00Z'),
        });
        expect(results).toHaveLength(1);
        expect(results[0].windowStart).toEqual(start);
        expect(results[0].windowEnd).toEqual(end);
    });

    it('fall-back day is a single 25-hour window; full 5-min coverage plans no re-import', () => {
        // Nov 1 2026: CDT midnight = 05:00Z; Nov 2 CST midnight = 06:00Z (25 hours).
        const start = new Date('2026-11-01T05:00:00Z');
        const end = new Date('2026-11-02T06:00:00Z');
        const existing = timestampsEvery5Min(start.getTime(), end.getTime());
        expect(existing).toHaveLength(25 * 12);
        const windows = planImport({
            requestedRange: { start, end },
            existingTimestamps: existing,
            timezone: TZ,
            now: new Date('2026-11-15T12:00:00Z'),
        });
        expect(windows).toEqual([]);
    });
});
```

- [ ] **Step 2: Run — expected PASS**

Run: `npm test -- src/lib/importer/import-planner`
Expected: PASS. A 24-hour-assumption failure here (e.g. two windows, or a re-planned covered day) is a real bug — triage protocol.

- [ ] **Step 3: Commit**

```bash
git -C /Users/kevm/github/pwusage add cmd/next-app/src/lib/importer/import-planner.test.ts
git -C /Users/kevm/github/pwusage commit -m "test(importer): pin DST-day import window boundaries"
```

---

### Task 7: `aggregateUsage` crashes for a site with zero tariffs (real crash path)

**Files:**
- Modify: `cmd/next-app/src/lib/tou-aggregation.ts`
- Test: `cmd/next-app/src/lib/tou-aggregation.test.ts`

**The bug:** both passes fall back to `currentTariff = site.tariffs[0]` and later read `currentTariff.id`. With `site.tariffs = []` (possible when tariff parsing failed at onboarding but energy rows exist), that's a `TypeError` → 500 on the dashboard. Possibly unreachable today; cheap insurance either way.

- [ ] **Step 1: Write the failing test**

Append inside the existing `describe('TOU Aggregation Utility', ...)` block in `tou-aggregation.test.ts` (all imports already present):

```ts
    it('returns an empty aggregation instead of crashing for a site with no tariffs', () => {
        const site: SiteWithTariffs = {
            id: 'test_site',
            name: 'Test Site',
            timezone: TZ,
            billing_start_day: 1,
            updated: new Date(),
            installed: new Date(),
            json: {},
            tariffs: []
        };
        const schedule = new Schedule([], TZ);
        const priorAggregates: CycleAggregateRow[] = [{
            day: new Date('2026-06-01T00:00:00Z'),
            tariff_id: 1,
            tariff_schedule_id: null,
            load_power: 1000,
            solar_power: 500,
            grid_power: 500,
            battery_power: 0
        }];
        const todayRaw: EnergyData[] = [{
            timestamp: new Date('2026-06-01T15:00:00Z'),
            site_id: 'test_site',
            tariff_id: 1,
            tariff_schedule_id: null,
            load_power: 2000,
            solar_power: 1000,
            grid_power: 1000,
            battery_power: 0,
            battery_soc: 85
        }];

        const result = aggregateUsage(site, priorAggregates, todayRaw, schedule);

        expect(result.tariffGroups).toEqual([]);
        expect(result.totalBillCost).toBe(0);
        // Series data must still flow through for charting.
        expect(result.seriesData).toHaveLength(1);
        expect(result.latestSeriesSoc?.value).toBe(85);
    });
```

- [ ] **Step 2: Run and verify it fails with a TypeError**

Run: `npm test -- src/lib/tou-aggregation`
Expected: FAIL — `TypeError: Cannot read properties of undefined (reading 'id')` (thrown building the pass-1 aggregation key).

- [ ] **Step 3: Fix — early return preserving the series passthrough**

In `tou-aggregation.ts`, insert at the very top of `aggregateUsage` (before the `tariffMap` construction):

```ts
    // A site with no tariffs (e.g. tariff parse failed at onboarding) cannot
    // be priced, but its raw series must still reach the charts.
    if (site.tariffs.length === 0) {
        const seriesData: EnergyData[] = [];
        let latestSeriesSoc: { value: number; timestamp: Date } | null = null;
        for (const row of todayRaw) {
            seriesData.push(row);
            if (typeof row.battery_soc === 'number') {
                latestSeriesSoc = { value: row.battery_soc, timestamp: row.timestamp };
            }
        }
        return { tariffGroups: [], totalBillCost: 0, seriesData, latestSeriesSoc };
    }
```

- [ ] **Step 4: Run the file — all pass**

Run: `npm test -- src/lib/tou-aggregation`
Expected: PASS, including all pre-existing tests.

- [ ] **Step 5: Commit**

```bash
git -C /Users/kevm/github/pwusage add cmd/next-app/src/lib/tou-aggregation.ts cmd/next-app/src/lib/tou-aggregation.test.ts
git -C /Users/kevm/github/pwusage commit -m "fix(tou): return empty aggregation instead of crashing when site has no tariffs"
```

---

### Task 8: Full verification + results log

**Files:**
- Create: `docs/superpowers/plans/2026-07-07-adversarial-time-money-tests-RESULTS.md`

- [ ] **Step 1: Run the full gate (from `cmd/next-app`)**

```bash
npm test
npm run lint
npm run build
```
Expected: all three pass. Fix anything they surface before proceeding.

- [ ] **Step 2: Write the results log**

Create `docs/superpowers/plans/2026-07-07-adversarial-time-money-tests-RESULTS.md` with this structure, filled in from what actually happened:

```markdown
# Adversarial Time-and-Money Test Hunt — Results (2026-07-07)

## Bugs found and fixed
- billing-cycle short-month clamped anchor: [confirmed / not reproduced — actual outcome]
- schedule wrapped day-of-week ranges: [confirmed / not reproduced — actual outcome]
- tou-aggregation zero-tariff crash: [confirmed / not reproduced — actual outcome]

## Probes that failed unexpectedly (bugs found by Tasks 3–6)
[none, or list with the fix applied]

## Behavior pinned by new regression tests
- DST fall-back repeated hour + spring-forward skipped hour (America/Chicago 2026)
- Season boundary at site-local midnight
- Saturday Christmas / Sunday New Year observance
- DST-skipped local midnight (America/Santiago)
- 23h/25h import-day windows

## Known issues documented, deliberately not changed
[copy the 5-item list from the plan, noting anything new observed while executing]
```

- [ ] **Step 3: Commit**

```bash
git -C /Users/kevm/github/pwusage add docs/superpowers/plans/2026-07-07-adversarial-time-money-tests-RESULTS.md
git -C /Users/kevm/github/pwusage commit -m "docs: record adversarial time/money test-hunt results"
```

- [ ] **Step 4: Stop — do not push**

Report the branch name and a summary of confirmed bugs to the user. The user pushes and opens the PR.
