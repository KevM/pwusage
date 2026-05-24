# Battery Hold for Charging — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a live-page widget that parks the Powerwall backup reserve at (or above) its current SoC while a large load (EV) charges, then auto-restores the prior reserve when the load ends.

**Architecture:** A `BatteryHold` table records one active hold per site. A `battery-hold-service` (dependency-injected `TeslaClient` + repo) parks/restores; a pure `evaluateHold` decides when to restore by reusing the NILM `detectLoads` detector plus a safety timeout. A 15-min cron drives auto-restore; a site API route drives the UI. A `BatteryHoldCard` renders next to "Load timing this cycle".

**Tech Stack:** Next.js 15 (App Router, server components), TypeScript, raw-SQL Postgres (`pg` pool), Vitest, Tailwind, Tesla Fleet API.

**Spec:** `docs/superpowers/specs/2026-05-24-battery-hold-for-charging-design.md`

**Branch:** `feature/tesla-backup-reserve` (already has `TeslaClient.setBackupReserve` from `cba710e` and all NILM/live-page dependencies). Run all commands from `cmd/next-app/`.

**⚠️ The worktree `.env` `DATABASE_URL` points at the PRODUCTION Supabase DB.** Do NOT run migrations or scripts against it casually. Unit tests mock the DB and never connect.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `db-migrations/<ts>_add_battery_hold.sql` (create) | `BatteryHold` table + single-active partial unique index |
| `src/lib/db.ts` (modify) | Add `BatteryHold` interface |
| `src/lib/battery-hold-repo.ts` (create) | CRUD for `BatteryHold` (raw SQL) |
| `src/lib/battery-hold-detection.ts` (create) | Pure `evaluateHold(hold, recentPower, now)` |
| `src/lib/battery-hold-service.ts` (create) | `parkBattery`, `restoreBattery`, `computeTargetReserve`, `createSiteTeslaClient` |
| `src/app/api/site/[id]/battery-hold/route.ts` (create) | `GET` status, `POST {action}` park/restore |
| `src/app/api/cron/restore-reserve/route.ts` (create) | Cron: evaluate active holds, auto-restore |
| `vercel.json` (modify) | Register the cron at `*/15 * * * *` |
| `src/components/site/live/BatteryHoldCard.tsx` (create) | Client widget (idle / holding / reconnect / unavailable) |
| `src/components/site/live/LiveDetailView.tsx` (modify) | Render `BatteryHoldCard` |
| `src/app/site/[id]/live/page.tsx` (modify) | Fetch active hold, pass to view |

Co-located tests: `*.test.ts` next to each `lib` file.

---

## Task 1: `BatteryHold` migration + type

**Files:**
- Create: `db-migrations/20260524_180000_add_battery_hold.sql`
- Modify: `src/lib/db.ts` (after the `LoadTag` interface, ~line 149)

- [ ] **Step 1: Create the migration file**

```sql
-- Battery Hold for charging: one active "hold" per site that parks the Powerwall
-- backup reserve at (or above) the current SoC while a large load runs, then
-- auto-restores. See docs/superpowers/specs/2026-05-24-battery-hold-for-charging-design.md
-- Idempotent: IF NOT EXISTS everywhere so CI can re-run safely.
CREATE TABLE IF NOT EXISTS "BatteryHold" (
    id                BIGSERIAL PRIMARY KEY,
    site_id           TEXT NOT NULL REFERENCES "Site"(id) ON DELETE CASCADE,
    status            TEXT NOT NULL DEFAULT 'active',
    original_reserve  INTEGER NOT NULL,
    target_reserve    INTEGER NOT NULL,
    parked_soc        NUMERIC NOT NULL,
    baseline_load_w   NUMERIC NOT NULL,
    restore_reason    TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    restored_at       TIMESTAMPTZ,
    safety_expires_at TIMESTAMPTZ NOT NULL
);

-- At most one active hold per site.
CREATE UNIQUE INDEX IF NOT EXISTS battery_hold_one_active_per_site
    ON "BatteryHold"(site_id) WHERE status = 'active';

-- Cron access path: scan all active holds cheaply.
CREATE INDEX IF NOT EXISTS battery_hold_active_idx
    ON "BatteryHold"(status) WHERE status = 'active';
```

- [ ] **Step 2: Add the `BatteryHold` interface to `db.ts`**

Insert after the `LoadTag` interface:

```ts
export interface BatteryHold {
  id: number;
  site_id: string;
  status: 'active' | 'restored' | 'failed';
  original_reserve: number;
  target_reserve: number;
  parked_soc: number;
  baseline_load_w: number;
  restore_reason: 'load_ended' | 'manual' | 'safety_timeout' | null;
  created_at: Date;
  restored_at: Date | null;
  safety_expires_at: Date;
}
```

- [ ] **Step 3: Verify the type compiles**

Run: `npx tsc --noEmit`
Expected: no new errors (existing baseline errors, if any, unchanged).

> Do NOT apply the migration to the prod `DATABASE_URL`. CI applies migrations on merge. To smoke-test the SQL locally, apply it against a throwaway local Postgres only.

- [ ] **Step 4: Commit**

```bash
git add db-migrations/20260524_180000_add_battery_hold.sql src/lib/db.ts
git commit -m "feat(battery-hold): add BatteryHold table + type"
```

---

## Task 2: `BatteryHoldRepo`

**Files:**
- Create: `src/lib/battery-hold-repo.ts`
- Test: `src/lib/battery-hold-repo.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('./db', () => ({ pool: { query: queryMock } }));

import { BatteryHoldRepo } from './battery-hold-repo';

function dbRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    site_id: 'site-1',
    status: 'active',
    original_reserve: 20,
    target_reserve: 100,
    parked_soc: 90.5,
    baseline_load_w: 450,
    restore_reason: null,
    created_at: new Date('2026-05-24T18:00:00Z'),
    restored_at: null,
    safety_expires_at: new Date('2026-05-25T10:00:00Z'),
    ...overrides,
  };
}

describe('BatteryHoldRepo', () => {
  beforeEach(() => queryMock.mockReset());

  it('getActiveHold returns the mapped active hold or null', async () => {
    queryMock.mockResolvedValueOnce({ rows: [dbRow()] });
    const hold = await new BatteryHoldRepo().getActiveHold('site-1');
    expect(hold?.id).toBe(1);
    expect(hold?.parked_soc).toBe(90.5);
    expect(hold?.created_at).toBeInstanceOf(Date);
    const sql = queryMock.mock.calls[0][0] as string;
    expect(sql).toMatch(/status = 'active'/);

    queryMock.mockResolvedValueOnce({ rows: [] });
    expect(await new BatteryHoldRepo().getActiveHold('nope')).toBeNull();
  });

  it('createHold inserts and returns the row', async () => {
    queryMock.mockResolvedValueOnce({ rows: [dbRow({ target_reserve: 100 })] });
    const hold = await new BatteryHoldRepo().createHold({
      siteId: 'site-1', originalReserve: 20, targetReserve: 100,
      parkedSoc: 90.5, baselineLoadW: 450,
      safetyExpiresAt: new Date('2026-05-25T10:00:00Z'),
    });
    expect(hold.target_reserve).toBe(100);
    const [, params] = queryMock.mock.calls[0];
    expect(params).toEqual(['site-1', 20, 100, 90.5, 450, new Date('2026-05-25T10:00:00Z')]);
  });

  it('markRestored updates status, reason, restored_at', async () => {
    queryMock.mockResolvedValueOnce({ rowCount: 1 });
    await new BatteryHoldRepo().markRestored(7, 'load_ended');
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/status = 'restored'/);
    expect(sql).toMatch(/restored_at = now\(\)/);
    expect(params).toEqual([7, 'load_ended']);
  });

  it('getAllActiveHolds maps every row', async () => {
    queryMock.mockResolvedValueOnce({ rows: [dbRow({ id: 1 }), dbRow({ id: 2 })] });
    const holds = await new BatteryHoldRepo().getAllActiveHolds();
    expect(holds.map(h => h.id)).toEqual([1, 2]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/battery-hold-repo.test.ts`
Expected: FAIL — `Cannot find module './battery-hold-repo'`.

- [ ] **Step 3: Implement the repo**

```ts
import { pool } from './db';
import { BatteryHold } from './db';

function mapRow(row: {
  id: number; site_id: string | number; status: string;
  original_reserve: number; target_reserve: number;
  parked_soc: number | string; baseline_load_w: number | string;
  restore_reason: string | null; created_at: string | Date;
  restored_at: string | Date | null; safety_expires_at: string | Date;
}): BatteryHold {
  return {
    id: Number(row.id),
    site_id: row.site_id.toString(),
    status: row.status as BatteryHold['status'],
    original_reserve: Number(row.original_reserve),
    target_reserve: Number(row.target_reserve),
    parked_soc: Number(row.parked_soc),
    baseline_load_w: Number(row.baseline_load_w),
    restore_reason: row.restore_reason as BatteryHold['restore_reason'],
    created_at: new Date(row.created_at),
    restored_at: row.restored_at === null ? null : new Date(row.restored_at),
    safety_expires_at: new Date(row.safety_expires_at),
  };
}

export class BatteryHoldRepo {
  async getActiveHold(siteId: string): Promise<BatteryHold | null> {
    const { rows } = await pool.query(`
      SELECT * FROM "BatteryHold"
      WHERE site_id = $1 AND status = 'active'
      ORDER BY created_at DESC
      LIMIT 1
    `, [siteId]);
    return rows.length ? mapRow(rows[0]) : null;
  }

  async getAllActiveHolds(): Promise<BatteryHold[]> {
    const { rows } = await pool.query(`
      SELECT * FROM "BatteryHold" WHERE status = 'active' ORDER BY created_at ASC
    `);
    return rows.map(mapRow);
  }

  async createHold(params: {
    siteId: string; originalReserve: number; targetReserve: number;
    parkedSoc: number; baselineLoadW: number; safetyExpiresAt: Date;
  }): Promise<BatteryHold> {
    const { rows } = await pool.query(`
      INSERT INTO "BatteryHold"
        (site_id, original_reserve, target_reserve, parked_soc, baseline_load_w, safety_expires_at)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [
      params.siteId, params.originalReserve, params.targetReserve,
      params.parkedSoc, params.baselineLoadW, params.safetyExpiresAt,
    ]);
    return mapRow(rows[0]);
  }

  async markRestored(id: number, reason: 'load_ended' | 'manual' | 'safety_timeout'): Promise<void> {
    await pool.query(`
      UPDATE "BatteryHold"
      SET status = 'restored', restore_reason = $2, restored_at = now()
      WHERE id = $1
    `, [id, reason]);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/battery-hold-repo.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/battery-hold-repo.ts src/lib/battery-hold-repo.test.ts
git commit -m "feat(battery-hold): add BatteryHoldRepo"
```

---

## Task 3: `evaluateHold` detection (pure core)

**Files:**
- Create: `src/lib/battery-hold-detection.ts`
- Test: `src/lib/battery-hold-detection.test.ts`

**Detection contract:** `recentPower` is `PowerData[]` from `adaptTeslaData(getRawEnergyData(...))`, so `powerWatts` is **watts**. `baseline_load_w` is also **watts** (captured from `live_status.load_power`). `detectLoads` only returns *closed* events, so a matching event near `created_at` means the charging load already ended.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from 'vitest';

const { detectLoadsMock } = vi.hoisted(() => ({ detectLoadsMock: vi.fn() }));
vi.mock('./nilm/load-detection', () => ({ detectLoads: detectLoadsMock }));

import { evaluateHold } from './battery-hold-detection';
import type { BatteryHold } from './db';
import type { PowerData } from './nilm/types';

const PARK = new Date('2026-05-24T18:00:00Z');

function hold(overrides: Partial<BatteryHold> = {}): BatteryHold {
  return {
    id: 1, site_id: 's', status: 'active',
    original_reserve: 20, target_reserve: 100,
    parked_soc: 90, baseline_load_w: 500,
    restore_reason: null, created_at: PARK, restored_at: null,
    safety_expires_at: new Date('2026-05-25T10:00:00Z'),
    ...overrides,
  };
}

// power samples every 5 min starting at PARK
function series(watts: number[]): PowerData[] {
  return watts.map((w, i) => ({
    timestamp: new Date(PARK.getTime() + i * 5 * 60 * 1000).toISOString(),
    powerWatts: w,
  }));
}

describe('evaluateHold', () => {
  it('restores on safety timeout regardless of load', () => {
    detectLoadsMock.mockReturnValue([]);
    const now = new Date('2026-05-25T10:00:01Z'); // past safety_expires_at
    expect(evaluateHold(hold(), series([8000, 8000]), now)).toEqual({ restore: true, reason: 'safety_timeout' });
  });

  it('restores when a closed NILM event sits near the park time', () => {
    detectLoadsMock.mockReturnValue([
      { startTime: new Date(PARK.getTime() + 5 * 60 * 1000), endTime: new Date(PARK.getTime() + 60 * 60 * 1000) },
    ]);
    const now = new Date(PARK.getTime() + 90 * 60 * 1000);
    expect(evaluateHold(hold(), series([500, 8000, 8000, 500]), now)).toEqual({ restore: true, reason: 'load_ended' });
  });

  it('keeps holding right after park before the load ramps (no false restore)', () => {
    detectLoadsMock.mockReturnValue([]); // no closed event yet
    const now = new Date(PARK.getTime() + 10 * 60 * 1000);
    // load never rose above baseline+1000 -> nothing to wait to end
    expect(evaluateHold(hold(), series([500, 480, 510]), now)).toBeNull();
  });

  it('fallback: restores when load rose then returned to baseline (no closed event)', () => {
    detectLoadsMock.mockReturnValue([]); // NILM missed the rising edge
    // 8 samples at +0..+35 min: high early, back near baseline for the last ~15 min.
    // baseline 500, tol = max(400, 100) = 400, so <=900 counts as "returned".
    const data = series([500, 8000, 8000, 8000, 550, 520, 510, 505]);
    const now = new Date(PARK.getTime() + 35 * 60 * 1000); // == last sample timestamp
    expect(evaluateHold(hold(), data, now)).toEqual({ restore: true, reason: 'load_ended' });
  });

  it('keeps holding while the load is still elevated', () => {
    detectLoadsMock.mockReturnValue([]);
    const data = series([500, 8000, 8000, 8000]); // +0..+15 min, last sample still high
    const now = new Date(PARK.getTime() + 15 * 60 * 1000);
    expect(evaluateHold(hold(), data, now)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/battery-hold-detection.test.ts`
Expected: FAIL — `Cannot find module './battery-hold-detection'`.

- [ ] **Step 3: Implement the detection**

```ts
import { detectLoads } from './nilm/load-detection';
import type { PowerData } from './nilm/types';
import type { BatteryHold } from './db';

export interface RestoreDecision {
  restore: true;
  reason: 'load_ended' | 'safety_timeout';
}

// A detected event whose start is within this window of the park counts as "the load".
const PARK_MATCH_WINDOW_MS = 20 * 60 * 1000;
// The load must have risen at least this far above baseline for the fallback to arm.
const RISE_THRESHOLD_W = 1000;
// Sustained return-to-baseline window for the fallback.
const FALLBACK_SUSTAINED_MS = 15 * 60 * 1000;
const MIN_FALLBACK_SAMPLES = 3;
const BASELINE_TOLERANCE_W = 400;
const BASELINE_TOLERANCE_FRAC = 0.2;

function ts(p: PowerData): number {
  return p.timestamp instanceof Date ? p.timestamp.getTime() : new Date(p.timestamp).getTime();
}

/**
 * Decide whether an active hold should be restored. Pure: no I/O.
 * Primary signal reuses NILM detectLoads (which only returns *closed* events);
 * a closed event near the park time means the charging load ended. A fallback
 * covers a missed edge: the load rose well above baseline and has since returned.
 * Safety timeout is the ultimate backstop.
 */
export function evaluateHold(hold: BatteryHold, recentPower: PowerData[], now: Date): RestoreDecision | null {
  if (now.getTime() >= hold.safety_expires_at.getTime()) {
    return { restore: true, reason: 'safety_timeout' };
  }

  const parkedAt = hold.created_at.getTime();

  // Primary: a closed event that started around when we parked.
  const events = detectLoads(recentPower, RISE_THRESHOLD_W);
  const matched = events.some(e => Math.abs(new Date(e.startTime).getTime() - parkedAt) <= PARK_MATCH_WINDOW_MS);
  if (matched) {
    return { restore: true, reason: 'load_ended' };
  }

  // Fallback: only arm once the load actually rose above baseline since park.
  const sincePark = recentPower.filter(p => ts(p) >= parkedAt);
  const peak = sincePark.reduce((m, p) => Math.max(m, p.powerWatts), 0);
  if (peak < hold.baseline_load_w + RISE_THRESHOLD_W) {
    return null; // never rose: nothing has ended; keep holding.
  }

  const tolerance = Math.max(BASELINE_TOLERANCE_W, hold.baseline_load_w * BASELINE_TOLERANCE_FRAC);
  const cutoff = now.getTime() - FALLBACK_SUSTAINED_MS;
  const recent = recentPower.filter(p => ts(p) >= cutoff);
  if (recent.length >= MIN_FALLBACK_SAMPLES && recent.every(p => p.powerWatts <= hold.baseline_load_w + tolerance)) {
    return { restore: true, reason: 'load_ended' };
  }

  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/battery-hold-detection.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/battery-hold-detection.ts src/lib/battery-hold-detection.test.ts
git commit -m "feat(battery-hold): add evaluateHold detection core"
```

---

## Task 4: `battery-hold-service` — park & restore

**Files:**
- Create: `src/lib/battery-hold-service.ts`
- Test: `src/lib/battery-hold-service.test.ts`

The service is dependency-injected: `parkBattery`/`restoreBattery` take a `TeslaClient` and `BatteryHoldRepo`, so tests pass fakes. `createSiteTeslaClient` does the real wiring (mirrors `today-refresh.ts`).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from 'vitest';
import { computeTargetReserve, parkBattery, restoreBattery } from './battery-hold-service';
import type { BatteryHold } from './db';

function fakeRepo(active: BatteryHold | null) {
  return {
    getActiveHold: vi.fn().mockResolvedValue(active),
    createHold: vi.fn(async (p) => ({
      id: 1, site_id: p.siteId, status: 'active',
      original_reserve: p.originalReserve, target_reserve: p.targetReserve,
      parked_soc: p.parkedSoc, baseline_load_w: p.baselineLoadW,
      restore_reason: null, created_at: new Date(), restored_at: null,
      safety_expires_at: p.safetyExpiresAt,
    } as BatteryHold)),
    markRestored: vi.fn().mockResolvedValue(undefined),
  };
}

function fakeClient(over: Record<string, unknown> = {}) {
  return {
    getLiveStatus: vi.fn().mockResolvedValue({ percentage_charged: 90, load_power: 450 }),
    getEnergySiteInfo: vi.fn().mockResolvedValue({ backup_reserve_percent: 20 }),
    setBackupReserve: vi.fn().mockResolvedValue({ Code: 200, Message: 'Backup reserve updated' }),
    ...over,
  };
}

describe('computeTargetReserve', () => {
  it('floors when <=80, sends 100 above', () => {
    expect(computeTargetReserve(55.9)).toBe(55);
    expect(computeTargetReserve(80)).toBe(80);
    expect(computeTargetReserve(80.9)).toBe(80);
    expect(computeTargetReserve(81)).toBe(100);
    expect(computeTargetReserve(95)).toBe(100);
    expect(computeTargetReserve(100)).toBe(100);
  });
});

describe('parkBattery', () => {
  it('parks: sends target=100 at SoC 90 and records the hold', async () => {
    const repo = fakeRepo(null);
    const client = fakeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await parkBattery({ client: client as any, repo: repo as any, siteId: 's' });
    expect(res.status).toBe('ok');
    expect(client.setBackupReserve).toHaveBeenCalledWith('s', 100);
    const created = repo.createHold.mock.calls[0][0];
    expect(created).toMatchObject({ siteId: 's', originalReserve: 20, targetReserve: 100, parkedSoc: 90, baselineLoadW: 450 });
  });

  it('refuses when a hold is already active', async () => {
    const repo = fakeRepo({ id: 9 } as BatteryHold);
    const client = fakeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await parkBattery({ client: client as any, repo: repo as any, siteId: 's' });
    expect(res.status).toBe('already_active');
    expect(client.setBackupReserve).not.toHaveBeenCalled();
  });

  it('returns no_soc when SoC is unavailable', async () => {
    const repo = fakeRepo(null);
    const client = fakeClient({ getLiveStatus: vi.fn().mockResolvedValue({ percentage_charged: null, load_power: 0 }) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await parkBattery({ client: client as any, repo: repo as any, siteId: 's' });
    expect(res.status).toBe('no_soc');
    expect(repo.createHold).not.toHaveBeenCalled();
  });

  it('maps a 403 to needs_reauth', async () => {
    const repo = fakeRepo(null);
    const client = fakeClient({ setBackupReserve: vi.fn().mockRejectedValue(new Error('Tesla API Error: 403 forbidden')) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await parkBattery({ client: client as any, repo: repo as any, siteId: 's' });
    expect(res.status).toBe('needs_reauth');
  });
});

describe('restoreBattery', () => {
  it('restores to original_reserve and marks the hold', async () => {
    const repo = fakeRepo({ id: 5, original_reserve: 20 } as BatteryHold);
    const client = fakeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await restoreBattery({ client: client as any, repo: repo as any, siteId: 's', reason: 'manual' });
    expect(res.status).toBe('ok');
    expect(client.setBackupReserve).toHaveBeenCalledWith('s', 20);
    expect(repo.markRestored).toHaveBeenCalledWith(5, 'manual');
  });

  it('does not mark restored if the command fails', async () => {
    const repo = fakeRepo({ id: 5, original_reserve: 20 } as BatteryHold);
    const client = fakeClient({ setBackupReserve: vi.fn().mockRejectedValue(new Error('Tesla API Error: 500')) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await restoreBattery({ client: client as any, repo: repo as any, siteId: 's', reason: 'load_ended' });
    expect(res.status).toBe('error');
    expect(repo.markRestored).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/battery-hold-service.test.ts`
Expected: FAIL — `Cannot find module './battery-hold-service'`.

- [ ] **Step 3: Implement the service**

```ts
import { TeslaClient } from './tesla-client';
import { BatteryHoldRepo } from './battery-hold-repo';
import { SiteRepo } from './site-repo';
import { TeslaTokenRepo } from './tesla-token-repo';
import { UserRepo } from './user-repo';
import type { BatteryHold } from './db';

export const SAFETY_HOLD_MS = 16 * 60 * 60 * 1000; // 16h backstop

/** ≤80 holds at floor(SoC); 81–99 would clamp to 80, so hold-high at 100. */
export function computeTargetReserve(soc: number): number {
  const floor = Math.floor(soc);
  return floor <= 80 ? floor : 100;
}

function isAuthError(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return /\b(401|403)\b/.test(m) || /token|login_required|unauthor/i.test(m);
}
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export type ParkResult =
  | { status: 'ok'; hold: BatteryHold }
  | { status: 'already_active'; hold: BatteryHold }
  | { status: 'no_soc' }
  | { status: 'needs_reauth' }
  | { status: 'error'; message: string };

export interface ParkDeps { client: TeslaClient; repo: BatteryHoldRepo; siteId: string; now?: Date; }

export async function parkBattery({ client, repo, siteId, now = new Date() }: ParkDeps): Promise<ParkResult> {
  const existing = await repo.getActiveHold(siteId);
  if (existing) return { status: 'already_active', hold: existing };

  let live: { percentage_charged: number; load_power: number };
  let info: { backup_reserve_percent: number };
  try {
    [live, info] = await Promise.all([client.getLiveStatus(siteId), client.getEnergySiteInfo(siteId)]);
  } catch (e) {
    return isAuthError(e) ? { status: 'needs_reauth' } : { status: 'error', message: errMsg(e) };
  }

  const soc = live?.percentage_charged;
  if (typeof soc !== 'number' || Number.isNaN(soc)) return { status: 'no_soc' };

  const target = computeTargetReserve(soc);
  try {
    const resp = await client.setBackupReserve(siteId, target);
    if (resp?.Message && /Max Backup Reserve/i.test(resp.Message)) {
      console.warn(`[BatteryHold] unexpected clamp for ${siteId}: sent ${target}, got "${resp.Message}"`);
    }
  } catch (e) {
    return isAuthError(e) ? { status: 'needs_reauth' } : { status: 'error', message: errMsg(e) };
  }

  const hold = await repo.createHold({
    siteId,
    originalReserve: info.backup_reserve_percent,
    targetReserve: target,
    parkedSoc: soc,
    baselineLoadW: live.load_power,
    safetyExpiresAt: new Date(now.getTime() + SAFETY_HOLD_MS),
  });
  return { status: 'ok', hold };
}

export type RestoreResult =
  | { status: 'ok' }
  | { status: 'no_active_hold' }
  | { status: 'needs_reauth' }
  | { status: 'error'; message: string };

export interface RestoreDeps {
  client: TeslaClient; repo: BatteryHoldRepo; siteId: string;
  reason: 'load_ended' | 'manual' | 'safety_timeout';
}

export async function restoreBattery({ client, repo, siteId, reason }: RestoreDeps): Promise<RestoreResult> {
  const hold = await repo.getActiveHold(siteId);
  if (!hold) return { status: 'no_active_hold' };
  try {
    await client.setBackupReserve(siteId, hold.original_reserve);
  } catch (e) {
    return isAuthError(e) ? { status: 'needs_reauth' } : { status: 'error', message: errMsg(e) };
  }
  await repo.markRestored(hold.id, reason);
  return { status: 'ok' };
}

/** Build a TeslaClient for a site (null if no usable tokens). Mirrors today-refresh.ts. */
export async function createSiteTeslaClient(siteId: string): Promise<TeslaClient | null> {
  const tokens = await new UserRepo().getTokensForSite(siteId);
  if (!tokens?.access_token || !tokens?.refresh_token) return null;
  const tokenRepo = new TeslaTokenRepo(new SiteRepo());
  const handlers = tokenRepo.getLockedRefreshHandler(siteId);
  return new TeslaClient({
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    tokenRefreshHandler: handlers.refreshHandler,
    onTokenError: handlers.errorHandler,
    onTokenUpdate: () => {},
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/battery-hold-service.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/battery-hold-service.ts src/lib/battery-hold-service.test.ts
git commit -m "feat(battery-hold): add park/restore service"
```

---

## Task 5: Site API route

**Files:**
- Create: `src/app/api/site/[id]/battery-hold/route.ts`
- Test: `src/app/api/site/[id]/battery-hold/route.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { verifyMock, parkMock, restoreMock, getActiveMock, createClientMock } = vi.hoisted(() => ({
  verifyMock: vi.fn(), parkMock: vi.fn(), restoreMock: vi.fn(),
  getActiveMock: vi.fn(), createClientMock: vi.fn(),
}));

vi.mock('@/lib/auth-checks', () => ({ verifySiteAccess: verifyMock }));
vi.mock('@/lib/battery-hold-service', () => ({
  parkBattery: parkMock, restoreBattery: restoreMock, createSiteTeslaClient: createClientMock,
}));
vi.mock('@/lib/battery-hold-repo', () => ({
  BatteryHoldRepo: class { getActiveHold = getActiveMock; },
}));

import { GET, POST } from './route';

function req(body?: unknown) {
  return { json: async () => body } as unknown as Request;
}
const ctx = { params: Promise.resolve({ id: 'site-1' }) };

describe('battery-hold route', () => {
  beforeEach(() => {
    verifyMock.mockReset(); parkMock.mockReset(); restoreMock.mockReset();
    getActiveMock.mockReset(); createClientMock.mockReset();
    verifyMock.mockResolvedValue(true);
    createClientMock.mockResolvedValue({});
  });

  it('GET returns the active hold', async () => {
    getActiveMock.mockResolvedValue({ id: 1 });
    const res = await GET(req(), ctx as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hold: { id: 1 } });
  });

  it('GET 403 when unauthorized', async () => {
    verifyMock.mockResolvedValue(false);
    const res = await GET(req(), ctx as never);
    expect(res.status).toBe(403);
  });

  it('POST park returns 200 ok', async () => {
    parkMock.mockResolvedValue({ status: 'ok', hold: { id: 2 } });
    const res = await POST(req({ action: 'park' }), ctx as never);
    expect(res.status).toBe(200);
    expect(parkMock).toHaveBeenCalled();
  });

  it('POST maps needs_reauth to 409', async () => {
    parkMock.mockResolvedValue({ status: 'needs_reauth' });
    const res = await POST(req({ action: 'park' }), ctx as never);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'needs_reauth' });
  });

  it('POST 409 when no client (no tokens)', async () => {
    createClientMock.mockResolvedValue(null);
    const res = await POST(req({ action: 'park' }), ctx as never);
    expect(res.status).toBe(409);
  });

  it('POST 400 on unknown action', async () => {
    const res = await POST(req({ action: 'nope' }), ctx as never);
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run "src/app/api/site/[id]/battery-hold/route.test.ts"`
Expected: FAIL — cannot find `./route`.

- [ ] **Step 3: Implement the route**

```ts
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { verifySiteAccess } from '@/lib/auth-checks';
import { BatteryHoldRepo } from '@/lib/battery-hold-repo';
import { createSiteTeslaClient, parkBattery, restoreBattery } from '@/lib/battery-hold-service';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await verifySiteAccess(id))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }
  const hold = await new BatteryHoldRepo().getActiveHold(id);
  return NextResponse.json({ hold });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await verifySiteAccess(id))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const action = (body as { action?: string })?.action;
  if (action !== 'park' && action !== 'restore') {
    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  }

  const client = await createSiteTeslaClient(id);
  if (!client) {
    return NextResponse.json({ error: 'needs_reauth' }, { status: 409 });
  }
  const repo = new BatteryHoldRepo();

  const result = action === 'park'
    ? await parkBattery({ client, repo, siteId: id })
    : await restoreBattery({ client, repo, siteId: id, reason: 'manual' });

  switch (result.status) {
    case 'ok':
    case 'already_active':
      return NextResponse.json({ status: result.status, hold: 'hold' in result ? result.hold : null });
    case 'no_active_hold':
      return NextResponse.json({ error: 'no_active_hold' }, { status: 409 });
    case 'no_soc':
      return NextResponse.json({ error: 'no_soc' }, { status: 422 });
    case 'needs_reauth':
      return NextResponse.json({ error: 'needs_reauth' }, { status: 409 });
    default:
      return NextResponse.json({ error: result.message }, { status: 500 });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run "src/app/api/site/[id]/battery-hold/route.test.ts"`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/site/[id]/battery-hold/route.ts" "src/app/api/site/[id]/battery-hold/route.test.ts"
git commit -m "feat(battery-hold): add site battery-hold API route"
```

---

## Task 6: Restore cron + `vercel.json`

**Files:**
- Create: `src/app/api/cron/restore-reserve/route.ts`
- Test: `src/app/api/cron/restore-reserve/route.test.ts`
- Modify: `vercel.json`

- [ ] **Step 1: Write the failing test**

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getAllMock, rawMock, evalMock, refreshMock, createClientMock, restoreMock } = vi.hoisted(() => ({
  getAllMock: vi.fn(), rawMock: vi.fn(), evalMock: vi.fn(),
  refreshMock: vi.fn(), createClientMock: vi.fn(), restoreMock: vi.fn(),
}));

vi.mock('@/lib/battery-hold-repo', () => ({ BatteryHoldRepo: class { getAllActiveHolds = getAllMock; } }));
vi.mock('@/lib/energy-repo', () => ({ EnergyRepo: class { getRawEnergyData = rawMock; } }));
vi.mock('@/lib/battery-hold-detection', () => ({ evaluateHold: evalMock }));
vi.mock('@/lib/today-refresh', () => ({ refreshTodayData: refreshMock }));
vi.mock('@/lib/battery-hold-service', () => ({ createSiteTeslaClient: createClientMock, restoreBattery: restoreMock }));
vi.mock('@/lib/nilm/tesla-adapter', () => ({ adaptTeslaData: (x: unknown) => x }));

import { GET } from './route';

function req(auth?: string) {
  return { headers: { get: (k: string) => (k === 'authorization' ? auth : null) } } as unknown as Request;
}

describe('restore-reserve cron', () => {
  beforeEach(() => {
    vi.stubEnv('CRON_SECRET', 'secret');
    getAllMock.mockReset(); rawMock.mockReset(); evalMock.mockReset();
    refreshMock.mockReset(); createClientMock.mockReset(); restoreMock.mockReset();
    rawMock.mockResolvedValue([]); refreshMock.mockResolvedValue({ status: 'persisted' });
    createClientMock.mockResolvedValue({}); restoreMock.mockResolvedValue({ status: 'ok' });
  });

  it('401 without the cron secret', async () => {
    const res = await GET(req('Bearer wrong') as never);
    expect(res.status).toBe(401);
  });

  it('restores holds the detector flags', async () => {
    getAllMock.mockResolvedValue([{ id: 1, site_id: 's1', created_at: new Date() }]);
    evalMock.mockReturnValue({ restore: true, reason: 'load_ended' });
    const res = await GET(req('Bearer secret') as never);
    expect(res.status).toBe(200);
    expect(restoreMock).toHaveBeenCalledWith(expect.objectContaining({ siteId: 's1', reason: 'load_ended' }));
  });

  it('leaves holds the detector keeps', async () => {
    getAllMock.mockResolvedValue([{ id: 1, site_id: 's1', created_at: new Date() }]);
    evalMock.mockReturnValue(null);
    const res = await GET(req('Bearer secret') as never);
    expect(res.status).toBe(200);
    expect(restoreMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/api/cron/restore-reserve/route.test.ts`
Expected: FAIL — cannot find `./route`.

- [ ] **Step 3: Implement the cron**

```ts
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { BatteryHoldRepo } from '@/lib/battery-hold-repo';
import { EnergyRepo } from '@/lib/energy-repo';
import { adaptTeslaData } from '@/lib/nilm/tesla-adapter';
import { evaluateHold } from '@/lib/battery-hold-detection';
import { refreshTodayData } from '@/lib/today-refresh';
import { createSiteTeslaClient, restoreBattery } from '@/lib/battery-hold-service';

const LOOKBACK_MS = 30 * 60 * 1000;

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const repo = new BatteryHoldRepo();
  const energyRepo = new EnergyRepo();
  const holds = await repo.getAllActiveHolds();
  const now = new Date();
  const results: Array<Record<string, unknown>> = [];

  for (const hold of holds) {
    try {
      await refreshTodayData(hold.site_id);
      const start = new Date(hold.created_at.getTime() - LOOKBACK_MS);
      const rows = await energyRepo.getRawEnergyData(hold.site_id, start, now);
      const decision = evaluateHold(hold, adaptTeslaData(rows), now);

      if (!decision) {
        results.push({ siteId: hold.site_id, status: 'holding' });
        continue;
      }

      const client = await createSiteTeslaClient(hold.site_id);
      if (!client) {
        results.push({ siteId: hold.site_id, status: 'no-tokens' });
        continue;
      }
      const r = await restoreBattery({ client, repo, siteId: hold.site_id, reason: decision.reason });
      results.push({ siteId: hold.site_id, reason: decision.reason, restore: r.status });
    } catch (error) {
      results.push({ siteId: hold.site_id, status: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  }

  console.log(`[CRON] restore-reserve processed ${holds.length} hold(s): ${JSON.stringify(results)}`);
  return NextResponse.json({ success: true, processed: holds.length, results });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/api/cron/restore-reserve/route.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Register the cron in `vercel.json`**

Add to the `crons` array (after the `check-users` entry):

```json
        {
            "path": "/api/cron/restore-reserve",
            "schedule": "*/15 * * * *"
        }
```

- [ ] **Step 6: Commit**

```bash
git add src/app/api/cron/restore-reserve/route.ts src/app/api/cron/restore-reserve/route.test.ts vercel.json
git commit -m "feat(battery-hold): add restore-reserve cron"
```

---

## Task 7: `BatteryHoldCard` UI + wiring

**Files:**
- Create: `src/components/site/live/battery-hold-format.ts`
- Test: `src/components/site/live/battery-hold-format.test.ts`
- Create: `src/components/site/live/BatteryHoldCard.tsx`
- Modify: `src/components/site/live/LiveDetailView.tsx`
- Modify: `src/app/site/[id]/live/page.tsx`

Keep display logic in a pure, tested helper; the component stays thin.

- [ ] **Step 1: Write the failing test for the format helper**

```ts
import { describe, expect, it } from 'vitest';
import { holdButtonLabel } from './battery-hold-format';

describe('holdButtonLabel', () => {
  it('shows the floored SoC at or below 80', () => {
    expect(holdButtonLabel(55.7)).toBe('Hold battery at 55%');
    expect(holdButtonLabel(80)).toBe('Hold battery at 80%');
  });
  it('shows 100% (max) above 80', () => {
    expect(holdButtonLabel(90)).toBe('Hold battery at 100% (max)');
    expect(holdButtonLabel(100)).toBe('Hold battery at 100% (max)');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/site/live/battery-hold-format.test.ts`
Expected: FAIL — cannot find `./battery-hold-format`.

- [ ] **Step 3: Implement the helper**

```ts
import { computeTargetReserve } from '@/lib/battery-hold-service';

export function holdButtonLabel(soc: number): string {
  const target = computeTargetReserve(soc);
  return target === 100 ? 'Hold battery at 100% (max)' : `Hold battery at ${target}%`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/site/live/battery-hold-format.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Create `BatteryHoldCard.tsx`**

```tsx
'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import Link from 'next/link';
import { SectionCard } from '@/components/ui/SectionCard';
import { Button } from '@/components/ui/Button';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/Alert';
import { holdButtonLabel } from './battery-hold-format';

interface ActiveHold {
  target_reserve: number;
  original_reserve: number;
  created_at: string;
}

interface Props {
  siteId: string;
  soc: number | null;
  hasTariff: boolean;
  initialHold: ActiveHold | null;
}

export function BatteryHoldCard({ siteId, soc, hasTariff, initialHold }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsReauth, setNeedsReauth] = useState(false);

  async function call(action: 'park' | 'restore') {
    setBusy(true); setError(null); setNeedsReauth(false);
    try {
      const res = await fetch(`/api/site/${siteId}/battery-hold`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (res.status === 409) {
        const body = await res.json().catch(() => ({}));
        if (body?.error === 'needs_reauth') { setNeedsReauth(true); return; }
      }
      if (!res.ok) { setError('Something went wrong. Try again.'); return; }
      router.refresh();
    } catch {
      setError('Network error. Try again.');
    } finally {
      setBusy(false);
    }
  }

  let body: React.ReactNode;
  if (needsReauth) {
    body = (
      <Alert variant="warning">
        <AlertTitle>Reconnect Tesla</AlertTitle>
        <AlertDescription>
          Battery control needs the energy command permission.{' '}
          <Link href="/login" className="underline">Reconnect your Tesla account</Link>.
        </AlertDescription>
      </Alert>
    );
  } else if (initialHold) {
    body = (
      <div className="space-y-3">
        <p className="text-sm">
          Holding at <strong>{initialHold.target_reserve === 100 ? '100% (max)' : `${initialHold.target_reserve}%`}</strong>.
          Auto-restores to {initialHold.original_reserve}% when charging ends, or after the safety window.
        </p>
        <Button variant="outline" disabled={busy} onClick={() => call('restore')}>
          {busy ? 'Restoring…' : 'Restore now'}
        </Button>
      </div>
    );
  } else if (!hasTariff || soc === null) {
    body = <p className="text-sm text-gray-500">Battery hold is unavailable until live battery data is present.</p>;
  } else {
    body = (
      <div className="space-y-3">
        <p className="text-sm">
          Parks the Powerwall at its current level so a large load (e.g. EV charging) draws from solar/grid instead of the battery.
        </p>
        <Button disabled={busy} onClick={() => call('park')}>
          {busy ? 'Holding…' : holdButtonLabel(soc)}
        </Button>
      </div>
    );
  }

  return (
    <SectionCard title="Hold battery for charging" density="compact">
      {body}
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </SectionCard>
  );
}
```

- [ ] **Step 6: Render it in `LiveDetailView.tsx`**

Add the import near the other `./` imports:

```tsx
import { BatteryHoldCard } from './BatteryHoldCard';
```

Add two props to `LiveDetailViewProps`:

```tsx
    batteryHold: { target_reserve: number; original_reserve: number; created_at: string } | null;
```

Add `batteryHold` to the destructured params, then render the card immediately after the "Load timing this cycle" `SectionCard` (after its closing `</SectionCard>`, before the view's closing `</div>`):

```tsx
            <BatteryHoldCard
                siteId={siteId}
                soc={batterySoC}
                hasTariff={hasTariff}
                initialHold={batteryHold}
            />
```

- [ ] **Step 7: Fetch the active hold in `page.tsx` and pass it**

Add the import:

```tsx
import { BatteryHoldRepo } from '@/lib/battery-hold-repo';
```

Add `getActiveHold` to the existing `Promise.all` (line ~109). Add as a new array element and destructured name:

```tsx
    const [{ cycle, today }, todayTotals, todayChartRows, latestEnergyData, liveStatus, activeHold] = await Promise.all([
        repo.getCycleAndTodayTotals(id, cycleStart, todayStart, now),
        repo.getTodayTotals(id, todayStart, now),
        repo.getBucketedEnergyData(id, todayStart, now),
        repo.getLatestEnergyData(id),
        getLiveStatus(id).catch(() => null),
        new BatteryHoldRepo().getActiveHold(id),
    ]);
```

Pass it to `<LiveDetailView>` (serialize dates to strings for the client component):

```tsx
                    batteryHold={activeHold ? {
                        target_reserve: activeHold.target_reserve,
                        original_reserve: activeHold.original_reserve,
                        created_at: activeHold.created_at.toISOString(),
                    } : null}
```

- [ ] **Step 8: Verify build + the format test**

Run: `npx vitest run src/components/site/live/battery-hold-format.test.ts && npm run build`
Expected: test PASS; build succeeds.

- [ ] **Step 9: Manual verification**

Run `npm run dev:agent` (port 5174) and open a site's `/site/<id>/live`. Confirm the "Hold battery for charging" card renders next to "Load timing this cycle" with the correct button label for the current SoC. (Do not click Park against a real Powerwall unless intentionally testing the live command — it issues a real `setBackupReserve`.)

- [ ] **Step 10: Commit**

```bash
git add src/components/site/live/BatteryHoldCard.tsx src/components/site/live/battery-hold-format.ts src/components/site/live/battery-hold-format.test.ts src/components/site/live/LiveDetailView.tsx "src/app/site/[id]/live/page.tsx"
git commit -m "feat(battery-hold): add BatteryHoldCard widget to live page"
```

---

## Task 8: Full verification

- [ ] **Step 1: Lint**

Run: `npm run lint`
Expected: passes (no new errors).

- [ ] **Step 2: Full test suite**

Run: `npm test -- --run`
Expected: all pass, including the new `battery-hold-*` and `evaluateHold` tests.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 4: Commit any lint fixups**

```bash
git add -A
git commit -m "chore(battery-hold): lint/build fixups" || echo "nothing to commit"
```

---

## Self-Review Notes (for the implementer)

- **Spec coverage:** data model (Task 1), repo (2), NILM-based detection + safety (3), park-target rule incl. 81–99→100 (4), manual restore + reconnect handling (4/5), cron auto-restore (6), UI with all four states (7). Verified API behavior is encoded in `computeTargetReserve` and the clamp-warning log.
- **Units:** `evaluateHold` compares `PowerData.powerWatts` (watts, from `adaptTeslaData`) against `baseline_load_w` (watts, from `live_status.load_power`). Keep both in watts.
- **Single active hold:** enforced by the partial unique index (Task 1) and the `getActiveHold` guard in `parkBattery` (Task 4).
- **Never lose `original_reserve`:** `restoreBattery` only `markRestored`s after a successful command; cron leaves failed restores `active` to retry.
- **Known MVP limitation:** if the user parks *after* the load is already running, neither NILM nor the fallback has a rising edge to anchor on; the 16h safety timeout is the backstop. Documented in the spec.
