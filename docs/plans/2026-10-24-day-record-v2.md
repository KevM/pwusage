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
  - Status is stored when the record is written, so it can go stale with no
    further write: an `open` day older than the gap-heal window is read as
    `gapped` by planning (`auditDays`), the same age rule `dayStatus` applies
    on a rewrite. A day whose last write came before its end (stored `open`
    even with every sample) is rewritten by today-refresh after midnight, so its
    stored status becomes final.
- **`fetched_at`**: when the Tesla request was made (not when the response
  arrived). A write replaces the record only if its `fetched_at` is newer than
  the stored one. Published samples never change, so a later request sees at
  least what an earlier one did; an earlier, slower request that arrives last is
  `superseded` instead of overwriting newer data. (Slice 2 stamped the response
  time, which let exactly that happen; changed in slice 4.) Ordering relies on
  instance clocks agreeing to well under a request's duration.
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

### Empty days (decided 2026-10-25)

A successful Tesla answer with no samples for a day is a fact worth keeping;
a failed request is not.

- **Marker, not a record:** `writeDay(..., [])` for a day with no record and no
  raw rows inserts `EnergyDayEmpty (site_id, day_start, day_end, checked_at)`
  (migration `20261025120000_day_record_empty_days.sql`; `checked_at` is the
  request time, like `fetched_at`, and only moves forward) and returns
  `checked-empty`. No payload, summaries or reader changes: readers never see
  it. A marker is a few dozen bytes, so even years of empty days cost nothing
  against the 500 MB quota.
- **Fetch failure stays distinct:** `fetchDayForWrite` throws on a failed energy
  or SOE request before `writeDay` runs, so a failure leaves no marker and the
  day reads as "never fetched".
- **Empty after non-empty:** published samples never disappear, so an empty
  answer for a day that has a record (or raw rows) is a Tesla failure. It returns
  `empty` and changes nothing: no marker, the record stays.
- **Samples later:** a non-empty `writeDay` deletes the day's marker in the same
  transaction.
- **Retry age (same rule as `gapped`):** `getSettledEmptyDays` treats a marker as
  final only when its check was requested after the day ended
  (`checked_at >= day_end`, as `isDayFetchFinal`) and the day is older than the
  14-day gap-heal window, and nothing has been stored for the day since. Inside
  the window an empty day is retried like an `open` one (gap-heal still sees 0
  samples); after it, a backfill skips it. No fetch counters.
- **Backfill:** `scripts/backfill-compact-from-tesla.ts` reports `checked-empty`
  and skips settled empty days (`settled-empty`) without a Tesla request. Slice
  5's planner uses the same query. `Site.history_backfill_from` stays as the
  cheap lower bound for the leading pre-provisioning run; markers cover interior
  days, which a single checkpoint cannot (one failing day would pin it).
- A timezone change drops the site's markers with its archives (re-checking an
  empty day costs one request).

## Reads

- The compact reader treats `open` days like any other record (it already
  decodes partial days); today's data comes from today's record.
- During the transition the reader still merges raw rows where they exist
  (#197). Reading both formats is not enough to flip writers on its own; see
  "Writer handoff" below.

## Writer handoff (flag on, during the transition)

- **Days that already have raw rows** are replaced, not refused: the importer's
  `writeDay(..., {replaceRaw:true})` deletes the day's raw rows in the same
  transaction as the v2 write (slice 4). Today's raw rows go the same way on the
  first latched refresh.
- **An in-flight raw writer** (an instance still on flag-off code, or a
  request that started before the flip) that touches a v2 day: with compact
  reads on, `writeEnergyDataBatch` restores the day to raw rows first and
  upserts, so nothing is lost; the next importer write replaces it again. With
  compact reads off the raw-insert trigger refuses the write. So the flag is
  only turned on where compact reads are on (Prod), and only after a deploy has
  drained flag-off instances.
- **Rollback** (flag off again): raw writes resume; a v2 day they touch is
  restored to raw as above, and untouched v2 days keep reading from their
  records. No data migration is needed either way.
- **Sites without working Tesla tokens** are never written by the importer, so
  their raw rows and v1 archives stay as they are until slice 5's cutover
  (convert in place; no refetch possible).
- **Timezone changes** are no longer a failing refresh; see "Timezone changes"
  below.

## Timezone changes (decided 2026-10-25)

Day records are keyed by local midnight, so a `Site.timezone` change moves every
day boundary. The `invalidate_compact_energy_timezone` trigger still refuses the
change while any day is pruned (it can't move a record that is the only copy);
instead a change is a coordinated rebuild, and the site refresh never fails on it.

- **Refresh keeps the old timezone:** `upsertSite` (`UPSERT_SITE_SQL`) keeps the
  stored timezone while the site has any pruned day, stores Tesla's reported one
  in `Site.json` as always, and returns the stored value; `Importer.ensureSite`
  logs the mismatch with the script to run. Without pruned days the change goes
  through as before (the trigger drops the unpruned archives, raw rebuilds them).
- **Rebuild** (`CompactHistoryStore.rebuildTimezone`, operator script
  `scripts/rebuild-site-timezone.ts --site-id <id> [--timezone <tz>] [--apply]`,
  default timezone = Tesla's reported one): one transaction under the per-site
  claim and the archive control row, so readers and writers see either the old
  partition or the new one, never both.
  1. Decode every pruned day (verified as recovery does). Unpruned archives are
     not read: their raw rows already hold the samples. An unpruned archive
     whose raw row count differs (a damaged pruning marker) aborts the rebuild
     before anything is deleted, as the trigger would.
  2. Delete the site's markers and archives, then update `Site.timezone` (the
     trigger now allows it).
  3. Regroup the pruned samples by the new local midnight. A new day built only
     from pruned samples becomes a v2 record: segments from the current tariff
     under the new timezone (TOU periods are local-clock, so the old attribution
     is wrong after the change anyway), status by the usual rule, `fetched_at`
     its oldest source's, so any later Tesla fetch replaces it. A new day that
     raw rows also touch gets its pruned samples back as raw rows (writes only,
     no read-back), and raw stays its single source until the archive job or a
     refetch writes it.
  4. Re-price every raw row (restored or already raw) on the new clock from the
     current tariff, so billing and later archiving never use old-timezone
     periods (a 16:00 UTC peak sample is 11:00 off-peak in Chicago). Segments
     are derived per local day in TypeScript and applied as timestamp ranges in
     one `UPDATE`; no raw rows are read back and only changed rows are written.
     Tokenless sites need this, since they can't refetch.
  5. Preview runs all of it and rolls back.
  No Tesla request, so tokenless sites rebuild too. Cost: one read of the
  site's pruned payloads (~3 KB/day: ~3 MB for a three-year site); the
  transaction has no 15 s budget (operator script, not a function).
- Tested across the fall-back day: three UTC days re-keyed to Chicago become
  four contiguous days (60, 288, 300 of 300, 216 samples), every sample
  preserved, segments at Chicago offsets.

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
read support is removed (not kept indefinitely). Every class the converter
leaves v1 by design has a disposition (decided 2026-10-25):

- **`unattributed-gap`, `attribution-flag`: re-attribute** (`--reattribute`,
  `CompactHistoryStore.reattributeV1Day`). The samples are kept exactly; the
  segments come from the current tariff (`timelineRevision: current-tariff:<id>`),
  which is what a Tesla refetch would produce (same published samples) and the
  stated policy for every importer write (decision 2). The v1 attribution is
  not worth preserving here: it is either unreproducible or flagged wrong. No
  Tesla request, so tokenless sites too. A day that still has raw rows (every
  Prod day today) is first proven equal to its archive in the database
  (`compact_raw_day_digest`, no read-back), then its raw rows are deleted with
  the archive, as `writeDay(..., {replaceRaw})` does; otherwise the archive job
  would rebuild v1 from raw. Run only where compact reads are on. New left-v1
  reasons in this mode: `raw-mismatch`, `no-current-tariff`.
- **`off-grid`** (samples not on the 5-minute grid, which v2 cannot store):
  tokened sites refetch the day (`Importer.refetchDays` with
  `COMPACT_DAY_WRITES_ENABLED` on writes a v2 record and deletes raw); Tesla's
  own samples are on the grid. Tokenless sites: snap each sample to the start of
  its 5-minute interval (the label-as-start convention) and re-attribute, unless
  two samples share a slot, which leaves the day for an operator. Not built:
  Prod's first apply left 24 of 2,428 days v1, attributed above to the gap
  rule; per-class counts weren't re-queried for this decision. Build the snap
  only if the converter's `leftV1` report shows a tokenless off-grid day.
- **`integrity`, `day-bounds`, `legacy-metadata`, mismatch reasons:** not
  expected; if any appear, refetch (tokened) or investigate before removing v1
  reads.

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
- **Gaps across a period boundary:** priced with `getTariffPeriod` under the
  tariff version both neighbouring samples recorded, but only when that version
  reproduces both neighbours' schedules (the site's tariff versions are read
  only for such days). Otherwise, including a version change inside the gap,
  the day stays v1 as `unattributed-gap` (v2 would mark those minutes `null`
  and refuse billing a day v1 billed as complete). Prod's first apply
  (2026-10-25) converted 2,404 days and left 24 such days before this rule.
- **Left v1 by design:** samples off the 5-minute grid, and v1 days flagged
  incomplete although every sample has a schedule (`attribution-flag`; 3 Prod
  days on 2026-07-03).
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
   (SOE required, up to `now` for today, `fetchedAt` = response time, request
   time since slice 4); the backfill
   script uses both. Readers decode format 2 through its segments (charts,
   coverage, billing, latest sample/SOC, maintenance); `SETTLED_ARCHIVE_DAY_SQL`
   treats a v2 record as settled only when `complete` or `gapped`, so an `open`
   day counts its real samples for gap-heal. Freshness reads (`getLatestTimestamp`,
   `getLatestBatterySoc`) take an optional as-of time and include today's open
   record. A v2 day can be restored to raw rows (samples × segments) when a late
   raw import touches it, as v1 days could, until the writers switch.
3. **v1 → v2 migration script** with verification and batching. *(Done.)*
4. **Writers behind a flag:** today-refresh (+ latch), gap-heal, sync, repair.
   *(Done; flag off everywhere.)* `COMPACT_DAY_WRITES_ENABLED=true`
   (`compactDayWritesEnabled`, off by default) switches every importer write to
   `writeDay(..., {replaceRaw:true})`; off, the raw path is unchanged.
   - **Raw rows are replaced, not refused** (option a): `replaceRaw` deletes the
     day's archive and then its raw `EnergyData` rows inside the `writeDay`
     transaction, after the `fetched_at` guard (a superseded write deletes
     nothing) and before the v2 insert. Archive first, because the
     `invalidate_compact_energy_day` raw-delete trigger refuses an unpruned
     archive whose `sample_count` no longer matches raw; with no archive left it
     only deletes the rows. No raw read-back. Without `replaceRaw` (the backfill
     script) a day with raw rows is still refused.
   - **Range imports** (`ensureDataForRange` / `refetchDays` → `importWindows`;
     sync, import, gap-heal, repair, migrate script): one `fetchDayForWrite` +
     `writeDay` per site-local day a window touches, the whole day even for a
     partial window. A failed fetch (SOE included) or a `busy` claim fails the
     window and leaves the day as stored. `archiveHealedDays` is skipped (the
     record is the archive). Planning (`planMissingWindows` → `planImport`
     `refetchOpenDays`) refetches every `open` record but today's, however small
     its gaps; `complete`/`gapped` stay settled. Coverage carries `open` from the
     record status.
   - **Today-refresh** (`Importer.refreshTodayRecords`): today's open record from
     the whole day so far, plus yesterday's while it is not `complete` and its
     stored fetch was requested before the day ended (`isDayFetchFinal`), so
     its stored status is final; after that, its remaining gaps are gap-heal's. With no record for yesterday,
     only a missing stored tail fetches it (as the raw path does). Writes run one
     at a time (one per-site claim).
   - **Latch** (flag on or off, `tesla-sample-timing.ts`): `refreshTodayData`
     skips with `not-due`, before tokens or the import lock, unless
     `now >= latestStoredLabel + 5 min + TESLA_PUBLISH_LAG_MS` (2 min; measured
     2026-10-24: new samples appear 16–97 s after their label, typically
     75–85 s, and never change). Labels are absolute, so midnight needs no
     special case: yesterday's 23:55 sample is due at 00:02 and that fetch covers
     yesterday's tail. `force` bypasses it; the import lock still collapses
     concurrent callers; the `live_status` cache is unchanged.
5. **Cutover:** Tesla backfill for tokened sites, ops tooling, pause the
   archive job, stop raw writes, later drop `EnergyData`. Relies on the
   decisions above: settled empty days (`getSettledEmptyDays`) bound the
   backfill, a timezone change goes through `rebuild-site-timezone.ts`, and the
   converter runs with `--reattribute` (plus refetches for `off-grid`) until it
   reports zero v1 rows, after which v1 read support is removed.

   **Cutover log:**
   - 2026-10-25: `convert-archives-v2.ts --apply` on Prod converted the last
     100 v1 days; all 2,667 Prod archive days are format 2 with a status (the
     archive job still writes v1 until day writes are on, so re-run it before
     removing v1 reads).
   - 2026-10-25: `COMPACT_DAY_WRITES_ENABLED=true` set for Preview (beta, Dev
     DB) to verify day writes before Prod.
