# Compact history persistence checkpoint

## Implemented

Generated migration `20261007093013_compact_energy_history.sql` creates versioned daily archive and scalar tariff/schedule summary tables with site/revision foreign keys, uniqueness, bounded payload/sample metadata, RLS, no public/anonymous/authenticated grants and service-role access. It performs no backfill or deletion.

`CompactHistoryStore` supplies the opt-in reader with a repeatable-read, read-only snapshot containing raw samples, complete intersecting archived local days and summaries of the same revision. Detail windows are capped at 366 days and 105,408 raw samples. This is a pagination/resource guard, not a history-retention or tier restriction.

Finalization claims a transaction-scoped advisory lock per site without waiting; a busy site returns `busy` for later retry. It validates completed local-day boundaries, reads at most 4,097 samples (the codec rejects more than 4,096), verifies exact archive recovery, computes summaries, audits the original historical tariff definitions and atomically replaces archive plus summaries. Every raw row remains intact. Empty days remain absent. Retries retain the revision only when stored payload, metadata and every summary still match; corrupted stored summaries rebuild from raw data.

Null schedule inference does not silently change source IDs: affected days remain incomplete for billing. Missing/foreign schedules, recorded timestamp-period disagreement and nonfinite rates also prevent a completed-attribution marker. The archive keeps detail for those days. Gap repair and ID repair remain separate work.

A BEFORE raw-mutation trigger takes the same lock and invalidates any affected archive, cascading its summaries. It handles inserts, updates, deletions, and old/new site/timestamp identities. The raw mutation and invalidation commit or roll back together. A timezone-change trigger also takes the site lock and invalidates all that site's archives so new local-day boundaries cannot overlap old ones. Rebuilding is explicit; this checkpoint has no scheduling job.

## Production backup validation

The user supplied a production backup dated October 2, 2026. Restored only Site, Tariff, TariffSeason, TariffSchedule and EnergyData into a separate disposable local PostgreSQL 18.6 database. Application columns, relevant sequences, constraints and indexes were restored; the Site-to-User foreign key and Supabase auth, cron/network extensions, ownership/publications and unrelated application tables were excluded. This is a realistic energy/tariff fixture, not a full Supabase restore rehearsal or production migration-CI substitute. No live connection was used. Only anonymous aggregates are committed.

Selected up to 30 sites with stored energy and five completed-day offsets (1, 2, 30, 90, 180) from each site's latest local midnight. Of 150 windows, 73 were empty; **77 days / 20,256 samples** were finalized. All archive detail and rollup values matched their raw source exactly. All 77 retries retained their revision, and the raw row count was unchanged. **One day** remained incomplete for historical tariff attribution and was not admitted to archived billing.

Compressed daily payloads ranged from **582 to 2,390 bytes**, mean **1,696 bytes**. Allocated archive table/index/TOAST storage was **262,144 bytes**, with **139,264 bytes** for summary storage. Dividing this small allocation by 77 days and projecting to 365 days gives about **1.90 MB/site/year**. This is a bounded, non-random sample with incomplete days, fixed small-table overhead, new indexes and no lifecycle bloat; it is not a production capacity guarantee. Raw rows were retained, so this test does not itself free disk space. The earlier conservative 2–5 MB/site/year planning range remains useful.

Mean first-finalization time was **1.81 ms**, maximum **20.17 ms** on the local restored fixture; retry time is excluded. These are local measurements, not hosted-database latency forecasts.

## Safety and follow-ups

No route/default reader activation, Tesla fetch, remote migration/deployment, cleanup change, premium policy change, notices, raw deletion or PR #126 change was performed. Atomicity and concurrency were exercised with synthetic local integration tests; production history was used for bounded storage/fidelity checks.

The mutation triggers add per-site coordination to raw writes after migration deployment. Multi-site bulk mutations can deadlock across row order and need retry handling; current importer batches are site-specific. Triggers are ordinary application triggers: privileged replication-role bypass or disabling triggers violates the protocol. Parent deletes/truncation and privileged metadata edits are maintenance operations requiring explicit archive handling. Higher-level multi-call billing reads still need revision coherence when concurrent corrections occur. Append-only historical tariff definitions remain required.

The reader currently decodes archives for integrity checks and the snapshot still returns overlapping raw rows. Therefore this checkpoint does not yet optimize billing-read cost or replace the raw-data source. Persisted coverage metadata needs extension/integration with gap auditing before deleting history. Latest/has-data/coverage and all importer/repair paths must become archive-aware. Site timezone corrections also require readers to use fresh timezone metadata. The future trimming path must distinguish verified trimming from corrections: the current DELETE invalidation trigger would otherwise delete archives too.

Next: integrate gap/coverage and correction scheduling, provide verified summary-only billing reads, stage opt-in comparisons in the app, and prove full restore/recovery and migration CI before any first-trim approval.

## Reproduce

Synthetic integration tests run only with `COMPACT_HISTORY_TEST_SOCKET` pointing to a private directory matching `/private/tmp/compact-energy-pg-<suffix>` on Unix socket port 55439. They create and remove their own disposable database and never use DATABASE_URL. Production-archive validation uses `scripts/validate-compact-history-archive.ts <private-socket> compact_production_archive <anonymous-report-path>` after an isolated application fixture is restored. It refuses other database names/socket shapes and never calls Tesla.

## Verification

The generated migration applied successfully to both synthetic fixtures and the restored production-energy fixture. All 13 database integration cases passed. Full suite with those cases enabled: **1,057 passed, one existing skipped**; lint and production build passed. Independent review found no remaining actionable defects after timezone invalidation was added. The local cluster was stopped and its extracted/restored production copies and logs removed; the user-provided backup zip remains intact. Diff checks passed.
