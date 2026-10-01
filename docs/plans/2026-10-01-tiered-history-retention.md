# Tiered History Retention Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Keep default accounts to 90 days and manually granted extended-history accounts
to 365 days, with a 30-day downgrade grace period and permanent tariff history.

**Architecture:** Store account entitlements in PostgreSQL and resolve them through
a shared retention service. Use one site-local cutoff for cleanup, historical
imports, persistence, and history availability. Keep tariffs entirely outside
retention deletion and fail closed on errors before destructive work.

**Tech Stack:** Next.js App Router, TypeScript, pg, PostgreSQL, Vitest, existing
migration generator and internal maintenance scripts; native Swift clients where availability needs UI.

---

Read the approved companion design, Authentication.md, and DesignDecisions.md
sections 1, 2, and 4 first. Work in cmd/next-app, preserve unrelated changes, and
use a codex/ branch. No production history deletion is authorized by this planning
commit; prepare and review the dry-run and backup before destructive rollout.

**Required base:** include landed PR #125, merge commit
e9ca3f241aecbf362a666c7e8fe96f6851bfbf3c. The planning checkout is behind that
change. Rebase/merge onto the latest main in the implementation branch before
editing importer/repository files. Preserve getDailyCoverage and its per-day
coverage contract; do not restore getExistingTimestamps. Read PR #125's design,
implementation plan, and scripts/verify-sync-daily-coverage.ts at that base.

## Task 1: Shared policy and entitlement schema

**Files:** create src/lib/history-retention.ts and its Vitest test; modify
src/lib/db-types.ts and src/lib/user-repo.ts; generate a migration.

1. Write failing cases for configured 90/365-day retention, downgrade grace=365 before
   expiry and 90 at/after expiry, UTC/site-local midnight, DST, and invalid retention settings.
   Use fixed clocks; do not depend on the test runner's current time.
2. Run `npm run test -- --run src/lib/history-retention.test.ts`; confirm failures
   exercise missing behavior, then implement a typed pure cutoff helper.
3. Run `npm run db:migration:create add_history_retention_tier` from cmd/next-app.
   Edit the generated path; never invent a filename. Add User.history_retention_days INTEGER
   NOT NULL DEFAULT 90, a CHECK restricting it to 90/365, and
   User.history_retention_grace_until TIMESTAMPTZ NULL. No new tables, no tariff
   deletes, and no cleanup embedded in this migration.
4. Add typed fields to User and account lookups without exposing token columns.
   Verify existing rows default correctly and existing User RLS/grants remain intact.
5. Run the focused tests and migration checks, then commit `feat: add history retention policy`.

## Task 2: Internal extended-history assignment (no tier UI)

**Files:** modify src/lib/user-repo.ts and its tests; create
scripts/set-history-retention.ts. No admin UI or premium-facing routes.

1. Write failing repository cases: 90-to-365 clears grace; 365-to-90 creates a
   30-day grace period; repeated 90-to-90 saves preserve the existing expiry;
   invalid retention days and missing accounts are rejected.
2. Run focused Vitest files and confirm RED.
3. Implement an atomic account update under a row lock. Grace is created only
   on a real 365-to-90 transition. Keep auth roles separate from retention days.
   Invalidate any cached entitlement after assignment; use request-scoped reuse
   and evaluate grace expiry with a fresh clock rather than caching its outcome.
4. Add an internal maintenance script that loads dotenv first, accepts an explicit
   environment, account ID, and 90/365 days, defaults to preview, and requires an
   explicit apply flag. Show the actual change and grace expiry without credentials.
5. Verify preview does not mutate data, apply targets only the requested account,
   and repeated changes behave correctly. Commit `feat: manage extended history internally`.

## Task 3: Prevent expired-history imports

**Files:** modify src/lib/importer/index.ts, src/lib/importer/import-planner.ts,
src/lib/energy-repo.ts, src/app/api/sync/route.ts and relevant tests;
inspect src/app/api/import/route.ts and src/app/api/site/[id]/analysis/route.ts;
add auditRange argument/retention tests to src/lib/importer.test.ts.

1. Write failing tests for wholly expired windows, windows crossing the cutoff,
   forced sync, re-import after cleanup, and rows returned outside the requested
   day. Assert zero Tesla calls for wholly expired history, not just zero inserts.
   Pin getDailyCoverage arguments for BOTH ensureDataForRange and auditRange.
   Test expired requests end without busy/partial retry loops; allowed requests
   retain per-day results, exact 30-minute thresholds, and 23/25-hour DST behavior.
2. Run `npm run test -- --run src/lib/importer.test.ts src/lib/importer/import-planner.test.ts src/app/api/sync/route.test.ts`.
3. Resolve the account policy after site authorization and before planning imports.
   Clamp start BEFORE getDailyCoverage, using the same range in planImport and
   auditDays/generateDayWindows; explicitly return unavailable for wholly expired ranges.
   Keep day-sized Tesla calls, locks, throttles, and time budgets intact.
   Add only compact retention fields to existing account/site projections when
   feasible; do not add per-sample/per-day account lookups or full User/tariff reads.
4. Filter rows before persistence and recheck the effective cutoff at write time
   for imports running across expiry. Ensure all callers of importRange/fetchRange
   and all EnergyData writers are covered, including operational scripts.
5. Prove repeated requests cannot refill deleted history; verify extended-history requests
   remain allowed within 365 days. Run focused tests and commit `fix: bound history imports by account retention`.
6. Pin query counts/returned-row counts during repeated DataSyncer attempts.
   Coverage remains one row per local day; retention must not enumerate timestamps.
   If getDailyCoverage SQL changes, run the landed real-Postgres differential
   script against an explicit dev target with populated DST/boundary fixtures,
   following its --help and acknowledgement requirements. Do not accept an empty
   fixture or mocked SQL as evidence of correctness.

## Task 4: Dry-run and bounded cleanup with permanent tariffs

**Files:** create src/lib/history-retention-service.ts and tests;
modify src/app/api/cron/cleanup/route.ts and tests, src/lib/energy-repo.ts,
src/lib/load-tag-repo.ts; create scripts/audit-history-retention.ts.

1. Write failing cleanup tests for retention/grace boundaries, rows exactly at cutoff,
   unknown entitlement abort, unowned-site skip, expired tag end_time, and batches.
   Capture a single run clock to avoid inconsistent cutoff decisions.
2. Create a dev integration fixture containing old/new EnergyData and LoadTag
   records plus referenced and unreferenced historical tariff versions. Record
   all Tariff/TariffSeason/TariffSchedule IDs and full values before cleanup.
3. Implement preview and deletion using the same selection predicate. Delete
   directly from EnergyData and LoadTag only; never delete User, Site, Tariff,
   TariffSeason, or TariffSchedule, even when their history is empty.
4. Add bounded batches with execution-budget handling and idempotent retries.
   Keep cron-secret authentication and report per-policy eligible/deleted counts,
   skipped sites, cutoff, and whether work remains. Replace the global
   DATA_RETENTION_DAYS deletion override with the approved account policy.
5. The audit script must load dotenv first, require an explicit environment target,
   and remain read-only. Output counts and storage estimates without credentials.
6. Execute cleanup against the dev fixture and compare every tariff row before/after.
   Repeat cleanup to demonstrate idempotence. Run focused tests and commit
   `feat: clean expired energy history while preserving all tariffs`.

## Task 5: History availability and client presentation

**Files:** modify src/lib/site-service.ts and tests, history navigation components
identified through its callers, src/app/api/sync/route.ts, analysis route and tests,
src/app/api/mobile/bill-summary/route.ts and relevant response-contract tests;
inspect native bill/history consumers under cmd/ios-app before editing them.

1. Write failing cases for allowed, wholly expired, and cutoff-crossing billing
   periods. A partial bill must not present complete-looking zero totals.
2. Include allowed-history start and coverage state in the relevant responses;
   retain compatibility with current consumers and reject expired auto-heal requests
   before calling Tesla. Do not add is_current tariff filters to historical billing.
3. Bound web navigation and show unavailable/partial history clearly. If native
   consumers can misrepresent those responses, update their models and views in
   the same rollout using Swift Testing; follow cmd/ios-app/run-tests.sh exclusively.
4. Verify current-cycle billing, extended-history billing, site switching,
   grace expiry, and boundary messages; commit `feat: show retained history availability`.

## Task 6: Documentation, verification, and rollout preparation

**Files:** update cmd/next-app/README.md, DesignDecisions.md, and task.md;
add a rollout report under docs/plans with dry-run counts and capacity estimates.

1. Replace the stale 365-day global-retention and raw-history-forever claims.
   Explicitly document that ALL tariff versions/seasons/schedules remain permanent.
2. Prepare a production read-only dry-run and identify extended-history exceptions before
   cleanup activation. Do not automatically delete inactive users or filter dev in
   this change; those remain separate plans.
3. Run `npm run lint`, `npm run test -- --run`, and `npm run build` from cmd/next-app.
   For native edits, also run the prescribed iOS test script and simulator build.
   Verify the migration with the production-to-dev workflow and full FK relationships.
   Run scripts/mobile-route-egress-trace.test.ts and compare live/bill query counts
   against the landed baseline. Record intentional compact entitlement-read overhead,
   and ensure expired-history requests cannot multiply sync retries or Tesla calls.
4. Measure database/table/index size and eligible/retained row counts before and
   after dev cleanup. Recheck zero changes to all tariff tables. Do not claim a
   size reduction solely from rows deleted or run blocking compaction unreviewed.
5. Prepare a recoverable backup and concrete production cleanup preview for the
   user's review. Separate code deployment from first destructive history trim.
6. Commit verified changes using conventional messages; any PR starts as a draft.

## Done criteria

Internal manual retention assignments work; 90/365-day policy and 30-day grace are enforced on both
imports and cleanup; all tariff records are untouched; partial history is explicit;
tests/lint/build pass; preview and recovery instructions are ready. Production
deletion is a subsequent reviewed operation, not a side effect of installing schema.
