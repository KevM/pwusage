# Daily History Archive Implementation Plan

> Execute task-by-task in this chat with test-first verification.

**Goal:** Replace daily destructive retention with bounded resumable archival.

**Architecture:** Reuse verified compact persistence and trimming. Add a paused
singleton control/progress table and per-day retries, a budgeted orchestration
service, a cron adapter and an internal CLI. Production stays inactive.

**Tech Stack:** TypeScript, PostgreSQL/pg, Next.js route, Vitest.

## Task 1: Service behavior
- Create `cmd/next-app/src/lib/history-archive-service.test.ts`: paused/default
  modes, reader prerequisite, boundaries, retries, gaps, budgets, interruptions.
- Run `npm run test -- --run src/lib/history-archive-service.test.ts`; confirm
  missing service fails, then implement `history-archive-service.ts`.
- Run focused tests until all pass.

## Task 2: Durable state and discovery
- Generate migration with `npm run db:migration:create history_archive_job`.
- Add RLS-protected `HistoryArchiveControl` and `HistoryArchiveRetry` tables.
- Create `history-archive-repo.ts`; dedicated job claim, pause/progress, oldest
  day discovery, size preflight and safe exponential retry records.
- Extend private PostgreSQL fixtures to cover discovery/lifecycle/retries,
  budgets, controls and preservation; verify SQL in disposable PostgreSQL.

## Task 3: Cron and operator workflow
- Replace cleanup route tests first: authentication, inactive defaults,
  invalid configuration, progress and errors. Confirm failure, replace route.
- Add dotenv-first `scripts/control-history-archive.ts` for status/pause and
  explicit archive-only/trim configuration; never activate production here.
- Document control switches, admission-estimate limitations, migration rollout,
  Dev cohort rehearsal, restore-first rollback and first production trim gate.

## Task 4: Verification and completion
- Run private PostgreSQL lifecycle tests and unit suite, lint and build.
- Review raw-only consumers and lifecycle budgets; record concrete results.
- Commit verified changes with `feat: replace retention cleanup with archival`.
- Leave production switches disabled and report any hosted Dev limitations.
