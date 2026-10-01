# Sync Daily Coverage Aggregation — Design

**Date:** 2026-09-30
**Status:** Approved, ready for planning
**Origin:** `todo.md` → "DB egress: remaining reduction candidates" → first candidate (`getExistingTimestamps`)

---

## Background

The July 2026 Supabase egress spike was traced and fixed, but `todo.md` left three
reduction candidates. This document covers the highest-value one:

> `getExistingTimestamps` returns every 5-min timestamp in the audited range
> (~8.5k rows per billing cycle) on each `/api/sync` step, and `DataSyncer`
> retries up to 15× per stage, 2 stages, re-running hourly. Aggregating per-day
> stats (count, first, last, max interior gap via `lag()`) in SQL would cut it
> ~300×, but must reproduce `auditDays`' site-timezone day windows (DST days are
> pinned by `import-planner.test.ts`) — do it carefully.

### Current cost

`EnergyRepo.getExistingTimestamps` (`src/lib/energy-repo.ts:127`) is a
single-column projection with no aggregation:

```sql
SELECT EXTRACT(EPOCH FROM timestamp) as timestamp
FROM "EnergyData"
WHERE site_id = $1 AND timestamp >= $2 AND timestamp < $3
ORDER BY timestamp ASC
```

It returns one row per stored 5-minute sample. A monthly billing cycle is ~30
days × 288 samples/day ≈ **8,600 rows**, and it is called on:

- every `/api/sync` request — the browser `DataSyncer` fires up to 15 attempts
  in the hot-zone stage and 15 in the full-period stage per page view, plus one
  hot-zone step every hour while the page stays mounted;
- every `/api/site/[id]/analysis` request.

The index scan itself is cheap (`idx_energy_site_ts` on `(site_id, timestamp)`);
the cost is the **row-level egress** of the full result set over the wire,
multiplied by the retry cadence.

### What the callers actually need

There are exactly two production call sites, both in `Importer`
(`src/lib/importer/index.ts`):

| Caller | Line | Use |
| --- | --- | --- |
| `ensureDataForRange` | 142 | floors `start` to site midnight, then feeds `planImport` |
| `auditRange` | 485 | feeds `auditDays` directly for the analysis response |

Both funnel into `auditDays` (`src/lib/importer/import-planner.ts:31`), which
walks the timestamp array with a two-pointer and reduces it to **per
site-local-day** statistics. No decision anywhere depends on which individual
5-minute slots are populated beyond those statistics:

- `count` — samples in the window (0 vs non-zero);
- `firstInWindow` / `lastInWindow` — exact first/last sample instants;
- `hasInteriorGap` — any consecutive pair differing by more than the 30-minute
  `gapThresholdMs`;
- `missingStart` — `firstInWindow - windowStart > gapThresholdMs`;
- `missingEnd` — `effectiveWindowEnd - lastInWindow > gapThresholdMs`.

`planImport` then re-fetches a day **wholesale** if it is empty, forced, or has
any start/end/interior gap. So the entire consumer surface is four aggregates
plus a max-gap scalar per day.

---

## Goals

1. Cut `/api/sync` coverage-audit egress from ~8,600 rows to ≤ ~31 rows
   (~270–300×) with **no change to which days get re-fetched**.
2. Preserve the DST-correct site-timezone day windows exactly, including the
   `now`-clamped "today" window and the installation-date floor.
3. Keep the fetch range, index usage, and lock/cadence behaviour untouched.

## Non-goals

- The other two egress candidates in `todo.md` (live-status cache churn;
  per-poll tariff version fetches) — separate items, not touched here.
- The pre-existing `getCycleAggregates` quirk of bucketing with
  `date_trunc('day', timestamp)` in the *session* timezone. Unrelated query;
  deliberately not "fixed" here to keep this change surgical.
- Any change to what the analysis endpoint returns.

---

## Approach decision

Three ways to bucket samples into site-local days in SQL were considered.

**A — `date_trunc('day', timestamp AT TIME ZONE <site tz>)` (chosen).** A single
scan, `LAG` for the interior gap, `GROUP BY` the local calendar date. The
planner keeps generating the DST-aware windows in JS and merges the SQL rows
over every generated day, so empty days still register as missing.

**B — pass the JS-computed windows into SQL and range-join.** Guarantees window
bounds match by construction (no tz-database equivalence assumption at all), at
the cost of a `VALUES` window set, a range `LEFT JOIN`, and a `LAG` over the
joined result.

**C — denormalized `EnergyDayStats` table** maintained by the write path or the
retention cron. Fastest at query time, but introduces a second source of truth
that must stay consistent with `EnergyData` writes and deletes. Disproportionate
for the remaining win.

**A is chosen.** The key enabler is that `date_trunc('day', ts AT TIME ZONE tz)`
buckets a sample to precisely the window that `auditDays` assigns it to — a
sample's local calendar date *is* its day window (proved in
[Correctness](#correctness) below). That keeps the SQL to a plain scan + window
function + aggregate with no join plumbing, and lets day-window generation stay
in the JS/Temporal code that the DST tests already pin.

B remains a reasonable fallback if the tz-database assumption in A is ever shown
to be unsound; the repo method boundary is the same in both.

---

## Design

### 1. Repository layer

Replace `getExistingTimestamps` with:

```ts
export interface DailyCoverageStat {
    localDayKey: string;        // 'YYYY-MM-DD' in the site's timezone
    count: number;
    first: Date | null;
    last: Date | null;
    maxInteriorGapMs: number;
}

async getDailyCoverage(
    siteId: string,
    start: Date,
    end: Date,
    timezone: string
): Promise<DailyCoverageStat[]>
```

SQL — one scan, site-timezone bucketing, `LAG` for the interior gap:

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
ORDER BY local_day;
```

Notes:

- The `AT TIME ZONE $4` is **explicit**, so this does not inherit the
  session-timezone behaviour that `getCycleAggregates` has.
- `timestamp AT TIME ZONE <tz>` converts a `timestamptz` to the local wall
  clock (`timestamp without time zone`); `date_trunc('day', …)` then yields the
  local calendar date. `COALESCE(prev_ts, timestamp)` makes the first row of
  each day contribute a 0-second gap rather than NULL.
- `UNIQUE(timestamp, site_id)` guarantees strictly increasing, duplicate-free
  timestamps per site, so `LAG` consecutive pairs are well defined.
- Range stays half-open `[start, end)` against the same `timestamptz` column with
  the same ISO-string parameters, so the plan and index use are unchanged.
- `max_gap_sec` is multiplied by 1000 in the row mapper to yield
  `maxInteriorGapMs`, matching the millisecond thresholds used in the planner.
- **Days with no samples produce no row.** That is deliberate; the planner
  supplies the zero default (below). This is what keeps the row count at ~1/day.

### 2. Planner layer

`src/lib/importer/import-planner.ts` changes shape, not behaviour.

**Extract `generateDayWindows`** out of `auditDays`:

```ts
export interface DayWindow {
    windowStart: Date;
    windowEnd: Date;
    effectiveWindowEnd: Date;
    isToday: boolean;
}

export function generateDayWindows(options: {
    requestedRange: DateWindow;
    timezone: string;
    installationDate?: Date;
    now?: Date;
}): DayWindow[]
```

This is the existing cursor walk lifted verbatim — the installation-date floor,
the `auditEnd = min(end, now)` clamp, and the DST-safe
`getSiteMidnight(windowStart + 30h)` advance. **This is the DST-critical code
and it does not change.**

**`auditDays` consumes aggregates instead of raw timestamps.** `PlanOptions`
replaces `existingTimestamps: number[]` with `existingCoverage:
DailyCoverageStat[]`. For each window from `generateDayWindows` it computes
`localDayKey = formatSiteDate(windowStart, timezone)` — which returns exactly
`YYYY-MM-DD`, matching the SQL `to_char` key — looks up the matching stat, and
defaults to `{ count: 0, first: null, last: null, maxInteriorGapMs: 0 }` when
absent. The two-pointer walk is replaced by that lookup; the decision
expressions are byte-identical:

```ts
missingStart:    first !== null && first.getTime() - windowStart.getTime() > gapThresholdMs,
missingEnd:      last  !== null && effectiveWindowEnd.getTime() - last.getTime() > gapThresholdMs,
hasInteriorGap:  maxInteriorGapMs > gapThresholdMs,
```

`planImport` is untouched — same filter, same per-day window mapping. So
`DayAuditResult` carries the same values for the same underlying samples, and
**which days get re-fetched is unchanged.**

### 3. Callers

- `ensureDataForRange` (`importer/index.ts:142`): swap
  `getExistingTimestamps(siteId, auditStartTime, end)` for
  `getDailyCoverage(siteId, auditStartTime, end, site.timezone)` and pass the
  result to `planImport`. The `getSiteMidnight(start, tz)` flooring stays where
  it is.
- `auditRange` (`importer/index.ts:485`): same swap. Its range is a single
  site-local day (~288 rows → 1 row); the win is incidental but the code path
  stays unified.
- **Delete `getExistingTimestamps`.** No remaining callers; leaving it would keep
  the wide-scan footgun available.

---

## Correctness

**Day-window equivalence.** `auditDays` assigns a sample at instant `ts` to the
window whose `[midnight_D, midnight_{D+1})` absolute range contains `ts`, where
each `midnight_D` is a true IANA local midnight (Temporal). The SQL assigns `ts`
to the group `date_trunc('day', ts AT TIME ZONE tz) = D`. These are the same
partition:

- The set of instants whose local wall clock reads date `D` is exactly
  `[midnight_D, midnight_{D+1})`. A DST transition at 02:00 local *within* day
  `D` shifts the offset but never moves an instant across a calendar-date
  boundary, so it cannot move a sample into a different bucket.
- Spring forward: wall clock runs `00:00–01:59` then `03:00–23:59`. No instant
  falls in the skipped hour, so the date-`D` set is contiguous — a 23-hour window.
- Fall back: wall clock `01:00–01:59` occurs twice in absolute time, but both
  copies carry date `D` and both lie inside `[midnight_D, midnight_{D+1})` — a
  25-hour window.

Boundary behaviour is half-open on both sides: a sample exactly at
`midnight_{D+1}` is excluded from window `D` by `ts < windowEnd` and lands in
bucket `D+1` by `date_trunc`, so `last`/`first` agree.

**`first` / `last` / `count` agreement.** Same partition ⇒ same member set ⇒
`MIN`/`MAX`/`COUNT(*)` equal the walk's first/last/count.

**`hasInteriorGap` agreement.** Both order by `timestamp` within a day and
compare consecutive pairs against the same 30-minute threshold. The walk's
boolean "any pair exceeded the threshold" is exactly "max pair delta exceeded the
threshold", which is what `MAX(EXTRACT(EPOCH …))` returns. `timestamp - prev_ts`
on two `timestamptz` values is an `interval`, and `EXTRACT(EPOCH FROM interval)`
yields seconds, so a 5-minute cadence yields `300`.

**Empty days.** `auditDays` still enumerates every day from site midnight up to
`min(end, now)`; a day with no SQL row defaults to `count: 0`, so
`planImport`'s `d.count === 0` clause still re-fetches it. This is the one
behaviour that would silently regress if the merge step were skipped, so it gets
a dedicated test.

**The one new assumption.** Postgres `AT TIME ZONE` and Node's Temporal
`getSiteMidnight` agree on the local calendar date of every sample instant in
the retention window. Both use IANA tzdata and agree for all modern dates
(energy data is retained 365 days by `/api/cron/cleanup`). This is asserted
directly by the DST tests described below rather than assumed.

---

## Testing

**`src/lib/importer/import-planner.test.ts`**
- Existing coverage cases are re-expressed to feed `DailyCoverageStat[]`
  instead of tick arrays, via a test-only helper that buckets ticks into
  per-day stats and mirrors the SQL semantics. Expectations (fully covered → 0
  windows; empty → 1; start gap → 1; end gap → 1; interior gap → 1) are
  unchanged, which is the point: the planner still makes the same calls.
- The exact DST window-bound assertions move to `generateDayWindows` and are
  kept verbatim: the 23-hour spring-forward window
  `2026-03-08T06:00:00Z → 2026-03-09T05:00:00Z` and the 25-hour fall-back
  window `2026-11-01T05:00:00Z → 2026-11-02T06:00:00Z` with full 5-minute
  coverage planning no re-import.
- New cases: a day absent from `existingCoverage` is treated as empty; a
  day present with `count: 0` behaves identically; `hasInteriorGap` is driven by
  `maxInteriorGapMs` crossing the threshold.

**`src/lib/importer.test.ts`**
- Repoint the `getExistingTimestamps` mock to `getDailyCoverage`, returning
  per-day stats. The behavioural assertions (imports when missing, does not
  import when covered, DB lock acquire/release, `maxTimeMs` budget, honest
  partial reporting, midnight flooring) are unchanged.
- The two existing cases that pass 48 half-hour points / 24 hourly points for a
  fully covered day become single fully-covered stat rows.

**New repository coverage**
- The aggregation semantics — site-timezone bucketing across a DST transition,
  interior-gap detection, `count`/`first`/`last` — get a focused test against a
  real Postgres instance if the repo's test harness supports it, otherwise
  against the production-backup migration CI. If neither is available this is
  called out explicitly rather than silently skipped, since it is the only place
  the tz-database assumption is actually exercised.

**Regression**
- `npm run test`, `npm run lint`, `npm run build` from `cmd/next-app`.
- `src/app/api/sync/route.test.ts` re-run (mocks the importer; should be
  unaffected).

---

## Expected impact

- `/api/sync` coverage-audit egress: ~8,600 rows → ≤ ~31 rows, a ~270–300×
  reduction, compounding across the 30-attempts-per-page-view plus hourly
  cadence.
- Analysis route: ~288 rows → 1 row per request.
- CPU: a window function over the same rows the index already visits; cheaper
  than shipping 8,600 rows to the application and re-reducing them in JS.
- Behaviour: identical re-fetch decisions, identical analysis output.

## Follow-ups (not in this change)

- Remove the `getExistingTimestamps` entry from `todo.md` and note the branch.
- Consider whether `getCycleAggregates`' session-timezone `date_trunc` bucketing
  should move to site-timezone days; it is a separate correctness question for
  the billing/TOU path.
- The two remaining egress candidates in `todo.md` stay open.
