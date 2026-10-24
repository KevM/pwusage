# Day record v2: open days and per-day tariff segments

Date: 2026-10-24. Branch: `feat/single-compact-store`. Builds on
[the EnergyData inventory](2026-10-24-energydata-inventory.md).

## Goal

One compact record per `(site_id, day)` is the only store of energy history.
Tesla is the system of record; each Tesla fetch for a day replaces that day's
record. This spec extends today's `EnergyDayArchive` (format v1) so it can hold
**open days** (today, or past days with gaps) and carries **tariff attribution
as a per-day segment timeline** instead of per-sample IDs.

## Current format (v1), for reference

- Payload (`compact-energy.ts`): JSON header (site, start, end, axis, positions)
  + column-major Float64 for `tariff_id`, `tariff_schedule_id`, `load_power`,
  `solar_power`, `grid_power`, `battery_power`, `battery_soc` (NaN = null for
  SOC/schedule), brotli. ~2.7 KB/day.
- Row metadata: `sample_count`, `expected_slots` (276/288/300 by DST),
  `first_timestamp`, `last_timestamp`, `max_interior_gap_ms`,
  `attribution_complete`, `metadata_checksum` (v2 digest over summaries),
  latest-sample projection, `raw_pruned`, `revision`.
- `EnergyDaySummary`: per `(tariff_id, tariff_schedule_id)` sums of power
  columns, import/export/charge/discharge and sample counts, keyed by revision.
- Writes only finished days (`finalizeDay`, `writeDayFromSamples`).

## Format v2

### Samples (payload, `format_version = 2`)

Pure Tesla data: `load_power`, `solar_power`, `grid_power`, `battery_power`,
`battery_soc` (nullable). Same header, axis and Float64 column layout as v1,
minus the two tariff columns. The site-day grid is 5 minutes.

### Attribution (new column `attribution jsonb`, covered by the metadata checksum)

```json
{
  "timelineRevision": "current-tariff:<tariff_id>",
  "segments": [
    { "offset": 0,    "tariffId": 82, "scheduleId": 301 },
    { "offset": 480,  "tariffId": 82, "scheduleId": 302 },
    { "offset": 1260, "tariffId": 82, "scheduleId": 301 }
  ]
}
```

- **`offset`** is minutes from `day_start` (site-local midnight). Offsets, not
  clock times, so DST days are unambiguous (the fall-back day repeats local
  1:00–2:00; its day is 1500 minutes long).
- **Segments cover the whole day**, `[offset, next offset)`, the last one to
  `day_end`, independent of which samples exist (an open day is attributed
  for its full length).
- **`scheduleId`** pins the exact rates: a `TariffSchedule` belongs to one
  season of one append-only tariff version. `tariffId` is stored for
  convenience and for gaps.
- **Gaps are explicit:** `scheduleId: null` (no matching period) marks those
  minutes unattributed and the day's `attribution_complete = false`. No
  synthetic fallback rates.
- **`timelineRevision`** records what produced the segments. Until
  effective-dated tariffs exist it is the tariff version current at write time;
  afterwards, the timeline revision, so stale days are a query.
- **Derivation:** walk the day's 5-minute slots (`Schedule.getTariffPeriod` on
  each slot timestamp), run-length encode. A sample at timestamp `t` belongs to
  the segment containing `t`, exactly as `getTariffPeriod(t)` decides today.
  Segment boundaries therefore fall on 5-minute marks; a schedule boundary that
  isn't on one (none exist today) takes effect at the next slot.
- **Open question to verify:** whether Tesla's sample timestamp marks the start
  or the end of its 5-minute interval (the publish-lag probe suggests the end).
  If the end, attribution at period boundaries is 5 minutes early today; fixing
  it is a one-line offset in derivation, and v2 makes the fix re-derivable from
  stored samples.

### Status and freshness (new columns)

- **`status`** `open | complete | gapped`:
  - `complete`: the day has ended and `sample_count = expected_slots`. Never
    refetched.
  - `open`: today, or an ended day with missing samples. Refetched by
    today-refresh (today) or gap-heal (recent past days).
  - `gapped`: an ended day still short of samples after repeated fetches made
    no progress (same as history-migration's "no progress" rule: N fetches past
    the gap-heal window without new samples). Kept, never refetched
    automatically; a repair can still replace it.
- **`fetched_at`**: when the Tesla response was received. A write replaces the
  record only if its `fetched_at` is newer than the stored one, so an older,
  slower fetch can never overwrite a newer one.
- **`raw_pruned`** stays during the transition (true for every day written
  straight from Tesla) and goes away with `EnergyData`.

### Summaries

`EnergyDaySummary` rows are derived from **samples × segments** when the
record is written (same columns and keys as today), and re-derived whenever
segments change. Readers keep verifying summaries against the decoded samples.

### Latest projection and coverage

Unchanged in shape; computed on every write, including open days, so "latest
sample" and freshness reads never decode the payload.

## Writes

- **One entry point:** `writeDay(siteId, dayStart, samples, fetchedAt)`
  generalizes `writeDayFromSamples` to open days. It validates samples are
  inside the day and on the site, encodes v2, derives segments, computes status,
  summaries and projections, and replaces the record in one transaction under
  the per-site claim, guarded by `fetched_at`.
- **Today-refresh** writes today's record from the whole-day-so-far Tesla
  response (and yesterday's, until it is `complete`). It is latched to fetch at
  most once per new 5-minute sample, about 2 minutes after each boundary
  (samples appear 75–85 s after their timestamp and never change).
- **Gap-heal / sync / repair** write each fetched day through the same entry
  point.
- **SOC:** `writeDay` requires the SOE fetch to have succeeded (see #196's
  `requireSoe`); otherwise the day is not written and stays as it was.
- Replacing an open day rewrites one small row and its few summary rows: with
  the latch, at most ~288 writes per site per day, typically far fewer.

## Reads

- The compact reader treats `open` days like any other record (it already
  decodes partial days); today's data comes from today's record.
- During the transition the reader still merges raw rows where they exist
  (#197), so flipping writers is safe before raw is gone.

## Re-attribution

A tariff correction (or, later, a back-dated tariff) rewrites only the
affected days' `attribution` and summaries from stored samples, with a new
revision. No sample rewrite, no Tesla request. This is a bounded background
job over the affected date range.

## Migrating existing archives (decided)

Convert every v1 archive to v2 once this format is final:

1. Decode the v1 payload.
2. Derive segments by run-length encoding its per-sample
   `(tariff_id, tariff_schedule_id)`, which preserves the attribution each
   sample was priced with (filling slots with no sample from the neighbouring
   segment, or `null` where no neighbour agrees).
3. Re-encode samples as v2, set `status` from `sample_count`/`expected_slots`
   and day end, `fetched_at` = the archive's `created_at`.
4. Verify: re-derived summaries equal the stored v1 summaries exactly;
   otherwise leave the day as v1 and report it.
5. Write in place (new revision), in bounded batches inside the egress
   budget (~a few KB read per day: the v1 payload).

Readers support v1 and v2 until the migration reports zero v1 rows, then v1
read support is removed.

## Decisions to confirm

1. **`gapped` rule:** how many no-progress fetches, and how far past the
   gap-heal window, before an ended day stops being refetched.
2. **Segment derivation on today's tariffs:** until effective dates exist, new
   writes use the current tariff version. Acceptable?
3. **Timestamp semantics:** verify start-vs-end before migrating archives, so
   the conversion and new writes agree.

## Implementation slices (each a PR into `feat/single-compact-store`)

1. **Codec + schema:** v2 payload encode/decode, `attribution`/`status`/
   `fetched_at` columns (idempotent migration), segment derivation and
   samples×segments rollup, metadata checksum v3; v1 still readable. Pure
   functions with tests first.
2. **`writeDay`** (open days, `fetched_at` guard, `requireSoe`) and reader
   support for open days.
3. **v1 → v2 migration script** with verification and batching.
4. **Writers behind a flag:** today-refresh (+ latch), gap-heal, sync, repair.
5. **Cutover:** Tesla backfill for tokened sites, ops tooling, pause the
   archive job, stop raw writes, later drop `EnergyData`.
