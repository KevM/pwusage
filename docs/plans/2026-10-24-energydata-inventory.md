# EnergyData inventory for a single compact store

Date: 2026-10-24. Scope: everything that reads or writes the raw 5-minute
`EnergyData` table, and what each needs so that a compact per-(site, day)
record (`EnergyDayArchive` + `EnergyDaySummary`) can be the only store.

## Target, in one paragraph

Tesla is the system of record and the site-day is the unit of work. Each Tesla
fetch for a day replaces that day's compact record (`fetched_at` guards against
an older fetch landing last). A day that has ended with all 288 samples is
`complete` and never refetched; today and gappy past days are `open`. Billing
summaries, the latest-sample projection and coverage are derived when the
record is written. No raw rows, so no archive job, trim, restore, invalidation
trigger, retention cutoff or merged raw+archive reads. First step landed in
#196: `CompactHistoryStore.writeDayFromSamples` + `scripts/backfill-compact-from-tesla.ts`
(a month in ~45 s, ~2.7 KB/day, no read egress).

## Summary

Direct SQL on `EnergyData` in app code is confined to six files. Everything
else goes through `EnergyRepo`, and most reads already go through the compact
reader when `COMPACT_HISTORY_READS_ENABLED=true` (on in Prod). The real work is
the **write path** (importer → raw upsert), **four raw-only readers**, the
**coverage/planning query**, and **ops tooling** (backups, dev copy).

## Writers

| Writer | Path | Today | Needs |
|---|---|---|---|
| Today refresh | `today-refresh.ts` → `Importer.getTodayData` + `persistHistory` → `EnergyRepo.insertEnergyDataBatch` | Upserts today's (and yesterday's tail) raw rows, up to once a minute | Write today's open day record (whole day so far, replace); add the 5-minute data-aligned latch |
| Range imports (sync, import, gap-heal, repair, migrate script) | `Importer.ensureDataForRange` / `importWindows` / `loadInterval` / `refetchDays` → `insertEnergyDataBatch` | Upserts day windows of raw rows | Write one day record per fetched day (`writeDayFromSamples`, extended to open days) |
| Insert path with compact reads on | `insertEnergyDataBatch` → `CompactHistoryStore.writeEnergyDataBatch` | Restores pruned days to raw, then upserts rows | Removed |
| Archive job / healed-day archive | `history-archive-*`, `healed-day-archive.ts` | Finalizes/trims raw days | Removed (no raw to archive) |
| Retention delete | `EnergyRepo.cleanupOldEnergyData` | Legacy, already retired from the cron | Removed |

## Readers

### Already compact-ready (go through the reader interface)

`EnergyRepo` methods that delegate to `historyReader` when built by
`createEnergyRepo` (10 call sites: dashboard, mobile, TRMNL markup, live page,
analysis, load planning, sankey/NILM via the repo, bill outlook, etc.):
`getRawEnergyData`, `getBucketedEnergyData`, `getCycleAggregates`,
`getCycleAggregatesAndCoverage`, `getDailyCoverage`, `getLatestEnergyData`,
`getLatestBatterySoc`, `getLatestTimestamp`, `hasData`. Composite methods
(`getUsageByTOU`, `getBillOutlook`, `getCycleAndTodayTotals`, `getTodayTotals`)
call those, so they follow. Today these read **today from raw**; once today is
an open day record the compact reader must read open records (it already
decodes partial days, so this is a status/selection change, not a codec one).

### Raw-only (bypass the reader: `new EnergyRepo()` or direct SQL)

| Reader | Location | Reads | Replacement | Status |
|---|---|---|---|---|
| Today refresh "latest stored sample" | `today-refresh.ts` `getLatestEnergyData` | newest stored sample (also decides yesterday's tail) | `createEnergyRepo(site.timezone).getLatestEnergyData` (raw or day record, whichever is newer) | Done |
| Battery-hold monitor | `battery-hold-monitor-service.ts` `getRawEnergyData` | last 30 min | `createEnergyRepo(site.timezone).getRawEnergyData` (decodes an archived yesterday) | Done |
| Gap-heal pre-check | `gap-heal.ts` → `EnergyRepo.countAlignedSamples` | raw samples + settled archive days (#193) | Also counts `sample_count` of unsettled on-grid days with no raw left (`raw_pruned`, incl. `writeDayFromSamples`); off-grid days go to the audit | Done; later: count from day-record status once raw is gone |
| Gap-heal / import planning | `gap-heal.ts` `planMissingWindows(new EnergyRepo())`, `Importer.planMissingWindows` | coverage via `createEnergyRepo(...).getDailyCoverage`; the `EnergyRepo` argument is only the flag-off raw fallback | No change needed now; later: plan from day-record status (refetch `open` days only) | Already compact-aware |
| Admin last import | `user-repo.ts` `getAllUsers` | newest stored sample per user | `latestStoredSampleSql` (`GREATEST` of raw `max(timestamp)` and the newest archive's `last_timestamp`, two index lookups per site) | Done; drop the raw half with the table |
| Admin Sites tab ordering | `site-repo.ts` `getHistoryOverview` | newest stored sample per site | Same `latestStoredSampleSql` | Done; drop the raw half with the table |
| Health check | `app/api/health/route.ts` | `COUNT(*)` of day records (`energyDays`, "Stored Days") | — | Done |

`Site.last_import_at` was considered for the admin columns but is the import
lock's acquire time, not data freshness, so it was not used.

## Database objects tied to EnergyData

- Trigger `invalidate_compact_energy_day` (BEFORE INSERT/UPDATE/DELETE) and functions `invalidate_compact_energy_day`, `invalidate_compact_energy_timezone`, `compact_raw_day_digest`: dual-format machinery, dropped with the table. The timezone-change invalidation still matters in the new model: day records are keyed by site-local midnight, so a corrected site timezone must mark affected days for refetch.
- Foreign keys on `EnergyData`: `site_id → Site ON DELETE CASCADE`, `tariff_id → Tariff ON DELETE CASCADE` (contradicts DesignDecisions §2; see TODO "Effective-dated tariffs"), `tariff_schedule_id → TariffSchedule ON DELETE SET NULL`. Gone with the table. `EnergyDaySummary` already follows §2: its `tariff_id → Tariff` and `tariff_schedule_id → TariffSchedule` keys have no cascade (a tariff used by history cannot be deleted), and summaries cascade only from their own archive row.
- Indexes `idx_energy_site_ts`, `energy_ts_site_uidx`, `EnergyData_pkey`, `idx_energy_tariff_id`: ~150 MB, freed on drop.

## Ops tooling

| Tool | Today | Needs |
|---|---|---|
| Daily backup (`db-backup.yml`, `dump-db-backup.sh`) | All tables except `EnergyData` history (+ a recent raw slice) | Nothing removed; day records are already in it, so the daily backup becomes a **complete** history backup |
| Weekly full backup / restore (`restore-db-backup.sh`) | Combines weekly `EnergyData` with the daily recent slice, fixes the id sequence | Drop the `EnergyData` merge steps |
| Dev copy (`ci.yml` + `export-dev-energy-data.sql`, `load-dev-energy-data.sql`, `prune-dev-copy.sql`) | Copies all tables except `EnergyData`, plus a recent raw slice, re-applying its FK actions by hand | Drop the raw slice; the archive tables already come across |

## Dual-format code that is removed

`HistoryArchiveRepo`, `history-archive-service.ts`, `history-archive-control.ts`,
`healed-day-archive.ts`, `history-archive-recovery.ts`, the `/api/cron/cleanup`
archive job and its pg_cron trigger, `HistoryArchiveControl` / `HistoryArchiveRetry`,
`CompactHistoryStore`'s `finalizeDay` (raw source), `trimDay`, `restoreDay`,
`writeEnergyDataBatch`, raw-overlap merging in `snapshot` / `readAggregateSnapshot`
/ `readScalarSnapshot`, `withRawEnergyAccess` / `energy-storage-access.ts`,
`compact-analysis-sync-policy.ts`, and `history-migration.ts`'s raw backfill +
archive (replaced by the Tesla→compact backfill).

Maintenance scripts that query `EnergyData` directly (`backfill-soc.ts`,
`backfill-tariff-schedule.ts`, `fix-tariff-schedule-range.ts`, `check-sites.ts`,
`check-soc-coverage.ts`, `validate-import.ts`, `verify-sync-daily-coverage.ts`,
`load-planning-context-capture.ts`, the compact `measure-*` / `validate-*` /
`prototype-*` scripts): retire, or port the few still useful to day records.

## Decisions to make before switching writers

1. **Tariff attribution — decided: a per-day segment timeline.** Samples stay pure Tesla data (no per-sample `tariff_id`/`tariff_schedule_id` in the payload). Each day record carries its attribution as an ordered list of segments, e.g. `[{offset: 0, scheduleId: off-peak}, {offset: 480, scheduleId: on-peak}, {offset: 1260, scheduleId: off-peak}]`.
   - **Offsets are minutes from `day_start`** (or absolute timestamps), never local clock times, so DST days are unambiguous (the fall-back day repeats 1:00–2:00 local).
   - **The schedule ID pins the rates:** a `TariffSchedule` belongs to a season of one append-only tariff version, so it identifies the exact version; `tariff_id` may be stored alongside for convenience.
   - **Gaps are explicit:** a segment with no schedule (no matching period) marks the day's attribution incomplete instead of pricing it with a synthetic fallback.
   - **Provenance:** the record notes which tariff-timeline revision produced the segments, so once effective-dated tariffs exist (TODO "Effective-dated tariffs"), stale days are a query.
   - **Summaries** (`EnergyDaySummary`) are derived from samples × segments when the record is written, and re-derived when segments change.
   - **Re-attribution** (a back-dated tariff, a correction) rewrites only a day's segments and summaries from stored samples: no sample rewrite, no Tesla refetch.
   - Until effective dates exist, segments come from the tariff version current at write time, as today.
2. **Open days**: status (`open`/`complete`), `fetched_at` replace guard, and the completeness rule (ended + 288 samples; DST days 276/300).
3. **SOC**: keep per-sample `battery_soc` where Tesla returns it, or store an hourly SOC series per day.
4. **Refresh latch**: fetch at most once per new 5-minute sample, ~2 min after each boundary (measured: samples appear 75–85 s after their timestamp and never change).
5. **Cutover**: sites with working tokens backfill from Tesla; sites without keep their archived 45 days; stop raw writes behind a flag, keep `EnergyData` read-only for a safety period, then drop it.

## Rough size

- Write path: importer write sites + open-day support + latch.
- Raw-only readers: 7 small changes.
- Ops tooling: 3 scripts/workflows simplified.
- The rest is deletion.

Attribution (1) was the one decision with long-term reach and is settled; the rest is mechanical.

## Working branch

Integration branch: `feat/single-compact-store`. Sessions branch from it and
open PRs back into it; it merges to `main` once the cutover is ready.
