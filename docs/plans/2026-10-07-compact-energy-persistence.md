# Compact Energy Persistence Implementation Plan

**Goal:** Persist coherent, verified archive/summary revisions and finalize completed local days atomically while retaining all raw rows.

**Architecture:** Generated restricted archive/summary tables, a pg snapshot store, and a finalizer serialized with raw writes by transaction-level per-site advisory locks. A raw mutation trigger invalidates an affected revision before edits. Reads use repeatable-read snapshots; finalization uses read-committed after acquiring the lock. No route activation, cron, cleanup changes or raw deletion.

**Tech Stack:** PostgreSQL, pg, TypeScript, existing codec/audit, Vitest and disposable local PostgreSQL.

1. Generate migration through the repository script. Add site/day/revision identity, constrained archive metadata, scalar schedule summaries, FK/indexes, RLS and restricted grants. Add raw-mutation invalidation trigger using the same per-site lock as finalization; account for old and new site/timestamp on update.
2. Add local-only integration tests before implementation: migration restrictions, raw-retaining finalization, idempotency, atomic rollback, mixed/partial reads, invalidation on correction/delete/move, simultaneous finalizers and concurrent imports. Use private disposable socket; no configured source database.
3. Implement pg store with bounded repeatable-read snapshots and original-type numeric mapping. Fetch summaries/archive from the same revision. Preserve raw overlap for integrity validation. Implement finalizer with a nonblocking claim, timeouts, local-day/site validation, bounded sample read, historical tariff audit, exact recovery and summary reconciliation, atomic replace and retry no-op. Do not repair IDs or discard unresolved samples.
4. Exercise migration and store against local PostgreSQL, including role denial and service_role access. Shut down and remove private cluster. Independent review; full tests, lint, production build; document limits and commit.

Production gates remain: migration CI on production backup, production sampling, gap repair budget/coverage integration, default reader activation, revision coherence across higher-level calls, recovery/backup rehearsal and explicit deletion approval. The trigger invalidates archives on any raw mutation; a future trimming path must distinguish verified trimming from corrections before deletion is enabled.
