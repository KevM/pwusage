# Compact history staged PR readiness implementation plan

**Goal:** Make the raw-retaining compact history pipeline operable, bounded and reviewable without enabling production reads, deleting history or spending Tesla API budget.

**Architecture:** A site-scoped maintenance service previews up to 31 site-local days using scalar raw coverage and database-side archive integrity checks. Explicit apply finalizes at most seven days per invocation, stops on contention/time limits, and reports remaining work and gaps using the existing importer audit rules. Two recent completed days remain an editable buffer. No automatic recovery, trim or cron activation is part of this first staged PR.

**Tech stack:** TypeScript, injected PostgreSQL pool, Vitest, existing lossless codec and finalizer.

1. Add failing unit tests for preview/apply, strict bounded CLI arguments, gaps/empty days, archive reuse/rebuild, elapsed budget, busy/failure propagation and no writes in preview. Add real database tests for snapshot bounds/DST/role/integrity and measured maintenance transfer.
2. Implement scalar-only maintenance snapshot in the store and a pure coordinator. Add dotenv-first CLI with explicit site/local-date range, preview default, --apply and --rebuild, aggregate output without account identifiers or raw samples. Resume by remaining local dates; preserve historical tags and all raw samples.
3. Validate against the supplied production archive locally: run all migrations, compare finalization/retries, measure plan/apply/retry response bytes and updated archive+summary allocation. Never connect to live production/Tesla. Remove restored copies after validation.
4. Review the entire branch against the default base, resolve findings, run full tests/lint/build and commit verified work. Prepare a cohesive draft PR description and rollout/rollback checklist locally; do not open the PR.

## PR boundary and activation gates

This is a foundation PR with raw data retained. Storage savings become operational only after a later archive-preserving trim protocol handles corrections to already-pruned days, recovers original samples before partial imports/timezone changes, bounds paid recovery, proves restore/recovery and receives first-trim approval. The existing invalidation triggers rely on retained raw rows; ordinary deletion is not trimming. Keep COMPACT_HISTORY_READS_ENABLED unset. Before applying any archives, deploy cleanup safeguards/migrations together. Run previews and selected-site local parity checks before any separately authorized production apply. Historical LoadTags remain intact once archives exist.

## Readiness result

Bounded maintenance, compressed-payload integrity, explicit rebuild, resulting attribution reports and local operating guide are implemented. The full suite passed 1,148 tests / one existing skip, lint and production build passed. Local backup migrations and parity/transfer/allocation validation passed; whole-branch persistence, reader and billing reviews found no blocking issues. Current origin/main is included. Disposable fixture removed, supplied zip retained. The draft PR description is saved locally; no PR, rollout, paid recovery or raw deletion was performed. This branch is ready for a draft PR within the raw-retaining scope above.
