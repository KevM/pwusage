# ROI History Indexing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a site owner opt into reconstructing their full `EnergyRollup` history from Tesla (back to install) via a throttled, resumable background worker, with self-healing dormancy gaps and a partial-safe daily rollup.

**Architecture:** A per-site `RollupBackfill` ledger row (status + forward cursor) is created on opt-in. A Supabase pg_cron pings a Vercel worker every 15 min; each tick claims one site, walks its cursor forward a bounded chunk, reconstructs **pre-retention** days via `Importer.fetchRange` (Tesla → memory → rollup, never persisting `EnergyData`) and **within-retention** days via the normal persist path, forcing genesis until the tank first anchors. Coverage gaps heal on Savings-tab load. The daily rollup becomes hourly + timezone-aware and only rolls provably-complete days.

**Tech Stack:** Next.js App Router (route handlers), PostgreSQL via `pg` Pool, Supabase pg_cron + pg_net, Vitest, TypeScript.

**Spec:** `docs/superpowers/specs/2026-06-13-roi-history-indexing-design.md`

**Working branch:** `feat/roi` (continue here; no separate worktree).

---

## File Structure

**Create:**
- `cmd/next-app/db-migrations/<ts>_rollup_backfill.sql` — `RollupBackfill` table.
- `cmd/next-app/db-migrations/<ts>_index_history_cron_trigger.sql` — pg_cron → worker.
- `cmd/next-app/src/lib/battery-provenance/rollup-backfill-repo.ts` (+ `.test.ts`) — ledger CRUD + claim.
- `cmd/next-app/src/lib/battery-provenance/backfill-service.ts` (+ `.test.ts`) — process one site's chunk.
- `cmd/next-app/src/lib/battery-provenance/day-coverage.ts` (+ `.test.ts`) — classify a day's `EnergyData` coverage.
- `cmd/next-app/src/app/api/cron/index-history/route.ts` — worker endpoint.
- `cmd/next-app/src/app/api/site/[id]/index-history/route.ts` — opt-in endpoint.
- `cmd/next-app/src/components/site/savings/IndexingStatus.tsx` — opt-in button / progress UI.

**Modify:**
- `cmd/next-app/src/lib/db.ts` — add `RollupBackfill` interface.
- `cmd/next-app/src/lib/battery-provenance/rollup-service.ts` — `rollupDay` gains rows + `forceGenesisAtStart`, returns `genesisAnchored`.
- `cmd/next-app/src/lib/battery-provenance/rollup-repo.ts` — add `hasRollupForDate`.
- `cmd/next-app/src/lib/battery-provenance/local-day.ts` — add `addLocalDays`.
- `cmd/next-app/src/app/api/cron/rollup/route.ts` — hourly, timezone-aware, partial-safe.
- `cmd/next-app/vercel.json` — rollup cron `0 8 * * *` → `0 * * * *`.
- `cmd/next-app/src/app/site/[id]/page.tsx` — heal-on-load + pass backfill status to Savings.
- `cmd/next-app/src/components/site/savings/SavingsView.tsx` — render `IndexingStatus`.
- `cmd/next-app/src/app/admin/page.tsx` + `AdminDashboard.tsx` — per-site indexing badge.
- `cmd/next-app/src/lib/user-repo.ts` — include backfill summary in admin query.

**Untouched (by design):** `cmd/next-app/src/app/api/cron/cleanup/route.ts` and `EnergyRepo.cleanupOldEnergyData` — pre-retention days are never persisted, so there is no scratch to coordinate around.

**Implementation note on locking:** the spec mentions `pg_advisory_lock`; session advisory locks are awkward with a pooled serverless connection. This plan uses an atomic claim (`UPDATE … WHERE site_id = (SELECT … FOR UPDATE SKIP LOCKED)`) plus a stale-`running` reclaim window instead — equivalent mutual exclusion, pool-safe.

All commands run from `cmd/next-app/` unless noted. Use a local SQLite/Postgres `DATABASE_URL` for tests (Vitest does not hit the network).

---

## Task 1: `RollupBackfill` migration + type

**Files:**
- Create: `cmd/next-app/db-migrations/<ts>_rollup_backfill.sql`
- Modify: `cmd/next-app/src/lib/db.ts` (after the `SiteRoiConfig` interface, ~line 203)

- [ ] **Step 1: Generate the migration file**

Run: `npm run db:migration:create rollup_backfill`
Expected: prints a new path `db-migrations/<timestamp>_rollup_backfill.sql`.

- [ ] **Step 2: Write the migration SQL**

Replace the generated file's contents with (idempotent, matching the `site_roi_config` style):

```sql
-- Migration: rollup_backfill
-- Per-site ROI history-indexing ledger + forward cursor. Idempotent.
CREATE TABLE IF NOT EXISTS "RollupBackfill" (
    site_id          TEXT PRIMARY KEY REFERENCES "Site"(id) ON DELETE CASCADE,
    status           TEXT NOT NULL DEFAULT 'pending',  -- pending | running | complete | error
    oldest_date      DATE NOT NULL,
    cursor_date      DATE NOT NULL,
    newest_date      DATE NOT NULL,
    days_done        INTEGER NOT NULL DEFAULT 0,
    days_total       INTEGER NOT NULL DEFAULT 0,
    genesis_anchored BOOLEAN NOT NULL DEFAULT false,
    last_error       TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Worker claim ordering: oldest opt-in first among incomplete rows.
CREATE INDEX IF NOT EXISTS "RollupBackfill_incomplete_idx"
    ON "RollupBackfill" (created_at)
    WHERE status IN ('pending', 'running');
```

- [ ] **Step 3: Add the TypeScript interface**

In `src/lib/db.ts`, immediately after the `SiteRoiConfig` interface (ends ~line 203), add:

```ts
export interface RollupBackfill {
  site_id: string;
  status: 'pending' | 'running' | 'complete' | 'error';
  oldest_date: string;  // 'YYYY-MM-DD'
  cursor_date: string;  // 'YYYY-MM-DD' — next local day to process
  newest_date: string;  // 'YYYY-MM-DD'
  days_done: number;
  days_total: number;
  genesis_anchored: boolean;
  last_error: string | null;
}
```

- [ ] **Step 4: Apply the migration locally and verify the table exists**

Run: `psql "$DATABASE_URL" -c '\d "RollupBackfill"'` (or your local migration runner), confirm the columns above.
Expected: table description lists all 11 columns.

- [ ] **Step 5: Commit**

```bash
git add db-migrations/*_rollup_backfill.sql src/lib/db.ts
git commit -m "feat(roi): RollupBackfill ledger table + type"
```

---

## Task 2: `RollupBackfillRepo`

**Files:**
- Create: `cmd/next-app/src/lib/battery-provenance/rollup-backfill-repo.ts`
- Test: `cmd/next-app/src/lib/battery-provenance/rollup-backfill-repo.test.ts`

Follow the `pool.query` mock style of `src/lib/roi/roi-config-repo.test.ts`.

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({ pool: { query: vi.fn() } }));
import { pool } from '../db';
import { RollupBackfillRepo, daySpan } from './rollup-backfill-repo';

const q = () => pool.query as ReturnType<typeof vi.fn>;

describe('RollupBackfillRepo', () => {
  beforeEach(() => q().mockReset());

  it('get returns null when no row', async () => {
    q().mockResolvedValueOnce({ rows: [] });
    expect(await new RollupBackfillRepo().get('s1')).toBeNull();
  });

  it('enqueue upserts a pending row with cursor = oldest and inclusive day total', async () => {
    q().mockResolvedValueOnce({ rows: [] });
    await new RollupBackfillRepo().enqueue('s1', '2026-06-01', '2026-06-05');
    const [sql, params] = q().mock.calls.at(-1)!;
    expect(sql).toContain('INSERT INTO "RollupBackfill"');
    expect(sql).toContain('ON CONFLICT');
    expect(params).toEqual(['s1', '2026-06-01', '2026-06-05', 5]); // inclusive day span
  });

  it('daySpan counts both endpoints inclusively across a month boundary', () => {
    expect(daySpan('2026-06-01', '2026-06-05')).toBe(5);
    expect(daySpan('2026-01-30', '2026-02-02')).toBe(4);
  });

  it('claimNext atomically flips one incomplete site to running', async () => {
    q().mockResolvedValueOnce({ rows: [{ site_id: 's1', status: 'running', oldest_date: '2021-06-01',
      cursor_date: '2021-06-01', newest_date: '2026-06-12', days_done: 0, days_total: 1837,
      genesis_anchored: false, last_error: null }] });
    const job = await new RollupBackfillRepo().claimNext(10);
    expect(job?.site_id).toBe('s1');
    const [sql] = q().mock.calls.at(-1)!;
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(sql).toContain("status = 'running'");
  });

  it('recordProgress writes cursor, days_done and genesis flag', async () => {
    q().mockResolvedValueOnce({ rows: [] });
    await new RollupBackfillRepo().recordProgress('s1', '2021-07-15', 44, true);
    const [, params] = q().mock.calls.at(-1)!;
    expect(params).toEqual(['s1', '2021-07-15', 44, true]);
  });

  it('reopenIfBehind re-opens a complete row when newest_date < target', async () => {
    q().mockResolvedValueOnce({ rowCount: 1, rows: [] });
    const reopened = await new RollupBackfillRepo().reopenIfBehind('s1', '2026-06-12');
    expect(reopened).toBe(true);
    const [sql, params] = q().mock.calls.at(-1)!;
    expect(sql).toContain("status = 'pending'");
    expect(sql).toContain('newest_date <'); // guard
    expect(params).toEqual(['s1', '2026-06-12']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/lib/battery-provenance/rollup-backfill-repo`
Expected: FAIL — `Cannot find module './rollup-backfill-repo'`.

- [ ] **Step 3: Implement the repo**

```ts
import { pool } from '../db';
import type { RollupBackfill } from '../db';

/** Inclusive whole-day span between two 'YYYY-MM-DD' strings. */
export function daySpan(oldest: string, newest: string): number {
  const a = Date.UTC(+oldest.slice(0, 4), +oldest.slice(5, 7) - 1, +oldest.slice(8, 10));
  const b = Date.UTC(+newest.slice(0, 4), +newest.slice(5, 7) - 1, +newest.slice(8, 10));
  return Math.floor((b - a) / 86400000) + 1;
}

const SELECT_COLS = `site_id, status,
  oldest_date::text AS oldest_date, cursor_date::text AS cursor_date, newest_date::text AS newest_date,
  days_done, days_total, genesis_anchored, last_error`;

export class RollupBackfillRepo {
  async get(siteId: string): Promise<RollupBackfill | null> {
    const res = await pool.query(`SELECT ${SELECT_COLS} FROM "RollupBackfill" WHERE site_id = $1`, [siteId]);
    return (res.rows[0] as RollupBackfill) ?? null;
  }

  /** Opt-in / heal-from-scratch: create or reset a pending row from oldest..newest. */
  async enqueue(siteId: string, oldestDate: string, newestDate: string): Promise<void> {
    const total = daySpan(oldestDate, newestDate);
    await pool.query(
      `INSERT INTO "RollupBackfill"(site_id, oldest_date, cursor_date, newest_date, status, days_done, days_total)
       VALUES ($1, $2, $2, $3, 'pending', 0, $4)
       ON CONFLICT (site_id) DO UPDATE SET
         status = 'pending', oldest_date = EXCLUDED.oldest_date, cursor_date = EXCLUDED.oldest_date,
         newest_date = EXCLUDED.newest_date, days_done = 0, days_total = EXCLUDED.days_total,
         genesis_anchored = false, last_error = NULL, updated_at = now()`,
      [siteId, oldestDate, newestDate, total],
    );
  }

  /** Atomically claim one incomplete site (oldest opt-in first); reclaim stale 'running'. */
  async claimNext(staleMinutes = 10): Promise<RollupBackfill | null> {
    const res = await pool.query(
      `UPDATE "RollupBackfill" SET status = 'running', updated_at = now()
       WHERE site_id = (
         SELECT site_id FROM "RollupBackfill"
         WHERE status = 'pending'
            OR (status = 'running' AND updated_at < now() - ($1 || ' minutes')::interval)
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       RETURNING ${SELECT_COLS}`,
      [staleMinutes],
    );
    return (res.rows[0] as RollupBackfill) ?? null;
  }

  async recordProgress(siteId: string, cursorDate: string, daysDone: number, genesisAnchored: boolean): Promise<void> {
    await pool.query(
      `UPDATE "RollupBackfill"
       SET cursor_date = $2, days_done = $3, genesis_anchored = $4, status = 'running', updated_at = now()
       WHERE site_id = $1`,
      [siteId, cursorDate, daysDone, genesisAnchored],
    );
  }

  async markComplete(siteId: string): Promise<void> {
    await pool.query(`UPDATE "RollupBackfill" SET status = 'complete', last_error = NULL, updated_at = now() WHERE site_id = $1`, [siteId]);
  }

  async markError(siteId: string, message: string): Promise<void> {
    await pool.query(`UPDATE "RollupBackfill" SET status = 'error', last_error = $2, updated_at = now() WHERE site_id = $1`, [siteId, message.slice(0, 500)]);
  }

  /** Heal-on-return: re-open a complete row whose coverage no longer reaches `target`. Keeps genesis_anchored. */
  async reopenIfBehind(siteId: string, targetNewestDate: string): Promise<boolean> {
    const res = await pool.query(
      `UPDATE "RollupBackfill"
       SET status = 'pending', newest_date = $2,
           days_total = days_total + (($2::date - newest_date) ), updated_at = now()
       WHERE site_id = $1 AND status = 'complete' AND newest_date < $2`,
      [siteId, targetNewestDate],
    );
    return (res.rowCount ?? 0) > 0;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/lib/battery-provenance/rollup-backfill-repo`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/battery-provenance/rollup-backfill-repo.ts src/lib/battery-provenance/rollup-backfill-repo.test.ts
git commit -m "feat(roi): RollupBackfillRepo (ledger CRUD + atomic claim)"
```

---

## Task 3: `rollupDay` — rows path, forced genesis, anchored result

**Files:**
- Modify: `cmd/next-app/src/lib/battery-provenance/rollup-service.ts`
- Test: `cmd/next-app/src/lib/battery-provenance/rollup-service.test.ts` (append)

- [ ] **Step 1: Write the failing tests** (append to the existing `describe`)

```ts
it('forces genesis even when rollups already exist, anchoring at the full-SOC moment', async () => {
  const persisted: PeriodRollup[] = [];
  const deps: RollupDeps = {
    loadSite: async () => ({ id: 'S1', timezone: 'UTC', tariffs }) as never,
    loadEnergyData: async () => [
      row('2026-01-02T06:00:00Z', { battery_soc: 70, battery_power: 3000, grid_power: 3000, battery_charge_from_grid: 3000 }),
      row('2026-01-02T12:00:00Z', { battery_soc: 99, battery_power: 3000, solar_power: 3000, battery_charge_from_solar: 3000 }), // anchor
      row('2026-01-02T18:00:00Z', { battery_soc: 60, battery_power: -3000, load_power: 3000 }),
    ],
    getSeedTank: async () => null,
    hasAnyRollup: async () => true, // would normally SKIP genesis
    upsertRollups: async (r) => { persisted.push(...r); },
  };
  const result = await new RollupService(deps).rollupDay('S1', '2026-01-02', { forceGenesisAtStart: true });
  expect(result.genesisAnchored).toBe(true);
  // Anchored full battery (6000 Wh) then discharged 3000 → 3000 remaining, NOT EMPTY_TANK.
  expect(persisted[0].tank.solarWh + persisted[0].tank.gridWh).toBeCloseTo(3000, 2);
});

it('reports genesisAnchored=false when forced but the day has no full-SOC row', async () => {
  const deps: RollupDeps = {
    loadSite: async () => ({ id: 'S1', timezone: 'UTC', tariffs }) as never,
    loadEnergyData: async () => [ row('2026-01-02T12:00:00Z', { battery_soc: 50, load_power: 1000, grid_power: 1000 }) ],
    getSeedTank: async () => null,
    hasAnyRollup: async () => true,
    upsertRollups: async () => {},
  };
  const result = await new RollupService(deps).rollupDay('S1', '2026-01-02', { forceGenesisAtStart: true });
  expect(result.genesisAnchored).toBe(false);
});

it('uses supplied rows and never calls loadEnergyData', async () => {
  const loadEnergyData = vi.fn();
  const deps: RollupDeps = {
    loadSite: async () => ({ id: 'S1', timezone: 'UTC', tariffs }) as never,
    loadEnergyData,
    getSeedTank: async () => null,
    hasAnyRollup: async () => false,
    upsertRollups: async () => {},
  };
  const rows = [ row('2026-01-02T12:00:00Z', { battery_soc: 99, solar_power: 3000, battery_power: 3000, battery_charge_from_solar: 3000 }) ];
  await new RollupService(deps).rollupDay('S1', '2026-01-02', { rows });
  expect(loadEnergyData).not.toHaveBeenCalled();
});
```

Add `vi` to the import: `import { describe, it, expect, vi } from 'vitest';`

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- src/lib/battery-provenance/rollup-service`
Expected: FAIL — `rollupDay` ignores the 3rd arg / returns no `genesisAnchored`.

- [ ] **Step 3: Update `rollupDay`**

Replace the `rollupDay` method body in `rollup-service.ts` with:

```ts
/** Roll up a single local calendar day for one site. Idempotent.
 *  opts.rows  — roll up these in-memory rows instead of reading the DB (backfill fetch-only path).
 *  opts.forceGenesisAtStart — run computeGenesisSeed even if rollups already exist (backfill re-anchor). */
async rollupDay(
  siteId: string,
  localDate: string,
  opts?: { rows?: EnergyData[]; forceGenesisAtStart?: boolean },
): Promise<{ rollupCount: number; genesisAnchored: boolean }> {
  const site = await this.deps.loadSite(siteId);
  const schedule = new Schedule(site.tariffs, site.timezone);
  const { start, end } = localDayBoundsUtc(localDate, site.timezone);

  const rows = opts?.rows ?? await this.deps.loadEnergyData(siteId, start, end);
  if (rows.length === 0) return { rollupCount: 0, genesisAnchored: false };

  const seedRow = await this.deps.getSeedTank(siteId, start);
  let seed: Tank = seedRow?.tank ?? EMPTY_TANK;
  let genesisAnchorTimestamp: Date | undefined;
  let genesisAnchored = false;

  if (opts?.forceGenesisAtStart || (!seedRow && !(await this.deps.hasAnyRollup(siteId)))) {
    const genesis = computeGenesisSeed(rows, schedule, site.timezone);
    if (genesis) {
      seed = genesis.seed;
      genesisAnchorTimestamp = genesis.anchorTimestamp;
      genesisAnchored = true;
    }
  }

  const { rollups } = replayRows(rows, schedule, site.timezone, seed, { genesisAnchorTimestamp });
  const forDate = rollups.filter(r => r.localDate === localDate);
  await this.deps.upsertRollups(forDate);
  return { rollupCount: forDate.length, genesisAnchored };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- src/lib/battery-provenance/rollup-service`
Expected: PASS (existing + 3 new tests).

- [ ] **Step 5: Update the two existing callers to the new return shape**

`src/app/api/cron/rollup/route.ts:43` and `scripts/backfill-rollups.ts` already destructure `{ rollupCount }` — that still works (extra `genesisAnchored` is ignored). No change needed; confirm `npm run build` is clean in Step 6.

- [ ] **Step 6: Verify build + commit**

Run: `npm run build`
Expected: succeeds.

```bash
git add src/lib/battery-provenance/rollup-service.ts src/lib/battery-provenance/rollup-service.test.ts
git commit -m "feat(roi): rollupDay rows path + forced genesis + anchored result"
```

---

## Task 4: Day-coverage classifier + `hasRollupForDate`

**Files:**
- Create: `cmd/next-app/src/lib/battery-provenance/day-coverage.ts`
- Test: `cmd/next-app/src/lib/battery-provenance/day-coverage.test.ts`
- Modify: `cmd/next-app/src/lib/battery-provenance/rollup-repo.ts`

- [ ] **Step 1: Write failing tests for the classifier**

```ts
import { describe, it, expect } from 'vitest';
import { classifyDayCoverage } from './day-coverage';

const day = { start: new Date('2026-01-02T00:00:00Z'), end: new Date('2026-01-03T00:00:00Z') };
const at = (h: number, m = 0) => new Date(`2026-01-02T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00Z`).getTime();

describe('classifyDayCoverage', () => {
  it('empty when no samples', () => {
    expect(classifyDayCoverage([], day.start, day.end)).toBe('empty');
  });
  it('complete when samples span the whole day within threshold', () => {
    expect(classifyDayCoverage([at(0, 0), at(12), at(23, 55)], day.start, day.end)).toBe('complete');
  });
  it('partial when data stops mid-day (missingEnd)', () => {
    expect(classifyDayCoverage([at(0, 0), at(9)], day.start, day.end)).toBe('partial');
  });
  it('partial when data starts late (missingStart)', () => {
    expect(classifyDayCoverage([at(14), at(23, 55)], day.start, day.end)).toBe('partial');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- src/lib/battery-provenance/day-coverage`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the classifier**

```ts
/** Classify a local day's EnergyData coverage from its sample timestamps (ms).
 *  'complete' only when samples reach within `thresholdMs` of both ends. */
export type DayCoverage = 'empty' | 'partial' | 'complete';

export function classifyDayCoverage(
  timestampsMs: number[],
  dayStart: Date,
  dayEnd: Date,
  thresholdMs = 30 * 60 * 1000,
): DayCoverage {
  const inDay = timestampsMs.filter(t => t >= dayStart.getTime() && t < dayEnd.getTime());
  if (inDay.length === 0) return 'empty';
  const first = Math.min(...inDay);
  const last = Math.max(...inDay);
  const missingStart = first - dayStart.getTime() > thresholdMs;
  const missingEnd = dayEnd.getTime() - last > thresholdMs;
  return missingStart || missingEnd ? 'partial' : 'complete';
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- src/lib/battery-provenance/day-coverage`
Expected: PASS (4 tests).

- [ ] **Step 5: Add `hasRollupForDate` to `RollupRepo`**

In `src/lib/battery-provenance/rollup-repo.ts`, add this method inside the `RollupRepo` class (after `hasAnyRollup`):

```ts
/** True if any rollup row already exists for this local date (⇒ the day was rolled, i.e. complete). */
async hasRollupForDate(siteId: string, localDate: string): Promise<boolean> {
    const res = await pool.query(
        `SELECT 1 FROM "EnergyRollup" WHERE site_id = $1 AND local_date = $2 LIMIT 1`,
        [siteId, localDate],
    );
    return res.rows.length > 0;
}
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/battery-provenance/day-coverage.ts src/lib/battery-provenance/day-coverage.test.ts src/lib/battery-provenance/rollup-repo.ts
git commit -m "feat(roi): day-coverage classifier + hasRollupForDate"
```

---

## Task 5: `addLocalDays` helper + `BackfillService`

**Files:**
- Modify: `cmd/next-app/src/lib/battery-provenance/local-day.ts`
- Test: `cmd/next-app/src/lib/battery-provenance/local-day.test.ts` (append)
- Create: `cmd/next-app/src/lib/battery-provenance/backfill-service.ts`
- Test: `cmd/next-app/src/lib/battery-provenance/backfill-service.test.ts`

- [ ] **Step 1: Write failing test for `addLocalDays`** (append to `local-day.test.ts`)

```ts
import { addLocalDays } from './local-day';
describe('addLocalDays', () => {
  it('advances a YYYY-MM-DD string across month/year ends', () => {
    expect(addLocalDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addLocalDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addLocalDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});
```
(If `local-day.test.ts` lacks the `describe/it/expect` import, add `import { describe, it, expect } from 'vitest';`.)

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- src/lib/battery-provenance/local-day`
Expected: FAIL — `addLocalDays` not exported.

- [ ] **Step 3: Implement `addLocalDays`** (append to `local-day.ts`)

```ts
/** Add n whole days to a 'YYYY-MM-DD' string (calendar arithmetic, timezone-independent). */
export function addLocalDays(localDate: string, n: number): string {
    const d = new Date(`${localDate}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- src/lib/battery-provenance/local-day`
Expected: PASS.

- [ ] **Step 5: Write failing tests for `BackfillService`**

```ts
import { describe, it, expect, vi } from 'vitest';
import { BackfillService, type BackfillDeps, type BackfillJob } from './backfill-service';
import type { EnergyData } from '../db';

const job = (over: Partial<BackfillJob> = {}): BackfillJob => ({
  siteId: 'S1', oldestDate: '2021-06-01', cursorDate: '2021-06-01',
  newestDate: '2021-06-05', daysDone: 0, genesisAnchored: false, ...over,
});

function makeDeps(over: Partial<BackfillDeps> = {}): BackfillDeps {
  return {
    loadSite: async () => ({ id: 'S1', timezone: 'UTC', installed: '2021-06-01' }) as never,
    fetchRange: vi.fn(async () => [] as EnergyData[]),
    ensureData: vi.fn(async () => {}),
    rollupDay: vi.fn(async () => ({ genesisAnchored: false })),
    recordProgress: vi.fn(async () => {}),
    markComplete: vi.fn(async () => {}),
    markError: vi.fn(async () => {}),
    retentionCutoff: () => new Date('2025-06-12T00:00:00Z'),
    localDayBounds: (d: string) => ({ start: new Date(`${d}T00:00:00Z`), end: new Date(`${d}T00:00:00Z`) }),
    now: () => 0,
    ...over,
  };
}

describe('BackfillService.processSite', () => {
  it('pre-retention days use fetchRange, never ensureData', async () => {
    const deps = makeDeps();
    await new BackfillService(deps).processSite(job(), { daysPerTick: 100, budgetMs: 1e9 });
    expect(deps.fetchRange).toHaveBeenCalledTimes(5);
    expect(deps.ensureData).not.toHaveBeenCalled();
  });

  it('within-retention days use ensureData (persist), not fetchRange', async () => {
    const deps = makeDeps({ retentionCutoff: () => new Date('2000-01-01T00:00:00Z') });
    await new BackfillService(deps).processSite(job(), { daysPerTick: 100, budgetMs: 1e9 });
    expect(deps.ensureData).toHaveBeenCalledTimes(5);
    expect(deps.fetchRange).not.toHaveBeenCalled();
  });

  it('stops at the day-per-tick cap and records the advanced cursor', async () => {
    const deps = makeDeps();
    await new BackfillService(deps).processSite(job(), { daysPerTick: 2, budgetMs: 1e9 });
    expect(deps.rollupDay).toHaveBeenCalledTimes(2);
    expect(deps.recordProgress).toHaveBeenLastCalledWith('S1', '2021-06-03', 2, false);
    expect(deps.markComplete).not.toHaveBeenCalled();
  });

  it('stops when the wall-clock budget is exhausted', async () => {
    let t = 0;
    const deps = makeDeps({ now: () => (t += 100) });
    await new BackfillService(deps).processSite(job(), { daysPerTick: 100, budgetMs: 150 });
    expect((deps.rollupDay as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThan(5);
  });

  it('marks complete when the cursor passes newest_date', async () => {
    const deps = makeDeps();
    await new BackfillService(deps).processSite(job(), { daysPerTick: 100, budgetMs: 1e9 });
    expect(deps.markComplete).toHaveBeenCalledWith('S1');
  });

  it('flips genesis_anchored once a day anchors, stops forcing after', async () => {
    const rollupDay = vi.fn()
      .mockResolvedValueOnce({ genesisAnchored: false })  // day 1: forced, no anchor
      .mockResolvedValueOnce({ genesisAnchored: true })   // day 2: forced, anchors
      .mockResolvedValue({ genesisAnchored: false });     // day 3+
    const deps = makeDeps({ rollupDay });
    await new BackfillService(deps).processSite(job(), { daysPerTick: 100, budgetMs: 1e9 });
    expect(rollupDay.mock.calls[0][2]).toEqual({ rows: [], forceGenesisAtStart: true });
    expect(rollupDay.mock.calls[1][2]).toEqual({ rows: [], forceGenesisAtStart: true });
    expect(rollupDay.mock.calls[2][2]).toEqual({ rows: [], forceGenesisAtStart: false });
  });

  it('on error marks the row and preserves the cursor', async () => {
    const deps = makeDeps({ rollupDay: vi.fn(async () => { throw new Error('boom'); }) });
    await new BackfillService(deps).processSite(job(), { daysPerTick: 100, budgetMs: 1e9 });
    expect(deps.markError).toHaveBeenCalledWith('S1', 'boom');
    expect(deps.markComplete).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 6: Run to verify failure**

Run: `npm test -- src/lib/battery-provenance/backfill-service`
Expected: FAIL — module not found.

- [ ] **Step 7: Implement `BackfillService`**

```ts
import type { EnergyData, SiteWithTariffs } from '../db';
import { addLocalDays } from './local-day';

export interface BackfillJob {
  siteId: string;
  oldestDate: string;
  cursorDate: string;
  newestDate: string;
  daysDone: number;
  genesisAnchored: boolean;
}

export interface BackfillDeps {
  loadSite: (siteId: string) => Promise<SiteWithTariffs>;
  fetchRange: (site: SiteWithTariffs, start: Date, end: Date) => Promise<EnergyData[]>;
  ensureData: (siteId: string, start: Date, end: Date) => Promise<void>;
  rollupDay: (siteId: string, localDate: string, opts: { rows?: EnergyData[]; forceGenesisAtStart: boolean }) => Promise<{ genesisAnchored: boolean }>;
  recordProgress: (siteId: string, cursorDate: string, daysDone: number, genesisAnchored: boolean) => Promise<void>;
  markComplete: (siteId: string) => Promise<void>;
  markError: (siteId: string, message: string) => Promise<void>;
  retentionCutoff: () => Date;
  localDayBounds: (localDate: string, tz: string) => { start: Date; end: Date };
  now: () => number;
}

export interface TickOptions { daysPerTick: number; budgetMs: number; }

export class BackfillService {
  constructor(private deps: BackfillDeps) {}

  async processSite(job: BackfillJob, opts: TickOptions): Promise<void> {
    const d = this.deps;
    let cursor = job.cursorDate;
    let daysDone = job.daysDone;
    let anchored = job.genesisAnchored;
    const startedAt = d.now();

    try {
      const site = await d.loadSite(job.siteId);
      let processed = 0;
      while (
        cursor <= job.newestDate &&
        processed < opts.daysPerTick &&
        d.now() - startedAt < opts.budgetMs
      ) {
        const { start, end } = d.localDayBounds(cursor, site.timezone);
        const forceGenesisAtStart = !anchored;

        let res: { genesisAnchored: boolean };
        if (end.getTime() < d.retentionCutoff().getTime()) {
          const rows = await d.fetchRange(site, start, end);          // Tesla → memory, never persisted
          res = await d.rollupDay(site.id, cursor, { rows, forceGenesisAtStart });
        } else {
          await d.ensureData(site.id, start, end);                    // persist recent EnergyData
          res = await d.rollupDay(site.id, cursor, { forceGenesisAtStart });
        }
        if (!anchored && res.genesisAnchored) anchored = true;

        cursor = addLocalDays(cursor, 1);
        daysDone += 1;
        processed += 1;
        await d.recordProgress(site.id, cursor, daysDone, anchored); // incremental commit
      }
      if (cursor > job.newestDate) await d.markComplete(site.id);
    } catch (e) {
      await d.markError(job.siteId, e instanceof Error ? e.message : String(e));
    }
  }
}
```

- [ ] **Step 8: Run to verify pass**

Run: `npm test -- src/lib/battery-provenance/backfill-service`
Expected: PASS (7 tests).

- [ ] **Step 9: Commit**

```bash
git add src/lib/battery-provenance/local-day.ts src/lib/battery-provenance/local-day.test.ts src/lib/battery-provenance/backfill-service.ts src/lib/battery-provenance/backfill-service.test.ts
git commit -m "feat(roi): BackfillService (chunked, retention-split, forced genesis) + addLocalDays"
```

---

## Task 6: Worker route `/api/cron/index-history`

**Files:**
- Create: `cmd/next-app/src/app/api/cron/index-history/route.ts`

This route wires real deps into `BackfillService`. Verified by build + manual curl; no unit test (it is thin glue, like other cron routes).

- [ ] **Step 1: Implement the route**

```ts
export const dynamic = 'force-dynamic';
export const maxDuration = 300; // claim the full Vercel function budget

import { NextRequest, NextResponse } from 'next/server';
import { SiteRepo } from '@/lib/site-repo';
import { EnergyRepo } from '@/lib/energy-repo';
import { RollupRepo } from '@/lib/battery-provenance/rollup-repo';
import { RollupService } from '@/lib/battery-provenance/rollup-service';
import { RollupBackfillRepo } from '@/lib/battery-provenance/rollup-backfill-repo';
import { BackfillService } from '@/lib/battery-provenance/backfill-service';
import { localDayBoundsUtc } from '@/lib/battery-provenance/local-day';
import { createSiteTeslaClient } from '@/lib/battery-hold-service';
import { Importer } from '@/lib/importer';
import type { EnergyData } from '@/lib/db';

const DAYS_PER_TICK = parseInt(process.env.INDEX_HISTORY_DAYS_PER_TICK || '45', 10);
const SITES_PER_TICK = parseInt(process.env.INDEX_HISTORY_SITES_PER_TICK || '1', 10);
const BUDGET_MS = 250_000;
const RETENTION_DAYS = parseInt(process.env.DATA_RETENTION_DAYS || '365', 10);

export async function GET(request: NextRequest) {
  if (request.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const siteRepo = new SiteRepo();
  const energyRepo = new EnergyRepo();
  const rollupRepo = new RollupRepo();
  const backfillRepo = new RollupBackfillRepo();
  const processed: Array<{ siteId: string }> = [];

  for (let i = 0; i < SITES_PER_TICK; i++) {
    const job = await backfillRepo.claimNext();
    if (!job) break;

    const client = await createSiteTeslaClient(job.site_id);
    if (!client) {
      await backfillRepo.markError(job.site_id, 'no Tesla tokens');
      continue;
    }
    const importer = new Importer(client);
    const rollupService = new RollupService({
      loadSite: async (id) => {
        const s = await siteRepo.getSite(id);
        if (!s) throw new Error(`site ${id} not found`);
        return { id: s.id, timezone: s.timezone, tariffs: s.tariffs ?? [] };
      },
      loadEnergyData: (id, start, end) => energyRepo.getRawEnergyData(id, start, end),
      getSeedTank: (id, beforeTs) => rollupRepo.getSeedTank(id, beforeTs),
      hasAnyRollup: (id) => rollupRepo.hasAnyRollup(id),
      upsertRollups: (rows) => rollupRepo.upsertRollups(rows),
    });

    const service = new BackfillService({
      loadSite: async (id) => {
        const s = await siteRepo.getSite(id);
        if (!s) throw new Error(`site ${id} not found`);
        return s;
      },
      fetchRange: (site, start, end) => importer.fetchRange(site, start, end, 'day') as Promise<EnergyData[]>,
      ensureData: async (id, start, end) => { await importer.ensureDataForRange(id, start, end); },
      rollupDay: (id, localDate, opts) => rollupService.rollupDay(id, localDate, opts),
      recordProgress: (id, cursor, done, anchored) => backfillRepo.recordProgress(id, cursor, done, anchored),
      markComplete: (id) => backfillRepo.markComplete(id),
      markError: (id, msg) => backfillRepo.markError(id, msg),
      retentionCutoff: () => new Date(Date.now() - RETENTION_DAYS * 86400_000),
      localDayBounds: (localDate, tz) => localDayBoundsUtc(localDate, tz),
      now: () => Date.now(),
    });

    await service.processSite(
      { siteId: job.site_id, oldestDate: job.oldest_date, cursorDate: job.cursor_date,
        newestDate: job.newest_date, daysDone: job.days_done, genesisAnchored: job.genesis_anchored },
      { daysPerTick: DAYS_PER_TICK, budgetMs: BUDGET_MS },
    );
    processed.push({ siteId: job.site_id });
  }

  return NextResponse.json({ success: true, processed });
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: succeeds (`fetchRange` returns `EnergyDataRow[]`, structurally assignable to `EnergyData[]`; the `as` cast documents intent).

- [ ] **Step 3: Commit**

```bash
git add src/app/api/cron/index-history/route.ts
git commit -m "feat(roi): index-history worker route"
```

---

## Task 7: pg_cron trigger migration for the worker

**Files:**
- Create: `cmd/next-app/db-migrations/<ts>_index_history_cron_trigger.sql`

Mirror `db-migrations/20260525030000_supabase_cron_trigger.sql`. The `{{INDEX_HISTORY_CRON_TARGET_URL}}` and `{{CRON_SECRET}}` placeholders are substituted at deploy time by the existing GitHub Actions step (confirm the workflow substitutes both — see Step 3).

- [ ] **Step 1: Generate the migration**

Run: `npm run db:migration:create index_history_cron_trigger`

- [ ] **Step 2: Write the SQL**

```sql
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

DO $$
DECLARE secret_id uuid;
BEGIN
  SELECT id INTO secret_id FROM vault.decrypted_secrets WHERE name = 'index_history_cron_target_url';
  IF secret_id IS NOT NULL THEN
    PERFORM vault.update_secret(secret_id, $u${{INDEX_HISTORY_CRON_TARGET_URL}}$u$, 'index_history_cron_target_url', 'Vercel index-history worker URL');
  ELSE
    PERFORM vault.create_secret($u${{INDEX_HISTORY_CRON_TARGET_URL}}$u$, 'index_history_cron_target_url', 'Vercel index-history worker URL');
  END IF;
END $$;

-- cron_secret is already managed by the restore-reserve migration; reuse it.

SELECT cron.unschedule('index-history-trigger') FROM cron.job WHERE jobname = 'index-history-trigger';

SELECT cron.schedule(
  'index-history-trigger',
  '*/15 * * * *',
  $$
  SELECT net.http_get(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'index_history_cron_target_url' LIMIT 1),
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret' LIMIT 1)
    ),
    timeout_milliseconds := 5000
  );
  $$
);
```

- [ ] **Step 3: Wire the deploy-time placeholder**

Find where `{{BATTERY_RESTORE_CRON_TARGET_URL}}` is substituted (GitHub Actions workflow under `.github/workflows/`). Add a sibling substitution for `{{INDEX_HISTORY_CRON_TARGET_URL}}` → `https://<prod-host>/api/cron/index-history`. Set the repo/Vercel env value accordingly.

Run: `grep -rn "BATTERY_RESTORE_CRON_TARGET_URL" ../../.github` (from `cmd/next-app/`)
Expected: locate the substitution step; mirror it for the new placeholder.

- [ ] **Step 4: Commit**

```bash
git add db-migrations/*_index_history_cron_trigger.sql
git commit -m "feat(roi): pg_cron trigger for index-history worker"
```

---

## Task 8: Opt-in route `POST /api/site/[id]/index-history`

**Files:**
- Create: `cmd/next-app/src/app/api/site/[id]/index-history/route.ts`

- [ ] **Step 1: Confirm `verifySiteAccess` + the params shape** of a sibling dynamic route

Run: `sed -n '1,30p' src/app/api/site/\[id\]/analysis/route.ts`
Expected: shows the `verifySiteAccess` import and how `params` is awaited. Mirror that exact signature.

- [ ] **Step 2: Implement the route**

```ts
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { verifySiteAccess } from '@/lib/auth-checks';
import { SiteRepo } from '@/lib/site-repo';
import { RollupBackfillRepo } from '@/lib/battery-provenance/rollup-backfill-repo';
import { localDateKey } from '@/lib/battery-provenance/local-day';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await verifySiteAccess(id))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const site = await new SiteRepo().getSite(id);
  if (!site) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const oldest = localDateKey(new Date(site.installed), site.timezone);
  const newest = localDateKey(new Date(Date.now() - 86400_000), site.timezone); // yesterday, site-local
  await new RollupBackfillRepo().enqueue(id, oldest, newest);

  return NextResponse.json({ success: true });
}
```

(If Step 1 shows `params` is a plain object rather than a Promise, drop the `await`/`Promise<>` accordingly to match the codebase's Next version.)

- [ ] **Step 3: Verify build + commit**

Run: `npm run build`
Expected: succeeds.

```bash
git add src/app/api/site/\[id\]/index-history/route.ts
git commit -m "feat(roi): opt-in route to enqueue history indexing"
```

---

## Task 9: Hourly, timezone-aware, partial-safe daily rollup

**Files:**
- Modify: `cmd/next-app/src/app/api/cron/rollup/route.ts`
- Modify: `cmd/next-app/vercel.json`
- Create: `cmd/next-app/src/lib/battery-provenance/rollup-window.ts`
- Test: `cmd/next-app/src/lib/battery-provenance/rollup-window.test.ts`

- [ ] **Step 1: Write failing tests for the selection helper**

```ts
import { describe, it, expect } from 'vitest';
import { isInRollupBand, localHourFor } from './rollup-window';

describe('rollup window selection', () => {
  it('localHourFor returns the wall-clock hour in the given zone', () => {
    // 2026-01-02T10:00:00Z is 02:00 in America/Los_Angeles (UTC-8)
    expect(localHourFor(new Date('2026-01-02T10:00:00Z'), 'America/Los_Angeles')).toBe(2);
  });
  it('isInRollupBand true for local hours 2..5, false otherwise', () => {
    const tz = 'UTC';
    expect(isInRollupBand(new Date('2026-01-02T02:30:00Z'), tz)).toBe(true);
    expect(isInRollupBand(new Date('2026-01-02T05:00:00Z'), tz)).toBe(true);
    expect(isInRollupBand(new Date('2026-01-02T06:00:00Z'), tz)).toBe(false);
    expect(isInRollupBand(new Date('2026-01-02T01:00:00Z'), tz)).toBe(false);
  });
  it('half-hour zones still land in the band', () => {
    // 21:00Z is 02:30 in Asia/Kolkata (UTC+5:30)
    expect(isInRollupBand(new Date('2026-01-02T21:00:00Z'), 'Asia/Kolkata')).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- src/lib/battery-provenance/rollup-window`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helper**

```ts
/** Wall-clock hour (0–23) in `timeZone` for the given instant. */
export function localHourFor(now: Date, timeZone: string): number {
  const hh = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', hour12: false }).format(now);
  return parseInt(hh, 10) % 24;
}

/** True when it's early morning (local hours 2–5) for the site — its previous day is fully elapsed. */
export function isInRollupBand(now: Date, timeZone: string, lo = 2, hi = 5): boolean {
  const h = localHourFor(now, timeZone);
  return h >= lo && h <= hi;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- src/lib/battery-provenance/rollup-window`
Expected: PASS (3 tests).

- [ ] **Step 5: Rewrite the rollup cron route**

Replace `src/app/api/cron/rollup/route.ts` with:

```ts
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { EnergyRepo } from '@/lib/energy-repo';
import { SiteRepo } from '@/lib/site-repo';
import { RollupService } from '@/lib/battery-provenance/rollup-service';
import { RollupRepo } from '@/lib/battery-provenance/rollup-repo';
import { localDateKey, localDayBoundsUtc, addLocalDays } from '@/lib/battery-provenance/local-day';
import { classifyDayCoverage } from '@/lib/battery-provenance/day-coverage';
import { isInRollupBand } from '@/lib/battery-provenance/rollup-window';
import { createSiteTeslaClient } from '@/lib/battery-hold-service';
import { Importer } from '@/lib/importer';

export async function GET(request: NextRequest) {
  if (request.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const siteRepo = new SiteRepo();
  const energyRepo = new EnergyRepo();
  const rollupRepo = new RollupRepo();
  const now = new Date();
  const results: Array<{ siteId: string; localDate: string; action: string }> = [];

  const buildService = () => new RollupService({
    loadSite: async (siteId) => {
      const site = await siteRepo.getSite(siteId);
      if (!site) throw new Error(`site ${siteId} not found`);
      return { id: site.id, timezone: site.timezone, tariffs: site.tariffs ?? [] };
    },
    loadEnergyData: (siteId, start, end) => energyRepo.getRawEnergyData(siteId, start, end),
    getSeedTank: (siteId, beforeTs) => rollupRepo.getSeedTank(siteId, beforeTs),
    hasAnyRollup: (siteId) => rollupRepo.hasAnyRollup(siteId),
    upsertRollups: (rows) => rollupRepo.upsertRollups(rows),
  });

  for (const siteId of await siteRepo.getSiteIds()) {
    try {
      const site = await siteRepo.getSite(siteId);
      if (!site || !isInRollupBand(now, site.timezone)) continue;

      const localDate = localDateKey(new Date(now.getTime() - 86400_000), site.timezone); // yesterday-local
      if (await rollupRepo.hasRollupForDate(siteId, localDate)) {
        results.push({ siteId, localDate, action: 'skip-already-rolled' });
        continue;
      }

      const { start, end } = localDayBoundsUtc(localDate, site.timezone);
      const stamps = await energyRepo.getExistingTimestamps(siteId, start, end);
      const coverage = classifyDayCoverage(stamps.map(Number), start, end);

      if (coverage === 'empty') { results.push({ siteId, localDate, action: 'skip-no-data' }); continue; }

      if (coverage === 'partial') {
        const client = await createSiteTeslaClient(siteId);
        if (client) await new Importer(client).ensureDataForRange(siteId, start, end, undefined, { force: true });
        const restamps = (await energyRepo.getExistingTimestamps(siteId, start, end)).map(Number);
        if (classifyDayCoverage(restamps, start, end) !== 'complete') {
          results.push({ siteId, localDate, action: 'skip-still-partial' }); // safety net: never persist a partial rollup
          continue;
        }
      }

      const { rollupCount } = await buildService().rollupDay(siteId, localDate);
      results.push({ siteId, localDate, action: `rolled-${rollupCount}` });
    } catch (e) {
      console.error(`[CRON rollup] site ${siteId} failed:`, e);
    }
  }

  return NextResponse.json({ success: true, results });
}
```

- [ ] **Step 6: Switch the cron to hourly in `vercel.json`**

Change the rollup entry's schedule:

```json
{ "path": "/api/cron/rollup", "schedule": "0 * * * *" }
```

- [ ] **Step 7: Verify build + tests + commit**

Run: `npm run build && npm test -- src/lib/battery-provenance/rollup-window`
Expected: both pass.

```bash
git add src/app/api/cron/rollup/route.ts vercel.json src/lib/battery-provenance/rollup-window.ts src/lib/battery-provenance/rollup-window.test.ts
git commit -m "feat(roi): hourly timezone-aware partial-safe rollup cron"
```

---

## Task 10: Heal-on-return + Savings indexing UI

**Files:**
- Create: `cmd/next-app/src/components/site/savings/IndexingStatus.tsx`
- Modify: `cmd/next-app/src/components/site/savings/SavingsView.tsx`
- Modify: `cmd/next-app/src/app/site/[id]/page.tsx`

- [ ] **Step 1: Build the `IndexingStatus` client component**

```tsx
'use client';
import { useState } from 'react';
import type { RollupBackfill } from '@/lib/db';
import { Card, CardContent } from '@/components/ui/Card';

export function IndexingStatus({ siteId, backfill }: { siteId: string; backfill: RollupBackfill | null }) {
  const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState(false);

  if (backfill && (backfill.status === 'pending' || backfill.status === 'running')) {
    const pct = backfill.days_total > 0 ? Math.round((backfill.days_done / backfill.days_total) * 100) : 0;
    return (
      <Card><CardContent className="py-6">
        <p className="font-semibold mb-2">Indexing your history… {pct}%</p>
        <div className="h-2 rounded-full bg-bg-muted overflow-hidden"><div className="h-full bg-primary" style={{ width: `${pct}%` }} /></div>
        <p className="text-xs opacity-70 mt-2">Reconstructed back to {backfill.cursor_date}. This runs in the background; check back later.</p>
      </CardContent></Card>
    );
  }

  const start = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/site/${siteId}/index-history`, { method: 'POST' });
      if (res.ok) setStarted(true);
    } finally { setBusy(false); }
  };

  return (
    <Card><CardContent className="py-8 text-center">
      <p className="text-lg font-semibold mb-2">See your full payback history</p>
      <p className="opacity-70 mb-4">We can reconstruct your savings back to install. This runs in the background and may take a while.</p>
      {started
        ? <p className="text-sm text-primary">Indexing started — check back soon.</p>
        : <button onClick={start} disabled={busy} className="rounded-md bg-primary text-white px-4 py-2 disabled:opacity-60">{busy ? 'Starting…' : 'Index history'}</button>}
    </CardContent></Card>
  );
}
```

- [ ] **Step 2: Render it from `SavingsView`**

In `SavingsView.tsx`, extend the props and show `IndexingStatus` when there's no summary yet OR an active backfill. Update the signature and the early return:

```tsx
import { IndexingStatus } from './IndexingStatus';
import type { RollupBackfill } from '@/lib/db';

export function SavingsView({
    summary, arbitrageSlot, chartSlot, siteId, backfill,
}: {
    summary: RoiSummary | null;
    arbitrageSlot?: React.ReactNode;
    chartSlot?: React.ReactNode;
    siteId: string;
    backfill: RollupBackfill | null;
}) {
    const indexing = backfill?.status === 'pending' || backfill?.status === 'running';
    if (!summary || indexing) {
        return (
            <div className="space-y-6 max-w-5xl mx-auto">
                <IndexingStatus siteId={siteId} backfill={backfill} />
                {!summary && !backfill && <SavingsEmptyState />}
            </div>
        );
    }
    // …existing body unchanged…
```

- [ ] **Step 3: Heal-on-load + pass props from the site page**

In `src/app/site/[id]/page.tsx`, near the existing `roiConfig` block (~line 289), add backfill read + heal, and pass to `SavingsView` (~line 357):

```tsx
import { RollupBackfillRepo } from '@/lib/battery-provenance/rollup-backfill-repo';
import { localDateKey } from '@/lib/battery-provenance/local-day';

// …after roiConfig is loaded:
const backfillRepo = new RollupBackfillRepo();
const yesterday = localDateKey(new Date(Date.now() - 86400_000), finalSite.timezone);
await backfillRepo.reopenIfBehind(finalSite.id, yesterday); // heal a dormant gap on visit
const backfill = await backfillRepo.get(finalSite.id);
```

Then update the `<SavingsView … />` usage to pass the two new props:

```tsx
<SavingsView
    summary={roiSummary}
    siteId={finalSite.id}
    backfill={backfill}
    arbitrageSlot={/* existing */}
    chartSlot={savingsSeries && roiConfig ? <SavingsChart series={savingsSeries} systemCost={(roiConfig.solar_cost ?? 0) + (roiConfig.battery_cost ?? 0)} /> : null}
/>
```

- [ ] **Step 4: Verify build**

Run: `npm run build`
Expected: succeeds. Manually confirm: a site with no `RollupBackfill` row shows the **Index history** button; clicking it POSTs and flips to the progress card on reload.

- [ ] **Step 5: Commit**

```bash
git add src/components/site/savings/IndexingStatus.tsx src/components/site/savings/SavingsView.tsx src/app/site/\[id\]/page.tsx
git commit -m "feat(roi): Savings tab indexing opt-in, progress, and heal-on-return"
```

---

## Task 11: Admin per-site indexing badge

**Files:**
- Modify: `cmd/next-app/src/lib/user-repo.ts` (the `getAllUsers` site query, ~line 70)
- Modify: `cmd/next-app/src/app/admin/AdminDashboard.tsx` (Sites column, ~line 100)

- [ ] **Step 1: Join backfill status into the admin site query**

In `getAllUsers`, replace the sites query (line ~70) to LEFT JOIN the ledger and carry the fields:

```ts
const siteRes = await pool.query(`
  SELECT s.id, s.user_id, s.name, s.utility, s.updated, s.installed, s.timezone,
         s.billing_start_day, s.timezone_display_mode,
         rb.status AS backfill_status, rb.days_done AS backfill_days_done,
         rb.days_total AS backfill_days_total, rb.cursor_date::text AS backfill_cursor,
         rb.newest_date::text AS backfill_newest, rb.oldest_date::text AS backfill_oldest,
         rb.last_error AS backfill_error, rb.updated_at AS backfill_updated
  FROM "Site" s
  LEFT JOIN "RollupBackfill" rb ON rb.site_id = s.id`);
const sites = siteRes.rows as (Site & {
  backfill_status: string | null; backfill_days_done: number | null; backfill_days_total: number | null;
  backfill_cursor: string | null; backfill_newest: string | null; backfill_oldest: string | null;
  backfill_error: string | null; backfill_updated: Date | null;
})[];
```

(If `Site`/`UserWithSites` are strongly typed and reject the extra fields downstream, widen the `sites` array type as above where it's mapped onto users — the `map` at line ~74 spreads `userSites` which already carries these.)

- [ ] **Step 2: Render the badge with a hover title in the Sites column**

In `AdminDashboard.tsx`, replace the site link (lines ~102–108) with link + badge:

```tsx
{user.sites.map((site) => {
  const s = site as typeof site & {
    backfill_status?: string | null; backfill_days_done?: number | null; backfill_days_total?: number | null;
    backfill_cursor?: string | null; backfill_oldest?: string | null; backfill_newest?: string | null;
    backfill_error?: string | null; backfill_updated?: string | null;
  };
  const pct = s.backfill_days_total ? Math.round((s.backfill_days_done! / s.backfill_days_total) * 100) : 0;
  const label = !s.backfill_status ? 'Not indexed'
    : s.backfill_status === 'pending' ? 'Queued'
    : s.backfill_status === 'running' ? `Indexing ${pct}%`
    : s.backfill_status === 'complete' ? 'Indexed' : 'Error';
  const tone = !s.backfill_status ? 'bg-gray-100 text-gray-500 dark:bg-slate-800'
    : s.backfill_status === 'complete' ? 'bg-green-100 text-green-700 dark:bg-green-950/40'
    : s.backfill_status === 'error' ? 'bg-red-100 text-red-700 dark:bg-red-950/40'
    : 'bg-blue-100 text-blue-700 dark:bg-blue-950/40';
  const title = s.backfill_status
    ? `status=${s.backfill_status} ${pct}% (${s.backfill_days_done}/${s.backfill_days_total})\n`
      + `cursor ${s.backfill_cursor}  range ${s.backfill_oldest}→${s.backfill_newest}\n`
      + `updated ${s.backfill_updated ?? ''}${s.backfill_error ? `\nerror: ${s.backfill_error}` : ''}`
    : 'No history indexing for this site';
  return (
    <div key={site.id} className="flex items-center gap-2">
      <Link href={`/site/${site.id}`} className="text-xs font-medium text-primary hover:text-primary/80">{site.name}</Link>
      <span title={title} className={`text-[10px] px-1.5 py-0.5 rounded ${tone}`}>{label}</span>
    </div>
  );
})}
```

- [ ] **Step 3: Verify build + commit**

Run: `npm run build && npm run lint`
Expected: both pass.

```bash
git add src/lib/user-repo.ts src/app/admin/AdminDashboard.tsx
git commit -m "feat(roi): admin per-site indexing badge with hover details"
```

---

## Final verification

- [ ] **Step 1: Full suite + build + lint**

Run: `npm test && npm run build && npm run lint`
Expected: all green.

- [ ] **Step 2: Manual smoke (against a dev DB + the Harrison test site)**

1. Opt in: `curl -X POST .../api/site/<id>/index-history` (authenticated) → a `pending` `RollupBackfill` row appears.
2. Trigger the worker: `curl -H "Authorization: Bearer $CRON_SECRET" .../api/cron/index-history` → cursor advances; `EnergyRollup` rows for old dates appear; **no** new pre-retention `EnergyData` rows persist (`SELECT count(*) FROM "EnergyData" WHERE site_id=<id> AND timestamp < now() - interval '365 days'` stays ~0).
3. Re-run the worker until `status = 'complete'`; open the Savings tab → the report renders with full history.
4. Admin page shows the site's badge progressing Queued → Indexing N% → Indexed.

---

## Self-Review notes (for the implementer)

- **Spec coverage:** Tasks map to spec sections — ledger (T1/T2), worker + forced genesis (T3/T5/T6), pg_cron (T7), opt-in (T8), heal-on-return (T2 `reopenIfBehind` + T10), hourly partial-safe cron (T4/T9), egress fetch-only (T5/T6), admin (T11). The "fetchRange returns full-day unfiltered rows; replay buckets by local date" detail is handled because `rollupDay` filters output to `localDate`.
- **Genesis force-until-anchor:** carried by `BackfillService` (`forceGenesisAtStart = !anchored`, flips on first `genesisAnchored`), persisted via `recordProgress`; heals never re-anchor because `reopenIfBehind` leaves `genesis_anchored` untouched and the cursor resumes mid-history (so `!anchored` is false).
- **Type consistency:** `rollupDay(siteId, localDate, opts)` signature is identical in T3, T5 (deps type), T6, and T9 (2-arg call, opts optional). `RollupBackfill` field names match across db.ts, repo, page, and admin.
