# Sync Daily Coverage Aggregation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the ~8,600-row `getExistingTimestamps` scan with a per-day SQL aggregate so each `/api/sync` coverage audit ships ≤ ~31 rows, without changing which days get re-fetched.

**Architecture:** A new `EnergyRepo.getDailyCoverage` returns one row per site-local day (`count`, `first`, `last`, `maxInteriorGapMs`) using `date_trunc('day', timestamp AT TIME ZONE <site tz>)` + `LAG`. The planner keeps generating DST-correct day windows in JS via Temporal, merges SQL stats over every generated day (defaulting absent days to zero so empty days still re-fetch), and applies the same 30-minute threshold decisions as today.

**Tech Stack:** TypeScript, Next.js 15 App Router (`cmd/next-app`), PostgreSQL via `pg`, `@js-temporal/polyfill`, Vitest, ESLint 9 flat config.

**Spec:** `docs/plans/2026-09-30-sync-daily-coverage-aggregation-design.md`

## Global Constraints

- No `any` type anywhere (AGENTS.md). Declare explicit interfaces for all new types.
- `npm run test`, `npm run lint`, and `npm run build` must all pass from `cmd/next-app` before the work is done.
- All work happens in `cmd/next-app`. Do not touch `cmd/web-app`, `cmd/ios-app`, or the Go tree.
- No new runtime dependencies. No database migration — this is a query-shape change only.
- Site-timezone bucketing must be explicit: always `timestamp AT TIME ZONE $tz`. Never rely on the session timezone (the pre-existing `getCycleAggregates` session-`date_trunc` quirk must not be copied).
- Day keys are `YYYY-MM-DD` on both sides: SQL `to_char(local_day, 'YYYY-MM-DD')` and JS `formatSiteDate(utcDate, tz)`.
- Re-fetch decisions must be unchanged: same 30-minute `gapThresholdMs` default, same `planImport` filter, same half-open `[start, end)` fetch range and ISO-string parameters.
- Scripts in `cmd/next-app/scripts/` must load `.env` via `dotenv`, require an explicit DB URL env var, and refuse to run when `NODE_ENV=production`.

## Review Focus

Failure modes the spec implies, ordered most-likely-to-bite first. Each has a test in the owning task.

1. **A day with zero stored samples.** The SQL emits no row for it. A missing row must be treated as `count: 0`, or genuinely empty days silently stop being re-fetched. — Task 3
2. **DST transition day (23h spring-forward / 25h fall-back).** SQL day keys and JS window bounds must agree exactly; a one-hour drift re-fetches or skips a day on every cycle forever. — Tasks 1, 3
3. **The in-progress "today" window.** `effectiveWindowEnd` is clamped to `now`, so `missingEnd` must be measured against `now`, not end-of-day, or today is flagged missing on every attempt. — Tasks 1, 3
4. **A mid-day hole with a healthy first/last/count.** Only `maxInteriorGapMs` detects it; if that scalar is dropped or computed over the wrong partition, gaps stop being repaired. — Tasks 2, 3
5. **A site timezone string Postgres cannot parse.** JS `getValidTimezone` silently falls back to `'UTC'`; Postgres raises on `AT TIME ZONE 'Not/AZone'`. The SQL must receive a validated zone or the sync errors out where it previously degraded quietly. — Task 2
6. **Day-key format drift** between SQL `to_char` and JS `formatSiteDate` (e.g. an unpadded month). Every day then reads as empty and the whole cycle is re-fetched on every sync. — Tasks 2, 3

## File Structure

- `src/lib/energy-repo.ts` — owns `DailyCoverageStat` and `getDailyCoverage`; loses `getExistingTimestamps` in Task 4. Repo return types already live here (`UsageData` at line 9).
- `src/lib/importer/import-planner.ts` — pure planner. Gains `generateDayWindows` (DST-critical window generation) and switches `auditDays` from raw timestamps to per-day coverage. Stays dependency-light: `import type` only.
- `src/lib/importer/index.ts` — the two callers (`ensureDataForRange:142`, `auditRange:485`).
- `src/lib/date-utils.ts` — exports `getValidTimezone` so the repo can normalize the zone before it reaches SQL.
- `scripts/verify-sync-daily-coverage.ts` — one-off differential check of SQL output against the pre-change walk, on real data.

---

### Task 1: Extract `generateDayWindows` from `auditDays`

Pure refactor with no behaviour change. It isolates the DST-critical window generation in its own reviewable commit so Task 3's diff stays small.

**Files:**
- Modify: `src/lib/importer/import-planner.ts:31-107`
- Test: `src/lib/importer/import-planner.test.ts`

**Interfaces:**
- Consumes: nothing new (existing `DateWindow`, `getSiteMidnight`)
- Produces:
  - `export interface DayWindow { windowStart: Date; windowEnd: Date; effectiveWindowEnd: Date; isToday: boolean }`
  - `export interface GenerateDayWindowsOptions { requestedRange: DateWindow; timezone: string; installationDate?: Date; now?: Date }`
  - `export function generateDayWindows(options: GenerateDayWindowsOptions): DayWindow[]`
- `auditDays` keeps its current signature and output.

- [ ] **Step 1: Write the failing tests**

In `import-planner.test.ts`, add a `describe('generateDayWindows')` block asserting the exact values the existing `auditDays` DST tests already pin:

```ts
// spring forward: 2026-03-08T06:00:00Z → 2026-03-09T05:00:00Z is one 23h window
const [w] = generateDayWindows({
    requestedRange: { start: new Date('2026-03-08T06:00:00Z'), end: new Date('2026-03-09T05:00:00Z') },
    timezone: 'America/Chicago',
    now: new Date('2026-03-20T00:00:00Z'),
});
expect(w.windowStart.toISOString()).toBe('2026-03-08T06:00:00.000Z');
expect(w.windowEnd.toISOString()).toBe('2026-03-09T05:00:00.000Z');

// fall back: 2026-11-01T05:00:00Z → 2026-11-02T06:00:00Z is one 25h window
// and its effectiveWindowEnd equals windowEnd when now is past the day
```

Also assert the install-date floor (`installationDate` later than `requestedRange.start` moves the first `windowStart` to install midnight) and the now-clamp (`requestedRange.end` in the future yields `effectiveWindowEnd === now` for the last window, and no window is emitted beyond `now`).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/importer/import-planner.test.ts`
Expected: FAIL — `generateDayWindows` is not exported.

- [ ] **Step 3: Extract the window loop**

Move the cursor walk out of `auditDays` into `generateDayWindows`, preserving it exactly: the `getSiteMidnight(requestedRange.start, timezone)` start, the `installationDate` floor, `auditEnd = min(requestedRange.end, now)`, and the DST-safe `getSiteMidnight(new Date(windowStart + 30 * 60 * 60 * 1000), timezone)` advance. `auditDays` then calls `generateDayWindows` and maps each window through the existing two-pointer timestamp walk.

The two-pointer keeps working unchanged: windows are produced in ascending order, so the shared `tsIndex` still advances monotonically across them. Do not replace it with a per-window scan — that would turn the walk quadratic over a billing cycle.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/importer/import-planner.test.ts`
Expected: PASS, including all pre-existing `auditDays`, `planImport`, and DST cases, which are unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/lib/importer/import-planner.ts src/lib/importer/import-planner.test.ts
git commit -m "refactor(next-app): extract generateDayWindows from auditDays"
```

---

### Task 2: Add `getDailyCoverage` to `EnergyRepo`

**Files:**
- Modify: `src/lib/energy-repo.ts` (add `DailyCoverageStat` near `UsageData` at line 9; add `getDailyCoverage` beside the existing queries at line 127)
- Modify: `src/lib/date-utils.ts` (add `export` to `getValidTimezone` at line 15)
- Test: `src/lib/energy-repo.test.ts`

**Interfaces:**
- Consumes: `getValidTimezone` (newly exported from `src/lib/date-utils.ts`)
- Produces:
  - `export interface DailyCoverageStat { localDayKey: string; count: number; first: Date | null; last: Date | null; maxInteriorGapMs: number }`
  - `async getDailyCoverage(siteId: string, start: Date, end: Date, timezone: string): Promise<DailyCoverageStat[]>`
- Keeps `getExistingTimestamps` in place; Task 4 removes it.

- [ ] **Step 1: Write the failing row-mapping test**

`energy-repo.test.ts` already mocks `./db` with a `queryMock`. Feed it pg-shaped rows — `count` as a numeric string, `max_gap_sec` as a numeric string, `first`/`last` as `Date`s:

```ts
queryMock.mockResolvedValue({
    rows: [{ local_day_key: '2026-03-08', count: '288', first: new Date('2026-03-08T06:00:00Z'), last: new Date('2026-03-09T04:55:00Z'), max_gap_sec: '300' }],
});
expect(await repo.getDailyCoverage('site-1', start, end, 'America/Chicago')).toEqual([
    { localDayKey: '2026-03-08', count: 288, first: new Date('2026-03-08T06:00:00Z'), last: new Date('2026-03-09T04:55:00Z'), maxInteriorGapMs: 300000 },
]);
```

- [ ] **Step 2: Write the failing SQL-shape test**

Assert the SQL handed to `queryMock` contains `date_trunc('day', timestamp AT TIME ZONE $4)`, `LAG(timestamp) OVER`, and `GROUP BY local_day`, and that the params array is `[siteId, start.toISOString(), end.toISOString(), 'America/Chicago']`. This is what pins Review Focus #6 and #1 at the SQL level.

- [ ] **Step 3: Write the failing invalid-timezone test**

Call `getDailyCoverage('site-1', start, end, 'Not/AZone')` and assert the fourth param is `'UTC'` and nothing throws. This pins Review Focus #5.

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npx vitest run src/lib/energy-repo.test.ts`
Expected: FAIL — `getDailyCoverage` is not a function.

- [ ] **Step 5: Implement the type and method**

Add `DailyCoverageStat` and `getDailyCoverage`. Use exactly this SQL:

```sql
WITH s AS (
    SELECT
        timestamp,
        date_trunc('day', timestamp AT TIME ZONE $4) AS local_day,
        LAG(timestamp) OVER (
            PARTITION BY date_trunc('day', timestamp AT TIME ZONE $4)
            ORDER BY timestamp
        ) AS prev_ts
    FROM "EnergyData"
    WHERE site_id = $1
      AND timestamp >= $2
      AND timestamp < $3
)
SELECT
    to_char(local_day, 'YYYY-MM-DD') AS local_day_key,
    COUNT(*)::int AS count,
    MIN(timestamp) AS first,
    MAX(timestamp) AS last,
    COALESCE(MAX(EXTRACT(EPOCH FROM (timestamp - COALESCE(prev_ts, timestamp)))), 0) AS max_gap_sec
FROM s
GROUP BY local_day
ORDER BY local_day
```

The row mapper coerces `count` and `max_gap_sec` with `Number(...)`, maps `first`/`last` through `new Date(...)`, and multiplies `max_gap_sec` by 1000. Normalize the zone first:

```ts
const tz = getValidTimezone(timezone);
```

and pass `tz` as the fourth parameter. Export `getValidTimezone` from `date-utils.ts` (change `function getValidTimezone` to `export function getValidTimezone`).

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/lib/energy-repo.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/energy-repo.ts src/lib/date-utils.ts src/lib/energy-repo.test.ts
git commit -m "feat(next-app): add getDailyCoverage per-day SQL aggregate"
```

---

### Task 3: Refactor `auditDays` to consume per-day coverage

**Files:**
- Modify: `src/lib/importer/import-planner.ts` (the `PlanOptions` interface at line 8 and the `auditDays` body at line 31)
- Test: `src/lib/importer/import-planner.test.ts`

**Interfaces:**
- Consumes: `generateDayWindows` / `DayWindow` (Task 1); `DailyCoverageStat` (Task 2)
- Produces: `PlanOptions.existingCoverage: DailyCoverageStat[]`, replacing `PlanOptions.existingTimestamps: number[]`. Import the type with `import type { DailyCoverageStat } from '../energy-repo';` — type-only, so no runtime dependency is added to this pure module.
- `planImport` and `DayAuditResult` are unchanged.

- [ ] **Step 1: Add a test helper that mirrors the SQL**

In `import-planner.test.ts`, add `coverageFromTicks(ticks: number[], tz: string): DailyCoverageStat[]` that buckets epoch-ms ticks by `formatSiteDate(ts, tz)` and emits `count`, `first`, `last`, `maxInteriorGapMs` per bucket — the same semantics the SQL computes. This lets the existing tick-based cases survive the input-type change.

- [ ] **Step 2: Convert the existing cases and keep their expectations**

Rewrite the existing `planImport` / `auditDays` cases to pass `existingCoverage: coverageFromTicks(fiveMinTicks(...), 'America/Chicago')` and assert the identical outcomes the cases assert today:

- fully covered day (288 five-min ticks) → `planImport` returns `[]`
- empty day → one window
- gap at start beyond threshold → one window
- gap at end beyond threshold → one window
- interior gap → one window
- `forceRefetch: true` → one window even when covered
- `installationDate` clamps every window start
- two missing days → two windows

Also convert the two DST cases: the fully covered 25-hour fall-back day must still plan no re-import.

- [ ] **Step 3: Write the failing empty-day tests**

Two cases pinning Review Focus #1: a day with **no entry** in `existingCoverage`, and a day with an explicit `{ count: 0, first: null, last: null, maxInteriorGapMs: 0 }` entry. Both must yield exactly one planned window, identical to each other.

- [ ] **Step 4: Write the failing max-gap threshold tests**

Two cases pinning Review Focus #4: a covered day whose `maxInteriorGapMs` is 29 minutes yields no interior gap; 31 minutes yields one. `first`/`last` are at the window edges in both, so only the scalar differs.

- [ ] **Step 5: Run the tests to verify they fail**

Run: `npx vitest run src/lib/importer/import-planner.test.ts`
Expected: FAIL — `auditDays` still reads `existingTimestamps`.

- [ ] **Step 6: Implement the refactor**

Change `PlanOptions.existingTimestamps: number[]` to `existingCoverage: DailyCoverageStat[]`. In `auditDays`, iterate `generateDayWindows(...)` and for each window compute `const key = formatSiteDate(w.windowStart, timezone)`, look up the matching stat, and default to `{ count: 0, first: null, last: null, maxInteriorGapMs: 0 }` when absent. Delete the two-pointer walk entirely — per-day stats make it unnecessary. Keep `gapThresholdMs` defaulting to `30 * 60 * 1000` and apply these decisions unchanged:

```ts
missingStart:   first !== null && first.getTime() - w.windowStart.getTime() > gapThresholdMs,
missingEnd:     last  !== null && w.effectiveWindowEnd.getTime() - last.getTime() > gapThresholdMs,
hasInteriorGap: stat.maxInteriorGapMs > gapThresholdMs,
```

`count`, `firstInWindow`, and `lastInWindow` come from the stat; `firstInWindow`/`lastInWindow` stay epoch-ms `number | null` so `DayAuditResult` is unchanged. `planImport` is untouched.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run src/lib/importer/import-planner.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/lib/importer/import-planner.ts src/lib/importer/import-planner.test.ts
git commit -m "perf(next-app): plan imports from per-day coverage aggregates"
```

---

### Task 4: Switch the callers and delete `getExistingTimestamps`

**Files:**
- Modify: `src/lib/importer/index.ts:142` and `:485`
- Modify: `src/lib/energy-repo.ts:127-143` (delete the method)
- Test: `src/lib/importer.test.ts`

**Interfaces:**
- Consumes: `getDailyCoverage` (Task 2)
- Produces: no `getExistingTimestamps` anywhere in the tree.

- [ ] **Step 1: Repoint the test mocks**

In `importer.test.ts`, replace every `getExistingTimestamps` mock with `getDailyCoverage`. The two "fully covered day" cases need real reshaping rather than a rename: the case at ~line 243 supplies 48 half-hour points for a full day, and the case at ~line 329 supplies 24 hourly points. Each becomes a single coverage row for that site-local day:

```ts
getDailyCoverage: vi.fn().mockResolvedValue([
    { localDayKey: '2026-01-10', count: 48, first: new Date('2026-01-10T06:00:00Z'), last: new Date('2026-01-11T05:30:00Z'), maxInteriorGapMs: 30 * 60 * 1000 },
]),
```

Adjust `count`/`first`/`last`/`maxInteriorGapMs` to whatever values keep those two cases asserting *no import happens*, and keep every other mock returning `[]`. Existing assertions (import-when-missing, no-import-when-covered, lock acquire/release, `maxTimeMs` budget, honest partial reporting, midnight flooring) stay as they are.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/importer.test.ts`
Expected: FAIL — the importer still calls `getExistingTimestamps`.

- [ ] **Step 3: Switch both call sites**

In `ensureDataForRange`, replace the `getExistingTimestamps(siteId, auditStartTime, end)` call with `getDailyCoverage(siteId, auditStartTime, end, site.timezone)` and pass the result to `planImport` as `existingCoverage`. Leave the `getSiteMidnight(start, tz)` flooring where it is. In `auditRange`, make the same swap using `site.timezone`; its range stays the single day the caller passes.

- [ ] **Step 4: Delete `getExistingTimestamps`**

Remove the method from `energy-repo.ts`. Confirm no references remain:

Run: `rg -n "getExistingTimestamps" src`
Expected: no matches.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/lib/importer.test.ts src/lib/importer/import-planner.test.ts src/lib/energy-repo.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/importer/index.ts src/lib/energy-repo.ts src/lib/importer.test.ts
git commit -m "perf(next-app): read sync coverage from getDailyCoverage"
```

---

### Task 5: Differential verification against a real Postgres

The tz-database equivalence in the spec is the one assumption unit tests cannot exercise, because `energy-repo.test.ts` mocks `./db` and CI only provisions Postgres for the migration job. This task proves the new SQL produces the same per-day numbers the old walk did, on real rows, including DST days.

**This is a manual gate, not an automated test.** Nothing in `npm run test` exercises real Postgres, so a future change to this query would not be re-checked automatically. Keep the script in the repo so it can be re-run by hand, and treat it as required before merging any change to `getDailyCoverage`.

**Files:**
- Create: `scripts/verify-sync-daily-coverage.ts`

**Interfaces:**
- Consumes: `EnergyRepo.getDailyCoverage` (Task 2), `getSiteMidnight` / `formatSiteDate` from `src/lib/date-utils.ts`
- Produces: a standalone script; no production code depends on it.

- [ ] **Step 1: Make `DATABASE_URL` available**

`.env` is gitignored, so copy the main checkout's into this worktree:

```bash
cp /Users/kevm/github/pwusage/cmd/next-app/.env .env
```

Confirm `DEV_DATABASE_URL` is present in it; the script refuses to run without it.

- [ ] **Step 2: Write the script**

Follow the conventions in `scripts/measure-mobile-egress.ts`: `dotenv.config({ path: path.resolve(process.cwd(), '.env'), quiet: true })` at the top, exit non-zero when `DEV_DATABASE_URL` is unset, and refuse to run when `NODE_ENV=production`.

The script must not import the deleted `getExistingTimestamps`. Instead build a self-contained reference: for each site that has `EnergyData`, over a range chosen to contain a DST transition in that site's timezone (America/Chicago: 2026-03-08 spring-forward, 2026-11-01 fall-back), run

- the new aggregation SQL via `getDailyCoverage`, and
- a reference that selects raw epoch-ms timestamps with a plain
  `SELECT EXTRACT(EPOCH FROM timestamp) ... WHERE site_id = $1 AND timestamp >= $2 AND timestamp < $3 ORDER BY timestamp ASC`,
  buckets them with `getSiteMidnight` windows and `formatSiteDate` keys, and
  derives `count`/`first`/`last`/`maxInteriorGapMs` from the sorted array.

Compare the two per `localDayKey` and report any mismatch in `count`, `first`, `last`, or `maxInteriorGapMs`. The **key set itself** is a primary assertion, not just a nicety: it is what catches day-key drift between SQL `to_char` and JS `formatSiteDate` (Review Focus #6), where every day would silently read as empty and the whole cycle would be re-fetched on every sync. A day present in one set and absent from the other is a failure. Print the row counts returned by each query so the egress reduction is visible. Include a day with an interior hole and, if one exists, a day with no rows at all, since those are the cases a unit test can least cover.

- [ ] **Step 3: Run it**

Run: `npx tsx scripts/verify-sync-daily-coverage.ts`
Expected: no mismatches reported, and a printed reduction from ~8,600 rows to ~31 rows for a monthly range.

- [ ] **Step 4: Gate on the result**

If any day mismatches, stop and report the failing day, its site, and both stat sets. Do not adjust the SQL or the reference to make them agree — a mismatch means the design's equivalence argument is wrong and the spec needs revisiting. If everything matches, proceed.

- [ ] **Step 5: Commit**

```bash
git add scripts/verify-sync-daily-coverage.ts
git commit -m "chore(next-app): add differential check for sync daily coverage SQL"
```

---

### Task 6: Full verification and close out the todo item

**Files:**
- Modify: `todo.md`

**Interfaces:**
- Consumes: everything from Tasks 1-5
- Produces: a green branch and a cleaned-up todo list.

- [ ] **Step 1: Run the full verification suite**

Run from `cmd/next-app`:

```bash
npm run test
npm run lint
npm run build
```

Expected: all three pass. `npm run test` runs in watch mode by default, so pass a terminating flag if needed (`npx vitest run`).

- [ ] **Step 2: Remove the completed todo entry**

Delete the `getExistingTimestamps` bullet from the "DB egress: remaining reduction candidates" section of `todo.md`, per that file's own "How to use this list" instructions. Leave the other two candidates (live-status cache churn, per-poll tariff versions) and the `getCycleAggregates` session-timezone observation in place — they are separate items.

- [ ] **Step 3: Commit**

```bash
git add todo.md
git commit -m "chore: drop completed sync egress todo item"
```

- [ ] **Step 4: Report**

Summarize the measured row-count reduction from Task 5, and flag the two things deliberately left alone: the `getCycleAggregates` session-timezone day bucketing, and the two remaining egress candidates in `todo.md`.