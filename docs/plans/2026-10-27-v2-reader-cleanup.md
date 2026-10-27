# V2 history reader cleanup

**Goal:** Remove runtime support for raw-table snapshots, format-1 payloads and metadata versions 1/2 now that production and dev contain only format 2 / metadata 3 records.

**Rollout:** First deploy code that no longer reads or writes `raw_pruned`, while leaving the existing column/default and constraints in place. A separate generated migration can then drop the unused column and tighten format/metadata constraints. Dropping the column before the old deployed writer is replaced would break its named-column INSERTs.

1. Preserve v2 codec precision, DST/offset axes, gzip/brotli, billing/version boundaries, partial-day reads, coverage, freshness/SOC cutoff behavior, corruption rejection and query budgets. Add rejection coverage for valid legacy payloads and metadata.
2. Make snapshots day-only and attribution required. Replace v1/raw reader fixtures with v2 fixtures and retain applicable behavioral assertions.
3. Remove v1 encode/decode branches, metadata 1/2 digests, the unused v1 converter, tariff audit/storage benchmark and unused recovery exports. Keep shared rollup math and all active checksum validation.
4. Require format 2 / metadata 3 on every store projection/detail path. Stop mentioning `raw_pruned` in writers; omit it so both old and future schemas work.
5. Run full unit tests, private PostgreSQL history tests, lint and production build; commit a draft code-cleanup PR.
6. On a follow-up branch, generate the schema migration using `npm run db:migration:create`. Refuse unexpected legacy rows, remove `raw_pruned` with its dependent checks, preserve the empty-record invariants and service-only integrity functions, and test against the full migration chain. Keep that draft PR separate until the code cleanup is deployed.

Old backups remain recoverable with their corresponding historical code checkout. This work does not rewrite production samples or apply a remote migration.

## Rollout checklist

- Merge and deploy code cleanup PR #238.
- Confirm the serving deployment uses the new writer before merging the dependent schema PR. Old deployment rollbacks would need code compatible with the removed column.
- Apply generated `20261027180001_drop_legacy_day_record_state.sql` through the normal migration workflow. It refuses legacy versions, keeps empty/nonempty record constraints, retains service-only verification, and leaves payloads/summaries unchanged.
- Refresh dev-copy CSV exports after the schema change: their dynamic column header must match the target schema.
- Verify history, billing, SOC/freshness and scheduled day writes after rollout.
