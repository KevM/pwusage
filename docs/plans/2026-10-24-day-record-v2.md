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
- **Sample labels follow Tesla's own bucketing: a label is its interval's
  start** (verified 2026-10-24 with `scripts/probe-tesla-day-boundary.ts`:
  Tesla's 30-minute buckets for Harrison equal the sum of the 5-minute samples
  labeled `h … h+25` exactly, for grid import and home usage on every bucket
  checked; summing `h+5 … h+30` is off by 8–22 Wh). A day is the samples
  labeled `00:00 … 23:55`, which is what the importer stores today. Samples do
  appear ~75–85 s after their label already looking complete, so Tesla may
  measure with a lag or label ahead; matching Tesla's own aggregates is the
  only checkable reference, so the label-as-start convention stays.
- **Derivation:** walk the day's 5-minute slots, price each with
  `Schedule.getTariffPeriod(t)` for the sample labeled `t` (unchanged from
  today), then run-length encode. Segment boundaries fall on 5-minute marks; a
  schedule boundary that isn't on one (none exist today) takes effect at the
  next slot.

### Status and freshness (new columns)

- **`status`** `open | complete | gapped`:
  - `complete`: the day has ended and `sample_count = expected_slots`. Never
    refetched.
  - `open`: today, or an ended day with missing samples. Refetched by
    today-refresh (today) or gap-heal (recent past days).
  - `gapped`: an ended day short of samples and older than the gap-heal window
    (14 days). Tesla never had the missing samples (gateway offline, the
    install-to-utility-approval gap, Tesla-side loss), so refetching would only
    return the same gaps. Kept as is, never refetched automatically; a repair
    can still replace it. No fetch counters: age alone decides.
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

## Backfill

Backfill walks every day from the newest missing day back to `Site.installed`,
fetching each once. It writes `complete` or `gapped` records as Tesla returns
them; a `gapped` day never stops the walk (`gapped` only means "don't retry
this day automatically"). Days that come back empty get no record; the empty
stretch right after install (hardware install → utility approval, e.g.
Harrison 11-14 → 11-28) is recorded once in `Site.history_backfill_from` so
later runs start there. The 14-day gap-heal window governs automatic retries
only, never how far back a backfill goes.

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

**Implemented (slice 3):** `scripts/convert-archives-v2.ts` →
`CompactHistoryStore.convertDayToV2` and `compact-v1-conversion.ts`.

- **Verification** (any failure leaves the day v1 with a reason): the v1
  archive passes reader/recovery verification (payload, metadata, summaries,
  projection); decoded v2 samples equal the v1 samples minus the tariff
  columns; samples × segments reproduce every v1 sample's IDs and the stored
  summaries exactly; `attribution_complete` is unchanged; the new record reads
  back through recovery to the v1 rows; the database's v3 digest check passes
  before commit. `timelineRevision` is `v1-conversion:<v1 revision>`.
- **Days that still have raw rows convert too.** Every Prod archive (2,428 on
  2026-10-24) is unpruned, so skipping them would convert nothing. The archive
  stays the read source either way, trim reconciles a v2 record against raw
  (its rows recover with the same IDs), and `finalizeDay` now keeps a converted
  record while it recovers to exactly the raw rows, so neither the archive job
  nor a rebuild reverts it to v1. `raw_pruned` is kept as stored.
- **Settled flag:** chart, bucket, billing, freshness and coverage counts read
  the same. Coverage's `archived` (settled) flag follows v2 status, so it moves
  only for an ended short day older than 14 days (now `gapped`, so gap-heal
  stops refetching samples Tesla never had) and for a v1 day with incomplete
  attribution (v2 settles by samples; a refetch cannot fix tariff setup).
- **Left v1 by design:** a gap spanning a period boundary on a day v1 billed as
  fully attributed (`unattributed-gap`: v2 would mark those minutes `null`
  and refuse billing), samples off the 5-minute grid, and v1 days flagged
  incomplete although every sample has a schedule.
- **Cost:** reads only the archive row and its summaries; measured ~5 KB per
  day of PostgreSQL responses, reserved conservatively at the payload + 24 KB
  (`--max-mb`, default 16; `--max-days`, default 500).
- **Resuming:** v2 rows are never selected again. A run stopped by a cap
  prints `resumeAfter`; `--after <siteId>/<day>` continues past the days it
  examined, so days left v1 never block later ones.

## Decisions (settled 2026-10-24)

1. **`gapped`:** an ended, incomplete day older than the gap-heal window.
2. **Segments use the tariff version current at write time** until
   effective-dated tariffs exist; days are re-attributed as past tariffs are
   backfilled.
3. **Labels mark interval starts,** matching Tesla's own 30-minute and daily
   bucketing (verified). Attribution keeps `getTariffPeriod(t)`; day
   boundaries are unchanged.

## Implementation slices (each a PR into `feat/single-compact-store`)

1. **Codec + schema** (done): v2 payload encode/decode, `attribution`/`status`/
   `fetched_at` columns (idempotent migration), segment derivation and
   samples×segments rollup, metadata checksum v3; v1 still readable. Pure
   functions with tests first. Landed as `encodeDaySamples`/`decodeDaySamples`
   (`compact-energy.ts`), `day-attribution.ts` (`deriveDayAttribution`,
   `segmentsFromV1Rows`, `rollupSamples`, `dayStatus`), `buildDayMetadataV3`
   (`compact-day-metadata.ts`) and `20261024190000_day_record_v2_schema.sql`,
   which also lets `verify_compact_day_metadata` check v3 digests in
   PostgreSQL. In `segmentsFromV1Rows`, an edge gap (before the first or after
   the last sample) takes its single neighbour's attribution.
2. **`writeDay`** (done): open days, `fetched_at` guard, `requireSoe`, and
   reader support for open days. Landed as `CompactHistoryStore.writeDay(siteId,
   dayStart, samples, fetchedAt, now)`, which replaces `writeDayFromSamples`:
   writes any started day (today included), refuses samples off the site day or
   its 5-minute grid and days that still have raw rows, derives segments from the
   site's `is_current` tariff (lowest ID names the `timelineRevision`), and
   returns `superseded` when the stored `fetched_at` is the same or newer.
   `fetchDayForWrite` (`compact-day-fetch.ts`) is the one Tesla fetch for a day
   (SOE required, up to `now` for today, `fetchedAt` = response time); the backfill
   script uses both. Readers decode format 2 through its segments (charts,
   coverage, billing, latest sample/SOC, maintenance); `SETTLED_ARCHIVE_DAY_SQL`
   treats a v2 record as settled only when `complete` or `gapped`, so an `open`
   day counts its real samples for gap-heal. Freshness reads (`getLatestTimestamp`,
   `getLatestBatterySoc`) take an optional as-of time and include today's open
   record. A v2 day can be restored to raw rows (samples × segments) when a late
   raw import touches it, as v1 days could, until the writers switch.
3. **v1 → v2 migration script** with verification and batching. *(Done.)*
4. **Writers behind a flag:** today-refresh (+ latch), gap-heal, sync, repair.
5. **Cutover:** Tesla backfill for tokened sites, ops tooling, pause the
   archive job, stop raw writes, later drop `EnergyData`.
