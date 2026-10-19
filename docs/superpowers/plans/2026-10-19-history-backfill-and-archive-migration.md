# Site History Backfill and Archive Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local script that, for one explicit site, backfills raw `EnergyData` from Tesla back to `Site.installed` and then finalizes every finished day older than the 2-day floor into `EnergyDayArchive`, deleting nothing.

**Architecture:** A testable orchestration module (`src/lib/history-migration.ts`) with injected dependencies drives two existing engines in budgeted loops: `Importer.ensureDataForRange` for backfill and `runCompactMaintenance` for archiving. A thin script (`scripts/migrate-site-history.ts`) wires the real dependencies, follows the `maintain-compact-history.ts` conventions (preview by default, `--apply` to write, no IDs/tokens/samples in output), and prints a JSON report.

**Tech Stack:** TypeScript, Node 24, `pg`, Vitest, `npx tsx`.

**Spec:** `docs/superpowers/specs/2026-10-19-history-backfill-and-archive-migration-design.md`

## Global Constraints

- Delete nothing. No raw trim, no `--rebuild`, no `force` refetch of days that already have rows.
- Archive end boundary is `archiveCutoff(now, timezone, 2)` (site midnight minus 2 days), independent of `DATA_RETENTION_DAYS`.
- Backfill end boundary is the same cutoff, so the script never fights `today-refresh` / gap-heal on recent days.
- `getMaintenanceSnapshot` rejects ranges over 31 local days and ranges ending after the 2-day floor. Archive chunks are therefore ≤31 local days.
- `runCompactMaintenance` caps each call at `maxDays ≤ 7` and `maxTimeMs ≤ 45000`.
- One site per invocation (`--site-id`), sequential work, one DB connection's worth of concurrency.
- Output contains no tokens, tariffs or sample arrays (same rule as `maintain-compact-history.ts`).
- Runs locally via `npx tsx`; loads env with `import 'dotenv/config'` like `maintain-compact-history.ts`.
- `npm run lint`, `npm run build` and `npm test` must pass.

## Review Focus

- **Days Tesla never fills** (no data, or a partial day): `planImport` re-plans them on every pass. The backfill loop must stop with `stopped: 'no-progress'` and list them, not spin. → test in Task 2.
- **Import lock held by the app** (`ensureDataForRange` returns `processedWindows: 0, totalWindows: 0` when the lock is busy): report `stopped: 'busy'`, don't treat it as complete. → test in Task 2.
- **Archive `busy` from the site advisory lock:** retry the same chunk a bounded number of times (3), then stop with `stopped: 'busy'` and list the remaining dates. → test in Task 1.
- **DST and month edges:** chunk boundaries are site-local midnights computed with `addDaysInSiteTimezone`, and the last chunk ends exactly at the cutoff. → test in Task 1 using `America/Los_Angeles` across 2025-11-02.
- **Site installed within the last 2 days** (from ≥ before): no archive work and no backfill; report `stopped: 'nothing-to-do'` rather than throwing on `validateMaintenanceDates`. → test in Task 1.

---

### Task 1: Archive chunking and archive loop

**Files:**
- Create: `cmd/next-app/src/lib/history-migration.ts`
- Test: `cmd/next-app/src/lib/history-migration.test.ts`

**Interfaces:**
- Consumes: `runCompactMaintenance`, `MaintenanceStore`, `MaintenanceReport`, `MaintenanceDay` from `src/lib/prototypes/compact-history-maintenance.ts`; `addDaysInSiteTimezone`, `getSiteMidnight`, `formatSiteDate` from `src/lib/date-utils.ts`; `archiveCutoff` from `src/lib/history-archive-service.ts`.
- Produces:
  - `export function localDayChunks(start: Date, end: Date, timezone: string, maxDays = 31): {from: string; before: string}[]`. `start`/`end` are site-local midnights; returns consecutive `YYYY-MM-DD` ranges covering `[start, end)`, each ≤ `maxDays` local days; `[]` when `start >= end`.
  - `export interface ArchiveSummary {chunks: number; archived: string[]; alreadyArchived: number; empty: number; needsRepair: string[]; incompleteAttribution: string[]; remaining: string[]; stopped: 'caught-up'|'busy'|'preview'|'nothing-to-do'}`
  - `export async function archiveSiteHistory(store: MaintenanceStore, args: {siteId: string; start: Date; end: Date; timezone: string; apply: boolean; now: Date}, maintain = runCompactMaintenance): Promise<ArchiveSummary>`

- [ ] **Step 1: Write failing tests for `localDayChunks`**

  - `splits 70 days into 31+31+8` — start `2025-01-01` LA midnight, end `2025-03-12` LA midnight → `[{from:'2025-01-01',before:'2025-02-01'},{from:'2025-02-01',before:'2025-03-04'},{from:'2025-03-04',before:'2025-03-12'}]`.
  - `crosses DST fall-back on local midnights` — LA, start `2025-10-20`, end `2025-11-25` → first chunk `{from:'2025-10-20',before:'2025-11-20'}`, last `before:'2025-11-25'`.
  - `returns [] when start >= end`.

- [ ] **Step 2: Run** `cd cmd/next-app && npm test -- --run src/lib/history-migration.test.ts`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement `localDayChunks`.** Step the cursor with `addDaysInSiteTimezone(cursor, 1, tz)`; format boundaries with `formatSiteDate`.

- [ ] **Step 4: Write failing tests for `archiveSiteHistory`** with a fake `maintain` (`vi.fn`) that returns canned `MaintenanceReport`s:

  - `preview calls maintain once per chunk with apply:false and reports pending days as remaining`: stopped `'preview'`, `maintain` called with `{siteId, from, before, apply:false, maxDays:7, maxTimeMs:45000, now}` for each chunk.
  - `apply re-calls a chunk until remaining is empty`: first call returns `remaining:['2025-01-08']`, second returns `remaining:[]` → two calls for that chunk; `archived` collects dates whose status is `'finalized'`; `alreadyArchived` counts `'archived'` and `'unchanged'`; `empty` counts `'empty'`.
  - `collects needsRepair and incompleteAttribution dates`: day with `needsRepair:true` → in `needsRepair`; `attributionComplete:false` → in `incompleteAttribution`.
  - `stops after 3 consecutive busy reports for the same chunk`: `stopped:'busy'`, `remaining` contains that chunk's remaining dates and no later chunk is attempted.
  - `nothing-to-do when start >= end`: `maintain` never called.
  - Dates counted once even when a chunk is re-called (dedupe by date; take the latest status).

- [ ] **Step 5: Run the test file.** Expected: the new tests FAIL.

- [ ] **Step 6: Implement `archiveSiteHistory`.** Iterate `localDayChunks(start, end, timezone)`. In preview, one call per chunk. In apply, loop per chunk while `report.remaining.length > 0`. Count `stopped === 'busy'` reports; stop the whole run at 3 consecutive. Reset the counter when `remaining` shrinks. Pass `store` through as `maintain(store, options)`.

- [ ] **Step 7: Run the test file.** Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add cmd/next-app/src/lib/history-migration.ts cmd/next-app/src/lib/history-migration.test.ts
git commit -m "feat(history): chunked compact-archive driver for site migration"
```

---

### Task 2: Backfill loop and site orchestration

**Files:**
- Modify: `cmd/next-app/src/lib/history-migration.ts`
- Test: `cmd/next-app/src/lib/history-migration.test.ts`

**Interfaces:**
- Consumes: Task 1's `archiveSiteHistory`, `ArchiveSummary`; `EnsureDataResult` and `planMissingWindows` from `src/lib/importer/index.ts`; `DateWindow` from `src/lib/importer/import-planner.ts`; `archiveCutoff`, `getSiteMidnight`.
- Produces:
  - `export interface MigrationSite {id: string; timezone: string; installed: Date}`
  - `export interface BackfillDeps {plan(site: MigrationSite, start: Date, end: Date): Promise<DateWindow[]>; ensure(siteId: string, start: Date, end: Date, budget: {maxTimeMs: number; maxWindows: number}): Promise<EnsureDataResult>}`
  - `export interface BackfillSummary {passes: number; windowsImported: number; missingDays: string[]; stopped: 'complete'|'no-progress'|'busy'|'preview'|'nothing-to-do'}`. `missingDays` are local `YYYY-MM-DD` of windows still planned at the end.
  - `export async function backfillSiteHistory(deps: BackfillDeps, site: MigrationSite, end: Date, apply: boolean, maxPasses = 200): Promise<BackfillSummary>`
  - `export interface SiteMigrationReport {mode: 'preview'|'apply'; installed: string; cutoff: string; backfill: BackfillSummary | 'skipped'; archive: ArchiveSummary | 'skipped'; rawDeletionPerformed: false}`
  - `export async function migrateSiteHistory(deps: {site: MigrationSite; backfill: BackfillDeps; store: MaintenanceStore}, options: {apply: boolean; now: Date; skipBackfill?: boolean; skipArchive?: boolean}): Promise<SiteMigrationReport>`

- [ ] **Step 1: Write failing tests for `backfillSiteHistory`** with fake deps:

  - `preview plans once and never calls ensure`: `stopped:'preview'`, `missingDays` = planned windows' local dates.
  - `apply loops ensure with {maxTimeMs:45000, maxWindows:30} until complete`: ensure returns `{complete:false, processedWindows:30, totalWindows:45}` then `{complete:true, processedWindows:15, totalWindows:15}` → `passes:2`, `windowsImported:45`, `stopped:'complete'`.
  - `no-progress when the planned set stops shrinking`: `plan` returns the same two windows after each pass, and ensure reports `processedWindows:2, complete:false`. After a pass where the re-planned count doesn't drop, it stops with `stopped:'no-progress'` and `missingDays` lists both.
  - `busy when ensure returns 0/0 while plan still has windows`: `stopped:'busy'`.
  - `nothing-to-do when installed midnight >= end`.
  - `stops at maxPasses`: `stopped:'no-progress'`.
  - The range passed to `plan`/`ensure` is `[getSiteMidnight(installed, tz), end)`.

- [ ] **Step 2: Run the test file.** Expected: new tests FAIL.

- [ ] **Step 3: Implement `backfillSiteHistory`.** Call `plan` before each pass and after the last pass; progress means the planned-window count decreased. An `ensure` throw (all windows failed) propagates. The script reports it.

- [ ] **Step 4: Write failing tests for `migrateSiteHistory`:**

  - `uses archiveCutoff(now, tz, 2) as the end for both steps` (assert the `end` both fakes receive, and `cutoff` in the report as a local date).
  - `runs backfill before archive` (call order).
  - `skipBackfill / skipArchive yield 'skipped'`.
  - `still archives after backfill stops busy or no-progress`: archiving what's present is safe, and the next run fills the rest. Assert archive is called.
  - `rawDeletionPerformed` is always `false`.

- [ ] **Step 5: Run the test file.** Expected: new tests FAIL.

- [ ] **Step 6: Implement `migrateSiteHistory`.**

- [ ] **Step 7: Run the test file.** Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add cmd/next-app/src/lib/history-migration.ts cmd/next-app/src/lib/history-migration.test.ts
git commit -m "feat(history): backfill-to-install loop and site migration orchestrator"
```

---

### Task 3: CLI script, rehearsal and docs

**Files:**
- Create: `cmd/next-app/scripts/migrate-site-history.ts`
- Modify: `cmd/next-app/src/lib/history-migration.ts` (add arg parser)
- Test: `cmd/next-app/src/lib/history-migration.test.ts`
- Modify: `TODO.md` (add the Phase 2 items from the spec under a new "Compact-archive migration" heading; link the spec)

**Interfaces:**
- Consumes: Task 2's `migrateSiteHistory`, `MigrationSite`, `BackfillDeps`; `Importer`, `planMissingWindows`; `createTeslaClientForSite`; `SiteRepo`, `EnergyRepo`; `CompactHistoryStore`; `pool` from `src/lib/db`.
- Produces: `export function parseMigrationArgs(args: string[]): {siteId: string; apply: boolean; skipBackfill: boolean; skipArchive: boolean}`

- [ ] **Step 1: Write failing tests for `parseMigrationArgs`:** accepts `--site-id X`, `--apply`, `--skip-backfill`, `--skip-archive`. Rejects a missing or empty site ID, unknown flags, duplicate flags, and both skips together (each with a thrown `Error`).

- [ ] **Step 2: Run, implement, run again.** Expected: FAIL, then PASS.

- [ ] **Step 3: Write `scripts/migrate-site-history.ts`.**
  - Load the site with `new SiteRepo().getSite(siteId)` and map it to `MigrationSite` (throw `'Site not found'`, and on a missing timezone).
  - Build the Tesla client only when `apply && !skipBackfill`, via `createTeslaClientForSite(siteId)`. On `null`, exit with `'No Tesla credentials for site; re-authenticate via /login'`.
  - Set `BackfillDeps.plan` to `planMissingWindows(new EnergyRepo(), site, start, end)` and `ensure` to `importer.ensureDataForRange(siteId, start, end, undefined, budget)`.
  - Set `store` to `new CompactHistoryStore(pool)`.
  - Print `JSON.stringify(report, null, 2)` and run `pool.end()` in `finally`.
  - On error, print a fixed message with no IDs, like `maintain-compact-history.ts` does, and set `process.exitCode = 1`.

- [ ] **Step 4: Verify lint, build, tests**

Run: `cd cmd/next-app && npm run lint && npm run build && npm test -- --run`
Expected: all pass.

- [ ] **Step 5: Dev DB rehearsal (Harrison site; `.env` points at the Dev DB, per the worktree memory).**
  - Preview: `npx tsx scripts/migrate-site-history.ts --site-id <harrison>`. Expect `mode:'preview'`, a non-empty `missingDays` or `stopped:'complete'`, and archive `remaining` dates.
  - Apply: same command with `--apply`. Expect `backfill.stopped` to be `complete` or `no-progress` (inspect `missingDays`), and `archive.stopped:'caught-up'`.
  - Re-run `--apply`. Expect `windowsImported:0` and `archived:[]` (idempotent).
  - Spot-check a few archived days with `npx tsx scripts/validate-compact-history-archive.ts` (read its usage first) and confirm compact reads match raw.
  - Record egress for the apply run with `scripts/measure-compact-history-egress.ts` if its usage fits; otherwise note bytes from the archive report.

- [ ] **Step 6: Update `TODO.md`** with the Phase 2 list from the spec: enable compact reads, cron trim mode, archive-aware gap-heal that produces archives past the cutoff, staged retention 365 → 30 → 7, and the raw-only reads to re-check. Add the production rollout note: one site per run, oldest-installed first. Add a "New-site history onboarding" item: automatic, budgeted backfill for new sites, reusing `migrateSiteHistory` from a cron route (see the spec's follow-up section).

- [ ] **Step 7: Commit**

```bash
git add cmd/next-app/scripts/migrate-site-history.ts cmd/next-app/src/lib/history-migration.ts cmd/next-app/src/lib/history-migration.test.ts TODO.md
git commit -m "feat(history): migrate-site-history script and Phase 2 TODOs"
```
