# History archive safety Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Address the confirmed PR #135/#137 review findings before production activation.

**Architecture:** Preserve lossless archives and append-only tariffs. Lock and verify the archive control revision within each mutation transaction; provide bounded revision-checked restoration; retain archive-aware access for pruned sites regardless of the rollout switch. Surface missing historical pricing explicitly without inventing costs.

**Tech Stack:** TypeScript, PostgreSQL 17+, Next.js, Vitest, GitHub Actions.

## Tasks

1. Test control changes between discovery/finalization/trim, including replacement cohorts and date bounds. Update `history-archive-service.ts`, `history-archive-repo.ts` and `prototypes/compact-history-store.ts` to carry the control row revision and lock/check it within admitted transactions. Run service tests and real database races before committing.
2. Correct the stale 45s fixture in `prototypes/compact-history-store.test.ts`. Add a private-socket synthetic PostgreSQL runner in `scripts/` and require its suite in the existing CI test job. Assert late added samples survive finalize/trim/restore/retrim.
3. Test and implement bounded preview/apply recovery in `history-archive-recovery.ts` and `scripts/restore-history-archive.ts`. Require paused control, explicit reviewed revisions and day/time budgets. Report remaining pruned days for rollback; preserve corrupt/busy archives.
4. Test flag-off reads/writes for pruned sites in `energy-repo-factory.test.ts` and `energy-repo-compact-writes.test.ts`. Make archive-aware access mandatory for pruned data, and document the historical switch's write behavior and bounded batches.
5. Test incomplete-attribution errors and presentation in compact reader, mobile bill and TRMNL routes. Keep integrity errors fatal; missing pricing becomes typed unavailability, never a shortened numeric bill. Update usage page and preserve live/device chart data.
6. Update `cmd/next-app/README.md` and the operations guide with retention transition, restoration commands, staged activation, capacity constraints and rollback. Retain tariff deletion protection; do not restore destructive cleanup.
7. Run synthetic database/full tests, lint and production build. Review final diff, record evidence in `task.md`, commit verified work. No hosted database mutation, flag activation or production deployment in this task.
