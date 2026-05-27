# Battery Hold Enhancements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the one-click battery hold into a two-step modal confirmation that collects hold duration (auto-detect vs strict N-hour timer) and, in the ambiguous 85–95% clamp sub-band, the 80%-vs-100% reserve; and add a shared-restore-path guard that never overwrites a reserve the user changed outside the app.

**Architecture:** Logic stays in pure/DI-tested modules (`battery-hold-rules`, `battery-hold-service`, `battery-hold-detection`, `battery-hold-repo`); the route and cron orchestrate; the UI is a thin client `ConfirmHoldModal` + `BatteryHoldCard`. The hold gains a `mode` column (`auto`/`timer`) — `safety_expires_at` doubles as the timer expiry — and an `acknowledged_at` column for the dismissible guard notice. New `status` value `cancelled` and `restore_reason` values `timer_elapsed`/`reserve_changed` ride on existing TEXT columns.

**Tech Stack:** Next.js (App Router), TypeScript, Vitest (node env; component tests use `react-dom/server` `renderToStaticMarkup`), raw-SQL `pg` repos, Supabase Postgres, Tailwind UI primitives (`Button`, `Alert`, `SectionCard`, `Switch`).

**Spec:** `docs/superpowers/specs/2026-05-25-battery-hold-enhancements-design.md`

---

## File Structure

**Create:**
- `cmd/next-app/db-migrations/20260525010000_battery_hold_enhancements.sql` — add `mode`, `acknowledged_at`.
- `cmd/next-app/src/components/site/live/ConfirmHoldModal.tsx` — the park confirmation modal.
- `cmd/next-app/src/components/site/live/ConfirmHoldModal.test.tsx` — static-render test.

**Modify:**
- `cmd/next-app/src/lib/db.ts:151-163` — extend `BatteryHold` interface.
- `cmd/next-app/src/lib/battery-hold-rules.ts` — add `planReserve`; `computeTargetReserve` becomes a wrapper.
- `cmd/next-app/src/lib/battery-hold-rules.test.ts` (Create) — `planReserve` tests.
- `cmd/next-app/src/lib/battery-hold-repo.ts` — `mode` in `createHold`/`mapRow`; `markCancelled`, `getLatestCancelledUnacked`, `acknowledge`; widen `markRestored` reason.
- `cmd/next-app/src/lib/battery-hold-repo.test.ts` — fixtures + new method tests.
- `cmd/next-app/src/lib/battery-hold-service.ts` — `parkBattery` (mode/duration/choice + `needs_choice`); `restoreBattery` guard (`reserve_changed`).
- `cmd/next-app/src/lib/battery-hold-service.test.ts` — update + new tests.
- `cmd/next-app/src/lib/battery-hold-detection.ts` — `timer` branch + `timer_elapsed` reason.
- `cmd/next-app/src/lib/battery-hold-detection.test.ts` — fixtures + timer tests.
- `cmd/next-app/src/app/api/site/[id]/battery-hold/route.ts` — park validation, restore mapping, `dismiss`, GET `notice`.
- `cmd/next-app/src/app/api/site/[id]/battery-hold/route.test.ts` — update + new tests.
- `cmd/next-app/src/app/api/cron/restore-reserve/route.ts` — timer short-circuit.
- `cmd/next-app/src/app/api/cron/restore-reserve/route.test.ts` — timer test.
- `cmd/next-app/src/components/site/live/battery-hold-format.ts` — `holdReserveText`, `guardNoticeText`.
- `cmd/next-app/src/components/site/live/battery-hold-format.test.ts` — new helper tests.
- `cmd/next-app/src/components/site/live/BatteryHoldCard.tsx` — modal trigger, payload, notice + dismiss.
- `cmd/next-app/src/components/site/live/LiveDetailView.tsx:33` — extend `batteryHold` prop, add `batteryNotice`.
- `cmd/next-app/src/app/site/[id]/live/page.tsx:110-164` — fetch notice, pass extended props.

> All commands run from `cmd/next-app`. Run a single test file with `npm test -- <path>`.

---

### Task 1: Schema + `BatteryHold` type

**Files:**
- Create: `cmd/next-app/db-migrations/20260525010000_battery_hold_enhancements.sql`
- Modify: `cmd/next-app/src/lib/db.ts:151-163`
- Modify: `cmd/next-app/src/lib/battery-hold-detection.test.ts:12-21` (keep the suite type-clean)

- [ ] **Step 1: Write the migration**

Create `cmd/next-app/db-migrations/20260525010000_battery_hold_enhancements.sql`:

```sql
-- Battery Hold enhancements: per-hold mode (auto NILM vs strict timer) and a
-- dismissible "reserve changed outside the app" guard notice. status and
-- restore_reason are plain TEXT, so their new values ('cancelled',
-- 'timer_elapsed', 'reserve_changed') need no DDL.
-- See docs/superpowers/specs/2026-05-25-battery-hold-enhancements-design.md
-- Idempotent: ADD COLUMN IF NOT EXISTS so CI can re-run safely.
ALTER TABLE "BatteryHold" ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE "BatteryHold" ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ;
```

- [ ] **Step 2: Extend the `BatteryHold` interface**

Replace `cmd/next-app/src/lib/db.ts:151-163` with:

```ts
export interface BatteryHold {
  id: number;
  site_id: string;
  status: 'active' | 'restored' | 'failed' | 'cancelled';
  mode: 'auto' | 'timer';
  original_reserve: number;
  target_reserve: number;
  parked_soc: number;
  baseline_load_w: number;
  restore_reason: 'load_ended' | 'manual' | 'safety_timeout' | 'timer_elapsed' | 'reserve_changed' | null;
  created_at: Date;
  restored_at: Date | null;
  safety_expires_at: Date;
  acknowledged_at: Date | null;
}
```

- [ ] **Step 3: Keep the detection test fixture type-clean**

The `hold()` helper in `battery-hold-detection.test.ts` returns a `BatteryHold` literal (no cast), so it must include the new required fields. Edit lines 12-21 — add `mode` and `acknowledged_at`:

```ts
function hold(overrides: Partial<BatteryHold> = {}): BatteryHold {
  return {
    id: 1, site_id: 's', status: 'active', mode: 'auto',
    original_reserve: 20, target_reserve: 100,
    parked_soc: 90, baseline_load_w: 500,
    restore_reason: null, created_at: PARK, restored_at: null,
    safety_expires_at: new Date('2026-05-25T10:00:00Z'),
    acknowledged_at: null,
    ...overrides,
  };
}
```

- [ ] **Step 4: Verify the suite still compiles and passes**

Run: `npm test -- src/lib/battery-hold-detection.test.ts`
Expected: PASS (5 tests). esbuild won't catch type drift, so also run:
Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add db-migrations/20260525010000_battery_hold_enhancements.sql src/lib/db.ts src/lib/battery-hold-detection.test.ts
git commit -m "feat(battery-hold): add mode + acknowledged_at schema and type"
```

---

### Task 2: `planReserve` rule (snap-to-nearest + ambiguity)

**Files:**
- Modify: `cmd/next-app/src/lib/battery-hold-rules.ts`
- Create: `cmd/next-app/src/lib/battery-hold-rules.test.ts`
- Modify: `cmd/next-app/src/lib/battery-hold-service.test.ts:28-37` (new `computeTargetReserve` semantics)

- [ ] **Step 1: Write the failing test**

Create `cmd/next-app/src/lib/battery-hold-rules.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { planReserve, computeTargetReserve } from './battery-hold-rules';

describe('planReserve', () => {
  it('floors and never prompts at or below 80', () => {
    expect(planReserve(55.7)).toEqual({ target: 55, ambiguous: false });
    expect(planReserve(80)).toEqual({ target: 80, ambiguous: false });
  });

  it('snaps 80<SoC<=85 down to 80, silently', () => {
    expect(planReserve(81)).toEqual({ target: 80, ambiguous: false });
    expect(planReserve(85)).toEqual({ target: 80, ambiguous: false });
  });

  it('prompts 80-vs-100 only in 85<SoC<95', () => {
    expect(planReserve(85.1)).toEqual({ target: 100, ambiguous: true, options: [80, 100] });
    expect(planReserve(90)).toEqual({ target: 100, ambiguous: true, options: [80, 100] });
    expect(planReserve(94.9)).toEqual({ target: 100, ambiguous: true, options: [80, 100] });
  });

  it('snaps 95<=SoC to 100, silently', () => {
    expect(planReserve(95)).toEqual({ target: 100, ambiguous: false });
    expect(planReserve(99)).toEqual({ target: 100, ambiguous: false });
    expect(planReserve(100)).toEqual({ target: 100, ambiguous: false });
  });

  it('computeTargetReserve returns just the scalar target', () => {
    expect(computeTargetReserve(55.7)).toBe(55);
    expect(computeTargetReserve(81)).toBe(80);
    expect(computeTargetReserve(90)).toBe(100);
    expect(computeTargetReserve(95)).toBe(100);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/battery-hold-rules.test.ts`
Expected: FAIL — `planReserve` is not exported.

- [ ] **Step 3: Implement `planReserve`**

Replace the entire contents of `cmd/next-app/src/lib/battery-hold-rules.ts` with:

```ts
export interface ReservePlan {
  /** The reserve to send if the user makes no explicit choice. */
  target: number;
  /** True only for 85 < SoC < 95, where 80 vs 100 is a real trade-off. */
  ambiguous: boolean;
  /** Present iff ambiguous: the two values to offer the user. */
  options?: [80, 100];
}

/**
 * Decide the reserve to send when parking. In the 81–99 clamp band the Powerwall
 * forces any value to 80, so the only real choices are 80 (discharge to 80, then
 * hold) or 100 (hold completely). Snap the edges to the nearest of those; only the
 * 85–95 middle is genuinely ambiguous and asks the user. Boundaries are exclusive
 * at 85 and 95: SoC exactly 85 → 80, exactly 95 → 100.
 */
export function planReserve(soc: number): ReservePlan {
  const floor = Math.floor(soc);
  if (soc <= 80) return { target: floor, ambiguous: false };
  if (soc <= 85) return { target: 80, ambiguous: false };
  if (soc < 95) return { target: 100, ambiguous: true, options: [80, 100] };
  return { target: 100, ambiguous: false };
}

/** Scalar target only. Kept for callers (e.g. the button label) that just need the number. */
export function computeTargetReserve(soc: number): number {
  return planReserve(soc).target;
}
```

- [ ] **Step 4: Update the stale `computeTargetReserve` expectations in the service test**

The old service test asserted the pre-snap rule (81 → 100). Replace `battery-hold-service.test.ts:28-37` with:

```ts
describe('computeTargetReserve', () => {
  it('floors at/below 80, snaps the clamp band toward the nearest endpoint', () => {
    expect(computeTargetReserve(55.9)).toBe(55);
    expect(computeTargetReserve(80)).toBe(80);
    expect(computeTargetReserve(81)).toBe(80);
    expect(computeTargetReserve(90)).toBe(100);
    expect(computeTargetReserve(95)).toBe(100);
    expect(computeTargetReserve(100)).toBe(100);
  });
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- src/lib/battery-hold-rules.test.ts src/components/site/live/battery-hold-format.test.ts`
Expected: PASS. (`holdButtonLabel` still routes through `computeTargetReserve`; its outputs are unchanged for the values it tests: 55→55, 80→80, 90→100, 100→100.)

- [ ] **Step 6: Commit**

```bash
git add src/lib/battery-hold-rules.ts src/lib/battery-hold-rules.test.ts src/lib/battery-hold-service.test.ts
git commit -m "feat(battery-hold): planReserve with snap-to-nearest + 85-95 ambiguity"
```

---

### Task 3: Repo methods (mode, cancel, notice, acknowledge)

**Files:**
- Modify: `cmd/next-app/src/lib/battery-hold-repo.ts`
- Modify: `cmd/next-app/src/lib/battery-hold-repo.test.ts`

- [ ] **Step 1: Write the failing tests**

In `battery-hold-repo.test.ts`, (a) add `mode` and `acknowledged_at` to the `dbRow()` helper (lines 9-23, inside the returned object) so mapped rows are realistic:

```ts
    restored_at: null,
    safety_expires_at: new Date('2026-05-25T10:00:00Z'),
    mode: 'auto',
    acknowledged_at: null,
    ...overrides,
```

(b) Update the existing `createHold` test (lines 41-51) to expect `mode` as the 7th param:

```ts
  it('createHold inserts and returns the row', async () => {
    queryMock.mockResolvedValueOnce({ rows: [dbRow({ target_reserve: 100 })] });
    const hold = await new BatteryHoldRepo().createHold({
      siteId: 'site-1', originalReserve: 20, targetReserve: 100,
      parkedSoc: 90.5, baselineLoadW: 450,
      safetyExpiresAt: new Date('2026-05-25T10:00:00Z'), mode: 'timer',
    });
    expect(hold.target_reserve).toBe(100);
    const [, params] = queryMock.mock.calls[0];
    expect(params).toEqual(['site-1', 20, 100, 90.5, 450, new Date('2026-05-25T10:00:00Z'), 'timer']);
  });
```

(c) Append new method tests inside the `describe('BatteryHoldRepo', ...)` block:

```ts
  it('createHold defaults mode to auto when omitted', async () => {
    queryMock.mockResolvedValueOnce({ rows: [dbRow()] });
    await new BatteryHoldRepo().createHold({
      siteId: 'site-1', originalReserve: 20, targetReserve: 100,
      parkedSoc: 90.5, baselineLoadW: 450,
      safetyExpiresAt: new Date('2026-05-25T10:00:00Z'),
    });
    const [, params] = queryMock.mock.calls[0];
    expect(params[6]).toBe('auto');
  });

  it('mapRow surfaces mode and acknowledged_at', async () => {
    queryMock.mockResolvedValueOnce({ rows: [dbRow({ mode: 'timer', acknowledged_at: new Date('2026-05-25T11:00:00Z') })] });
    const hold = await new BatteryHoldRepo().getActiveHold('site-1');
    expect(hold?.mode).toBe('timer');
    expect(hold?.acknowledged_at).toBeInstanceOf(Date);
  });

  it('markCancelled sets status=cancelled and reason without a Tesla write', async () => {
    queryMock.mockResolvedValueOnce({ rowCount: 1 });
    await new BatteryHoldRepo().markCancelled(7, 'reserve_changed');
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/status = 'cancelled'/);
    expect(sql).toMatch(/restored_at = now\(\)/);
    expect(params).toEqual([7, 'reserve_changed']);
  });

  it('getLatestCancelledUnacked filters to unacked reserve_changed cancels', async () => {
    queryMock.mockResolvedValueOnce({ rows: [dbRow({ id: 9, status: 'cancelled', restore_reason: 'reserve_changed' })] });
    const notice = await new BatteryHoldRepo().getLatestCancelledUnacked('site-1');
    expect(notice?.id).toBe(9);
    const sql = queryMock.mock.calls[0][0] as string;
    expect(sql).toMatch(/status = 'cancelled'/);
    expect(sql).toMatch(/restore_reason = 'reserve_changed'/);
    expect(sql).toMatch(/acknowledged_at IS NULL/);
  });

  it('acknowledge stamps acknowledged_at', async () => {
    queryMock.mockResolvedValueOnce({ rowCount: 1 });
    await new BatteryHoldRepo().acknowledge(9);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/acknowledged_at = now\(\)/);
    expect(params).toEqual([9]);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/lib/battery-hold-repo.test.ts`
Expected: FAIL — `markCancelled`/`getLatestCancelledUnacked`/`acknowledge` undefined; `createHold` param mismatch.

- [ ] **Step 3: Implement the repo changes**

In `battery-hold-repo.ts`:

(a) Widen the `mapRow` param type and map the new columns. Change the param object type to add:

```ts
  status: string; mode: string | null;
```

right after `id: number; site_id: string | number;` (replace the existing `status: string;` line), and add to the same param type, after `safety_expires_at: string | Date;`:

```ts
  acknowledged_at: string | Date | null;
```

Then in the returned object, after the `status:` line add `mode`, and after `safety_expires_at:` add `acknowledged_at`:

```ts
    status: row.status as BatteryHold['status'],
    mode: (row.mode ?? 'auto') as BatteryHold['mode'],
```
```ts
    safety_expires_at: new Date(row.safety_expires_at),
    acknowledged_at: row.acknowledged_at == null ? null : new Date(row.acknowledged_at),
```

(b) Add `mode` to `createHold`:

```ts
  async createHold(params: {
    siteId: string; originalReserve: number; targetReserve: number;
    parkedSoc: number; baselineLoadW: number; safetyExpiresAt: Date;
    mode?: 'auto' | 'timer';
  }): Promise<BatteryHold> {
    const { rows } = await pool.query(`
      INSERT INTO "BatteryHold"
        (site_id, original_reserve, target_reserve, parked_soc, baseline_load_w, safety_expires_at, mode)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `, [
      params.siteId, params.originalReserve, params.targetReserve,
      params.parkedSoc, params.baselineLoadW, params.safetyExpiresAt,
      params.mode ?? 'auto',
    ]);
    return mapRow(rows[0]);
  }
```

(c) Widen `markRestored` reason and add the three new methods (place after `markRestored`):

```ts
  async markRestored(id: number, reason: 'load_ended' | 'manual' | 'safety_timeout' | 'timer_elapsed'): Promise<void> {
    await pool.query(`
      UPDATE "BatteryHold"
      SET status = 'restored', restore_reason = $2, restored_at = now()
      WHERE id = $1
    `, [id, reason]);
  }

  async markCancelled(id: number, reason: 'reserve_changed'): Promise<void> {
    await pool.query(`
      UPDATE "BatteryHold"
      SET status = 'cancelled', restore_reason = $2, restored_at = now()
      WHERE id = $1
    `, [id, reason]);
  }

  async getLatestCancelledUnacked(siteId: string): Promise<BatteryHold | null> {
    const { rows } = await pool.query(`
      SELECT * FROM "BatteryHold"
      WHERE site_id = $1 AND status = 'cancelled'
        AND restore_reason = 'reserve_changed' AND acknowledged_at IS NULL
      ORDER BY restored_at DESC NULLS LAST, created_at DESC
      LIMIT 1
    `, [siteId]);
    return rows.length ? mapRow(rows[0]) : null;
  }

  async acknowledge(id: number): Promise<void> {
    await pool.query(`UPDATE "BatteryHold" SET acknowledged_at = now() WHERE id = $1`, [id]);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/lib/battery-hold-repo.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/battery-hold-repo.ts src/lib/battery-hold-repo.test.ts
git commit -m "feat(battery-hold): repo mode, cancel, notice + acknowledge"
```

---

### Task 4: `parkBattery` — mode, duration, reserve choice

**Files:**
- Modify: `cmd/next-app/src/lib/battery-hold-service.ts`
- Modify: `cmd/next-app/src/lib/battery-hold-service.test.ts`

- [ ] **Step 1: Write the failing tests**

In `battery-hold-service.test.ts`: (a) add `markCancelled` to `fakeRepo` (it'll be needed in Task 5 too) — inside the returned object after `markRestored`:

```ts
    markRestored: vi.fn().mockResolvedValue(undefined),
    markCancelled: vi.fn().mockResolvedValue(undefined),
```

(b) The existing "parks: sends target=100 at SoC 90" test now hits the ambiguous band, so it must pass an explicit choice. Replace that test (lines 40-49) and add new ones:

```ts
  it('parks at an explicit 100 choice in the ambiguous band and records the hold', async () => {
    const repo = fakeRepo(null);
    const client = fakeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await parkBattery({ client: client as any, repo: repo as any, siteId: 's', mode: 'auto', reserveChoice: 100 });
    expect(res.status).toBe('ok');
    expect(client.setBackupReserve).toHaveBeenCalledWith('s', 100);
    const created = repo.createHold.mock.calls[0][0];
    expect(created).toMatchObject({ siteId: 's', originalReserve: 20, targetReserve: 100, parkedSoc: 90, baselineLoadW: 450, mode: 'auto' });
  });

  it('returns needs_choice in the ambiguous band when no choice is given', async () => {
    const repo = fakeRepo(null);
    const client = fakeClient(); // SoC 90 -> ambiguous
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await parkBattery({ client: client as any, repo: repo as any, siteId: 's', mode: 'auto' });
    expect(res.status).toBe('needs_choice');
    expect(client.setBackupReserve).not.toHaveBeenCalled();
    expect(repo.createHold).not.toHaveBeenCalled();
  });

  it('parks silently below the ambiguous band (no choice needed)', async () => {
    const repo = fakeRepo(null);
    const client = fakeClient({ getLiveStatus: vi.fn().mockResolvedValue({ percentage_charged: 70, load_power: 450 }) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await parkBattery({ client: client as any, repo: repo as any, siteId: 's', mode: 'auto' });
    expect(res.status).toBe('ok');
    expect(client.setBackupReserve).toHaveBeenCalledWith('s', 70);
  });

  it('timer mode sets safety_expires_at to now + durationHours', async () => {
    const repo = fakeRepo(null);
    const client = fakeClient({ getLiveStatus: vi.fn().mockResolvedValue({ percentage_charged: 70, load_power: 450 }) });
    const now = new Date('2026-05-25T00:00:00Z');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await parkBattery({ client: client as any, repo: repo as any, siteId: 's', mode: 'timer', durationHours: 4, now });
    expect(res.status).toBe('ok');
    const created = repo.createHold.mock.calls[0][0];
    expect(created.mode).toBe('timer');
    expect(created.safetyExpiresAt).toEqual(new Date('2026-05-25T04:00:00Z'));
  });
```

(c) The existing "maps a 403 to needs_reauth" test (lines 69-75) uses the default SoC of 90, which is now ambiguous — without a choice it would short-circuit to `needs_choice` and never call `setBackupReserve`. Give it a choice so it still exercises the command path. Replace that test with:

```ts
  it('maps a 403 to needs_reauth', async () => {
    const repo = fakeRepo(null);
    const client = fakeClient({ setBackupReserve: vi.fn().mockRejectedValue(new Error('Tesla API Error: 403 forbidden')) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await parkBattery({ client: client as any, repo: repo as any, siteId: 's', mode: 'auto', reserveChoice: 100 });
    expect(res.status).toBe('needs_reauth');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/lib/battery-hold-service.test.ts`
Expected: FAIL — `needs_choice` not returned; `mode`/`durationHours` not honored.

- [ ] **Step 3: Implement `parkBattery` changes**

In `battery-hold-service.ts`: change the import on line 10 to pull in `planReserve` too:

```ts
import { computeTargetReserve, planReserve } from './battery-hold-rules';
export { computeTargetReserve };
```

Extend the `ParkResult` union and `ParkDeps`, and rewrite the target/expiry logic:

```ts
export type ParkResult =
  | { status: 'ok'; hold: BatteryHold }
  | { status: 'already_active'; hold: BatteryHold }
  | { status: 'no_soc' }
  | { status: 'needs_choice'; options: [80, 100] }
  | { status: 'needs_reauth' }
  | { status: 'error'; message: string };

export interface ParkDeps {
  client: TeslaClient; repo: BatteryHoldRepo; siteId: string; now?: Date;
  mode?: 'auto' | 'timer';
  durationHours?: number;
  reserveChoice?: 80 | 100;
}

export async function parkBattery(
  { client, repo, siteId, now = new Date(), mode = 'auto', durationHours, reserveChoice }: ParkDeps,
): Promise<ParkResult> {
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

  const plan = planReserve(soc);
  let target: number;
  if (plan.ambiguous) {
    if (reserveChoice !== 80 && reserveChoice !== 100) return { status: 'needs_choice', options: plan.options! };
    target = reserveChoice;
  } else {
    target = plan.target;
  }

  const holdMs = mode === 'timer'
    ? Math.round((durationHours ?? 0) * 60 * 60 * 1000)
    : SAFETY_HOLD_MS;

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
    safetyExpiresAt: new Date(now.getTime() + holdMs),
    mode,
  });
  return { status: 'ok', hold };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/lib/battery-hold-service.test.ts`
Expected: the `parkBattery` and `computeTargetReserve` blocks PASS. (`restoreBattery` block is updated in Task 5; if it fails here, that's expected and fixed next.)

- [ ] **Step 5: Commit**

```bash
git add src/lib/battery-hold-service.ts src/lib/battery-hold-service.test.ts
git commit -m "feat(battery-hold): park accepts mode, duration and reserve choice"
```

---

### Task 5: `restoreBattery` guard (don't clobber a changed reserve)

**Files:**
- Modify: `cmd/next-app/src/lib/battery-hold-service.ts`
- Modify: `cmd/next-app/src/lib/battery-hold-service.test.ts:78-97`

- [ ] **Step 1: Write the failing tests**

Replace the `describe('restoreBattery', ...)` block (lines 78-97) with:

```ts
describe('restoreBattery', () => {
  it('restores to original_reserve when the current reserve matches the parked target', async () => {
    const repo = fakeRepo({ id: 5, original_reserve: 20, target_reserve: 100 } as BatteryHold);
    const client = fakeClient({ getEnergySiteInfo: vi.fn().mockResolvedValue({ backup_reserve_percent: 100 }) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await restoreBattery({ client: client as any, repo: repo as any, siteId: 's', reason: 'manual' });
    expect(res.status).toBe('ok');
    expect(client.setBackupReserve).toHaveBeenCalledWith('s', 20);
    expect(repo.markRestored).toHaveBeenCalledWith(5, 'manual');
  });

  it('cancels without writing when the reserve was changed outside the app', async () => {
    const repo = fakeRepo({ id: 5, original_reserve: 20, target_reserve: 100 } as BatteryHold);
    const client = fakeClient({ getEnergySiteInfo: vi.fn().mockResolvedValue({ backup_reserve_percent: 50 }) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await restoreBattery({ client: client as any, repo: repo as any, siteId: 's', reason: 'manual' });
    expect(res).toEqual({ status: 'reserve_changed', current: 50 });
    expect(client.setBackupReserve).not.toHaveBeenCalled();
    expect(repo.markCancelled).toHaveBeenCalledWith(5, 'reserve_changed');
    expect(repo.markRestored).not.toHaveBeenCalled();
  });

  it('does not mark restored if the command fails', async () => {
    const repo = fakeRepo({ id: 5, original_reserve: 20, target_reserve: 100 } as BatteryHold);
    const client = fakeClient({
      getEnergySiteInfo: vi.fn().mockResolvedValue({ backup_reserve_percent: 100 }),
      setBackupReserve: vi.fn().mockRejectedValue(new Error('Tesla API Error: 500')),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await restoreBattery({ client: client as any, repo: repo as any, siteId: 's', reason: 'load_ended' });
    expect(res.status).toBe('error');
    expect(repo.markRestored).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/lib/battery-hold-service.test.ts`
Expected: FAIL — `restoreBattery` doesn't read current reserve or return `reserve_changed`.

- [ ] **Step 3: Implement the guard**

In `battery-hold-service.ts`, replace the `RestoreResult` union, `RestoreDeps`, and `restoreBattery`:

```ts
export type RestoreResult =
  | { status: 'ok' }
  | { status: 'reserve_changed'; current: number }
  | { status: 'no_active_hold' }
  | { status: 'needs_reauth' }
  | { status: 'error'; message: string };

export interface RestoreDeps {
  client: TeslaClient; repo: BatteryHoldRepo; siteId: string;
  reason: 'load_ended' | 'manual' | 'safety_timeout' | 'timer_elapsed';
}

export async function restoreBattery({ client, repo, siteId, reason }: RestoreDeps): Promise<RestoreResult> {
  const hold = await repo.getActiveHold(siteId);
  if (!hold) return { status: 'no_active_hold' };

  // Guard: never overwrite a reserve the user changed manually mid-hold. We expect
  // the live reserve to still equal what we parked at (target_reserve); if not,
  // cancel the hold without writing so the user's setting stands.
  let current: number;
  try {
    const info = await client.getEnergySiteInfo(siteId);
    current = info.backup_reserve_percent;
  } catch (e) {
    return isAuthError(e) ? { status: 'needs_reauth' } : { status: 'error', message: errMsg(e) };
  }
  if (current !== hold.target_reserve) {
    await repo.markCancelled(hold.id, 'reserve_changed');
    return { status: 'reserve_changed', current };
  }

  try {
    await client.setBackupReserve(siteId, hold.original_reserve);
  } catch (e) {
    return isAuthError(e) ? { status: 'needs_reauth' } : { status: 'error', message: errMsg(e) };
  }
  await repo.markRestored(hold.id, reason);
  return { status: 'ok' };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/lib/battery-hold-service.test.ts`
Expected: PASS (all blocks).

- [ ] **Step 5: Commit**

```bash
git add src/lib/battery-hold-service.ts src/lib/battery-hold-service.test.ts
git commit -m "feat(battery-hold): restore guard cancels instead of clobbering a changed reserve"
```

---

### Task 6: `evaluateHold` timer branch

**Files:**
- Modify: `cmd/next-app/src/lib/battery-hold-detection.ts`
- Modify: `cmd/next-app/src/lib/battery-hold-detection.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to the `describe('evaluateHold', ...)` block in `battery-hold-detection.test.ts`:

```ts
  it('timer mode restores exactly at safety_expires_at and never runs NILM', () => {
    detectLoadsMock.mockReset();
    const h = hold({ mode: 'timer', safety_expires_at: new Date(PARK.getTime() + 4 * 60 * 60 * 1000) });
    const now = new Date(PARK.getTime() + 4 * 60 * 60 * 1000); // == expiry
    expect(evaluateHold(h, series([8000, 8000]), now)).toEqual({ restore: true, reason: 'timer_elapsed' });
    expect(detectLoadsMock).not.toHaveBeenCalled();
  });

  it('timer mode keeps holding before expiry regardless of load', () => {
    detectLoadsMock.mockReset();
    const h = hold({ mode: 'timer', safety_expires_at: new Date(PARK.getTime() + 4 * 60 * 60 * 1000) });
    const now = new Date(PARK.getTime() + 60 * 60 * 1000); // 1h in
    expect(evaluateHold(h, series([500, 500]), now)).toBeNull();
    expect(detectLoadsMock).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/lib/battery-hold-detection.test.ts`
Expected: FAIL — timer holds fall through to NILM (`detectLoads` called) instead of the time-only branch.

- [ ] **Step 3: Implement the timer branch**

In `battery-hold-detection.ts`, extend the `RestoreDecision.reason` union and add the branch at the top of `evaluateHold`:

```ts
export interface RestoreDecision {
  restore: true;
  reason: 'load_ended' | 'safety_timeout' | 'timer_elapsed';
}
```

```ts
export function evaluateHold(hold: BatteryHold, recentPower: PowerData[], now: Date): RestoreDecision | null {
  // Timer mode: a strict N-hour hold. No NILM — only the clock matters.
  if (hold.mode === 'timer') {
    return now.getTime() >= hold.safety_expires_at.getTime()
      ? { restore: true, reason: 'timer_elapsed' }
      : null;
  }

  if (now.getTime() >= hold.safety_expires_at.getTime()) {
    return { restore: true, reason: 'safety_timeout' };
  }
  // ... rest of the existing auto-mode logic unchanged ...
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/lib/battery-hold-detection.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/battery-hold-detection.ts src/lib/battery-hold-detection.test.ts
git commit -m "feat(battery-hold): timer-mode detection short-circuits NILM"
```

---

### Task 7: API route — park validation, restore mapping, dismiss, GET notice

**Files:**
- Modify: `cmd/next-app/src/app/api/site/[id]/battery-hold/route.ts`
- Modify: `cmd/next-app/src/app/api/site/[id]/battery-hold/route.test.ts`

- [ ] **Step 1: Write the failing tests**

In `route.test.ts`: (a) extend the hoisted mocks and the repo mock — replace lines 3-14 with:

```ts
const { verifyMock, parkMock, restoreMock, getActiveMock, getNoticeMock, ackMock, createClientMock } = vi.hoisted(() => ({
  verifyMock: vi.fn(), parkMock: vi.fn(), restoreMock: vi.fn(),
  getActiveMock: vi.fn(), getNoticeMock: vi.fn(), ackMock: vi.fn(), createClientMock: vi.fn(),
}));

vi.mock('@/lib/auth-checks', () => ({ verifySiteAccess: verifyMock }));
vi.mock('@/lib/battery-hold-service', () => ({
  parkBattery: parkMock, restoreBattery: restoreMock, createSiteTeslaClient: createClientMock,
}));
vi.mock('@/lib/battery-hold-repo', () => ({
  BatteryHoldRepo: class {
    getActiveHold = getActiveMock;
    getLatestCancelledUnacked = getNoticeMock;
    acknowledge = ackMock;
  },
}));
```

(b) Reset the new mocks — add to the `beforeEach` body:

```ts
    getNoticeMock.mockReset(); ackMock.mockReset();
    getNoticeMock.mockResolvedValue(null);
```

(c) Update the GET test and add new cases:

```ts
  it('GET returns the active hold and the notice', async () => {
    getActiveMock.mockResolvedValue({ id: 1 });
    getNoticeMock.mockResolvedValue({ id: 9 });
    const res = await GET(req() as never, ctx as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hold: { id: 1 }, notice: { id: 9 } });
  });

  it('POST park with invalid timer duration returns 400', async () => {
    const res = await POST(req({ action: 'park', mode: 'timer', durationHours: 0 }) as never, ctx as never);
    expect(res.status).toBe(400);
    expect(parkMock).not.toHaveBeenCalled();
  });

  it('POST park forwards mode/duration/reserveChoice to the service', async () => {
    parkMock.mockResolvedValue({ status: 'ok', hold: { id: 2 } });
    await POST(req({ action: 'park', mode: 'timer', durationHours: 4, reserveChoice: 80 }) as never, ctx as never);
    expect(parkMock).toHaveBeenCalledWith(expect.objectContaining({ mode: 'timer', durationHours: 4, reserveChoice: 80 }));
  });

  it('POST park needs_choice maps to 422 with options', async () => {
    parkMock.mockResolvedValue({ status: 'needs_choice', options: [80, 100] });
    const res = await POST(req({ action: 'park', mode: 'auto' }) as never, ctx as never);
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'needs_choice', options: [80, 100] });
  });

  it('POST restore reserve_changed maps to 200 with current', async () => {
    restoreMock.mockResolvedValue({ status: 'reserve_changed', current: 50 });
    const res = await POST(req({ action: 'restore' }) as never, ctx as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'reserve_changed', current: 50 });
  });

  it('POST dismiss acknowledges the latest notice', async () => {
    getNoticeMock.mockResolvedValue({ id: 9 });
    const res = await POST(req({ action: 'dismiss' }) as never, ctx as never);
    expect(res.status).toBe(200);
    expect(ackMock).toHaveBeenCalledWith(9);
  });
```

(The existing `POST park returns 200 ok` test sends `{ action: 'park' }` with no mode — that defaults to `auto`, no timer validation, so it still passes.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- "src/app/api/site/[id]/battery-hold/route.test.ts"`
Expected: FAIL — GET shape, validation, and new actions not implemented.

- [ ] **Step 3: Implement the route**

Replace the bodies of `GET` and `POST` in `route.ts` (keep the imports and `export const dynamic`):

```ts
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await verifySiteAccess(id))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }
  const repo = new BatteryHoldRepo();
  const [hold, notice] = await Promise.all([repo.getActiveHold(id), repo.getLatestCancelledUnacked(id)]);
  return NextResponse.json({ hold, notice });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await verifySiteAccess(id))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }

  const body = await req.json().catch(() => ({})) as {
    action?: string; mode?: string; durationHours?: unknown; reserveChoice?: unknown;
  };
  const action = body?.action;
  const repo = new BatteryHoldRepo();

  if (action === 'dismiss') {
    const notice = await repo.getLatestCancelledUnacked(id);
    if (notice) await repo.acknowledge(notice.id);
    return NextResponse.json({ status: 'ok' });
  }

  if (action !== 'park' && action !== 'restore') {
    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  }

  let mode: 'auto' | 'timer' = 'auto';
  let durationHours: number | undefined;
  let reserveChoice: 80 | 100 | undefined;
  if (action === 'park') {
    mode = body?.mode === 'timer' ? 'timer' : 'auto';
    if (mode === 'timer') {
      const h = Number(body?.durationHours);
      if (!Number.isInteger(h) || h < 1 || h > 24) {
        return NextResponse.json({ error: 'invalid_duration' }, { status: 400 });
      }
      durationHours = h;
    }
    if (body?.reserveChoice === 80 || body?.reserveChoice === 100) {
      reserveChoice = body.reserveChoice;
    }
  }

  const client = await createSiteTeslaClient(id);
  if (!client) {
    return NextResponse.json({ error: 'needs_reauth' }, { status: 409 });
  }

  const result = action === 'park'
    ? await parkBattery({ client, repo, siteId: id, mode, durationHours, reserveChoice })
    : await restoreBattery({ client, repo, siteId: id, reason: 'manual' });

  switch (result.status) {
    case 'ok':
    case 'already_active':
      return NextResponse.json({ status: result.status, hold: 'hold' in result ? result.hold : null });
    case 'reserve_changed':
      return NextResponse.json({ status: 'reserve_changed', current: result.current });
    case 'needs_choice':
      return NextResponse.json({ error: 'needs_choice', options: result.options }, { status: 422 });
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

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- "src/app/api/site/[id]/battery-hold/route.test.ts"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/site/[id]/battery-hold/route.ts" "src/app/api/site/[id]/battery-hold/route.test.ts"
git commit -m "feat(battery-hold): route park validation, restore mapping, dismiss + GET notice"
```

---

### Task 8: Cron — timer-mode short-circuit

**Files:**
- Modify: `cmd/next-app/src/app/api/cron/restore-reserve/route.ts`
- Modify: `cmd/next-app/src/app/api/cron/restore-reserve/route.test.ts`

- [ ] **Step 1: Write the failing test**

Append a test inside `describe('restore-reserve cron', ...)` in the cron `route.test.ts`:

```ts
  it('timer-mode holds skip the data refresh and NILM fetch', async () => {
    getAllMock.mockResolvedValue([{ id: 2, site_id: 's2', mode: 'timer', created_at: new Date(), safety_expires_at: new Date() }]);
    evalMock.mockReturnValue({ restore: true, reason: 'timer_elapsed' });
    const res = await GET(req('Bearer secret') as never);
    expect(res.status).toBe(200);
    expect(refreshMock).not.toHaveBeenCalled();
    expect(rawMock).not.toHaveBeenCalled();
    expect(restoreMock).toHaveBeenCalledWith(expect.objectContaining({ siteId: 's2', reason: 'timer_elapsed' }));
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/app/api/cron/restore-reserve/route.test.ts`
Expected: FAIL — the cron always calls `refreshTodayData`/`getRawEnergyData`.

- [ ] **Step 3: Implement the short-circuit**

In the cron `route.ts`, replace the body of the `for (const hold of holds)` try-block (the part that computes `decision`) so timer holds skip the data path:

```ts
    try {
      let decision;
      if (hold.mode === 'timer') {
        decision = evaluateHold(hold, [], now); // pure clock check; no samples needed
      } else {
        await refreshTodayData(hold.site_id);
        const start = new Date(hold.created_at.getTime() - LOOKBACK_MS);
        const rows = await energyRepo.getRawEnergyData(hold.site_id, start, now);
        decision = evaluateHold(hold, adaptTeslaData(rows), now);
      }

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
```

(`restoreBattery` already returns `reserve_changed` when the guard fires; `r.status` records it in the results log — no extra handling needed.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/app/api/cron/restore-reserve/route.test.ts`
Expected: PASS (existing auto-mode tests still pass; the new timer test passes).

- [ ] **Step 5: Commit**

```bash
git add src/app/api/cron/restore-reserve/route.ts src/app/api/cron/restore-reserve/route.test.ts
git commit -m "feat(battery-hold): cron skips data refresh for timer-mode holds"
```

---

### Task 9: Format helpers (reserve text + guard notice copy)

**Files:**
- Modify: `cmd/next-app/src/components/site/live/battery-hold-format.ts`
- Modify: `cmd/next-app/src/components/site/live/battery-hold-format.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `battery-hold-format.test.ts`:

```ts
import { holdReserveText, guardNoticeText } from './battery-hold-format';

describe('holdReserveText', () => {
  it('labels 100 as max and others as a plain percent', () => {
    expect(holdReserveText(100)).toBe('100% (max)');
    expect(holdReserveText(80)).toBe('80%');
    expect(holdReserveText(67)).toBe('67%');
  });
});

describe('guardNoticeText', () => {
  it('explains the hold was cancelled and the reserve left as-is', () => {
    expect(guardNoticeText(50)).toBe('Hold cancelled — your reserve is set to 50% (changed outside the app), so we left it as-is.');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/components/site/live/battery-hold-format.test.ts`
Expected: FAIL — `holdReserveText`/`guardNoticeText` not exported.

- [ ] **Step 3: Implement the helpers**

Append to `battery-hold-format.ts`:

```ts
/** "100% (max)" for a full hold, otherwise a plain percent. */
export function holdReserveText(target: number): string {
  return target === 100 ? '100% (max)' : `${target}%`;
}

/** Copy for the dismissible notice when the restore guard left a changed reserve as-is. */
export function guardNoticeText(current: number): string {
  return `Hold cancelled — your reserve is set to ${current}% (changed outside the app), so we left it as-is.`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/components/site/live/battery-hold-format.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/site/live/battery-hold-format.ts src/components/site/live/battery-hold-format.test.ts
git commit -m "feat(battery-hold): reserve label + guard notice copy helpers"
```

---

### Task 10: `ConfirmHoldModal`

**Files:**
- Create: `cmd/next-app/src/components/site/live/ConfirmHoldModal.tsx`
- Create: `cmd/next-app/src/components/site/live/ConfirmHoldModal.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `ConfirmHoldModal.test.tsx` (static render of initial state, matching the repo's `renderToStaticMarkup` pattern):

```tsx
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ConfirmHoldModal } from './ConfirmHoldModal';
import { planReserve } from '@/lib/battery-hold-rules';

const noop = () => {};

describe('ConfirmHoldModal', () => {
  it('shows the 80-vs-100 reserve choice only when the plan is ambiguous', () => {
    const html = renderToStaticMarkup(
      <ConfirmHoldModal soc={90} plan={planReserve(90)} onConfirm={noop} onClose={noop} />,
    );
    expect(html).toContain('80%');
    expect(html).toContain('100%');
    expect(html).toMatch(/Reserve/i);
  });

  it('hides the reserve choice and states the target when unambiguous', () => {
    const html = renderToStaticMarkup(
      <ConfirmHoldModal soc={70} plan={planReserve(70)} onConfirm={noop} onClose={noop} />,
    );
    expect(html).not.toMatch(/Reserve/i);
    expect(html).toContain('70%');
  });

  it('offers auto-detect and fixed-duration options', () => {
    const html = renderToStaticMarkup(
      <ConfirmHoldModal soc={70} plan={planReserve(70)} onConfirm={noop} onClose={noop} />,
    );
    expect(html).toMatch(/Auto-detect/i);
    expect(html).toMatch(/Fixed/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/components/site/live/ConfirmHoldModal.test.tsx`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the modal**

Create `ConfirmHoldModal.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import type { ReservePlan } from '@/lib/battery-hold-rules';
import { holdReserveText } from './battery-hold-format';

export interface HoldChoice {
  mode: 'auto' | 'timer';
  durationHours?: number;
  reserveChoice?: 80 | 100;
}

interface Props {
  soc: number;
  plan: ReservePlan;
  busy?: boolean;
  onConfirm: (choice: HoldChoice) => void;
  onClose: () => void;
}

const DURATION_CHIPS = [2, 4, 6, 8] as const;

export function ConfirmHoldModal({ soc, plan, busy = false, onConfirm, onClose }: Props) {
  const [reserveChoice, setReserveChoice] = useState<80 | 100>(plan.options ? 100 : (plan.target as 80 | 100));
  const [mode, setMode] = useState<'auto' | 'timer'>('auto');
  const [hours, setHours] = useState<number>(4);

  const effectiveTarget = plan.ambiguous ? reserveChoice : plan.target;

  function confirm() {
    onConfirm({
      mode,
      durationHours: mode === 'timer' ? hours : undefined,
      reserveChoice: plan.ambiguous ? reserveChoice : undefined,
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-2xl p-6 w-full max-w-md">
        <div className="flex justify-between items-center mb-3">
          <h3 className="text-lg font-bold text-gray-900 dark:text-white">Hold battery for charging</h3>
          <button onClick={onClose} aria-label="Close" className="text-gray-500 hover:text-gray-900 dark:hover:text-white text-2xl leading-none">&times;</button>
        </div>

        <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
          Battery at {Math.floor(soc)}%. While held, the Powerwall draws the load from solar/grid instead of discharging.
        </p>

        {plan.ambiguous && (
          <fieldset className="mb-4">
            <legend className="text-sm font-medium mb-1">Reserve</legend>
            <p className="text-xs text-gray-500 mb-2">
              80% lets the battery serve the load down to 80%, then holds. 100% holds completely (no discharge).
            </p>
            <div className="flex gap-2">
              {([80, 100] as const).map(v => (
                <label key={v} className={`flex-1 cursor-pointer rounded-md border px-3 py-2 text-sm text-center ${reserveChoice === v ? 'border-primary bg-primary/10 font-semibold' : 'border-gray-300 dark:border-gray-600'}`}>
                  <input type="radio" name="reserve" className="sr-only" checked={reserveChoice === v} onChange={() => setReserveChoice(v)} />
                  {holdReserveText(v)}
                </label>
              ))}
            </div>
          </fieldset>
        )}

        <fieldset className="mb-4">
          <legend className="text-sm font-medium mb-2">Duration</legend>
          <label className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm mb-2 cursor-pointer ${mode === 'auto' ? 'border-primary bg-primary/10' : 'border-gray-300 dark:border-gray-600'}`}>
            <input type="radio" name="mode" checked={mode === 'auto'} onChange={() => setMode('auto')} />
            Auto-detect (restores when charging ends)
          </label>
          <label className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm cursor-pointer ${mode === 'timer' ? 'border-primary bg-primary/10' : 'border-gray-300 dark:border-gray-600'}`}>
            <input type="radio" name="mode" checked={mode === 'timer'} onChange={() => setMode('timer')} />
            Fixed duration
          </label>

          {mode === 'timer' && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {DURATION_CHIPS.map(h => (
                <button
                  key={h}
                  type="button"
                  onClick={() => setHours(h)}
                  className={`rounded-full border px-3 py-1 text-sm ${hours === h ? 'border-primary bg-primary/10 font-semibold' : 'border-gray-300 dark:border-gray-600'}`}
                >
                  {h}h
                </button>
              ))}
              <label className="flex items-center gap-1 text-sm">
                <span className="text-gray-500">custom</span>
                <input
                  type="number"
                  min={1}
                  max={24}
                  value={hours}
                  onChange={e => setHours(Math.max(1, Math.min(24, Number(e.target.value) || 1)))}
                  className="w-16 rounded-md border border-gray-300 dark:border-gray-600 bg-transparent px-2 py-1"
                />
                <span className="text-gray-500">h</span>
              </label>
            </div>
          )}
        </fieldset>

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={confirm} disabled={busy}>
            {busy ? 'Holding…' : `Hold at ${holdReserveText(effectiveTarget)}`}
          </Button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/components/site/live/ConfirmHoldModal.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/site/live/ConfirmHoldModal.tsx src/components/site/live/ConfirmHoldModal.test.tsx
git commit -m "feat(battery-hold): ConfirmHoldModal with reserve + duration choices"
```

---

### Task 11: Card wiring, restore confirm, guard notice, page plumbing

**Files:**
- Modify: `cmd/next-app/src/components/site/live/BatteryHoldCard.tsx`
- Modify: `cmd/next-app/src/components/site/live/LiveDetailView.tsx:33,89-94`
- Modify: `cmd/next-app/src/app/site/[id]/live/page.tsx:110-117,160-164`

> This task is UI wiring; it has no unit test (the existing `BatteryHoldCard` has none, and there is no testing-library for click flows). The testable pieces — `planReserve`, the service, the route, and the format helpers — are covered by Tasks 2–9. Verify by build + lint at the end.

- [ ] **Step 1: Rewrite `BatteryHoldCard.tsx`**

```tsx
'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import Link from 'next/link';
import { SectionCard } from '@/components/ui/SectionCard';
import { Button } from '@/components/ui/Button';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/Alert';
import { planReserve } from '@/lib/battery-hold-rules';
import { holdButtonLabel, holdReserveText, guardNoticeText } from './battery-hold-format';
import { ConfirmHoldModal, type HoldChoice } from './ConfirmHoldModal';

interface ActiveHold {
  mode: 'auto' | 'timer';
  target_reserve: number;
  original_reserve: number;
  created_at: string;
  safety_expires_at: string;
}

interface Notice {
  current: number;
}

interface Props {
  siteId: string;
  soc: number | null;
  hasTariff: boolean;
  initialHold: ActiveHold | null;
  initialNotice: Notice | null;
}

export function BatteryHoldCard({ siteId, soc, hasTariff, initialHold, initialNotice }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsReauth, setNeedsReauth] = useState(false);
  const [showHoldModal, setShowHoldModal] = useState(false);
  const [showRestoreConfirm, setShowRestoreConfirm] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(initialNotice);

  async function post(payload: Record<string, unknown>): Promise<{ ok: boolean; body: Record<string, unknown> }> {
    const res = await fetch(`/api/site/${siteId}/battery-hold`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 409 && body?.error === 'needs_reauth') { setNeedsReauth(true); return { ok: false, body }; }
    if (!res.ok) { setError('Something went wrong. Try again.'); return { ok: false, body }; }
    return { ok: true, body };
  }

  async function park(choice: HoldChoice) {
    setBusy(true); setError(null); setNeedsReauth(false);
    try {
      const { ok } = await post({ action: 'park', ...choice });
      if (ok) { setShowHoldModal(false); router.refresh(); }
    } catch { setError('Network error. Try again.'); } finally { setBusy(false); }
  }

  async function restore() {
    setBusy(true); setError(null); setNeedsReauth(false);
    try {
      const { ok, body } = await post({ action: 'restore' });
      if (ok) {
        setShowRestoreConfirm(false);
        if (body?.status === 'reserve_changed') setNotice({ current: Number(body.current) });
        router.refresh();
      }
    } catch { setError('Network error. Try again.'); } finally { setBusy(false); }
  }

  async function dismissNotice() {
    setNotice(null);
    try { await post({ action: 'dismiss' }); router.refresh(); } catch { /* notice already hidden */ }
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
    const restores = initialHold.mode === 'timer'
      ? `restores at ${new Date(initialHold.safety_expires_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
      : 'auto-restores when charging ends, or after the safety window';
    body = (
      <div className="space-y-3">
        <p className="text-sm">
          Holding at <strong>{holdReserveText(initialHold.target_reserve)}</strong>. It {restores} (to {initialHold.original_reserve}%).
        </p>
        <Button variant="outline" disabled={busy} onClick={() => setShowRestoreConfirm(true)}>Restore now</Button>
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
        <Button disabled={busy} onClick={() => setShowHoldModal(true)}>{holdButtonLabel(soc)}</Button>
      </div>
    );
  }

  return (
    <SectionCard title="Hold battery for charging" density="compact">
      {notice && (
        <Alert variant="warning" className="mb-3">
          <AlertDescription>
            {guardNoticeText(notice.current)}{' '}
            <button onClick={dismissNotice} className="underline">Dismiss</button>
          </AlertDescription>
        </Alert>
      )}
      {body}
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      <p className="mt-3 text-[11px] text-gray-400 leading-normal italic">
        Note: The official Tesla app caches settings aggressively. You may need to force-restart it to see updated reserve levels.
      </p>

      {showHoldModal && soc !== null && (
        <ConfirmHoldModal
          soc={soc}
          plan={planReserve(soc)}
          busy={busy}
          onConfirm={park}
          onClose={() => setShowHoldModal(false)}
        />
      )}

      {showRestoreConfirm && initialHold && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-2xl p-6 w-full max-w-sm">
            <h3 className="text-lg font-bold mb-3">Restore reserve?</h3>
            <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
              This ends the hold and sets the backup reserve back to {initialHold.original_reserve}%.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" disabled={busy} onClick={() => setShowRestoreConfirm(false)}>Cancel</Button>
              <Button disabled={busy} onClick={restore}>{busy ? 'Restoring…' : 'Restore'}</Button>
            </div>
          </div>
        </div>
      )}
    </SectionCard>
  );
}
```

- [ ] **Step 2: Extend the `LiveDetailView` props**

In `LiveDetailView.tsx`, replace the `batteryHold` prop type (line 33) and add a notice prop:

```ts
    batteryHold: { mode: 'auto' | 'timer'; target_reserve: number; original_reserve: number; created_at: string; safety_expires_at: string } | null;
    batteryNotice: { current: number } | null;
```

Add `batteryNotice` to the destructured props (near line 45, after `batteryHold`):

```ts
    batteryHold,
    batteryNotice,
```

And pass it through to the card (the `<BatteryHoldCard .../>` block near line 89):

```tsx
            <BatteryHoldCard
                siteId={siteId}
                soc={batterySoC}
                hasTariff={hasTariff}
                initialHold={batteryHold}
                initialNotice={batteryNotice}
            />
```

- [ ] **Step 3: Fetch the notice and pass props in `page.tsx`**

In `page.tsx`, replace the `getActiveHold` entry in the `Promise.all` (line 116) with both lookups. Change the destructure on line 110 to add `activeNotice`, and the array's last element:

```ts
    const [{ cycle, today }, todayTotals, todayChartRows, latestEnergyData, liveStatus, activeHold, activeNotice] = await Promise.all([
        repo.getCycleAndTodayTotals(id, cycleStart, todayStart, now),
        repo.getTodayTotals(id, todayStart, now),
        repo.getBucketedEnergyData(id, todayStart, now),
        repo.getLatestEnergyData(id),
        getLiveStatus(id).catch(() => null),
        new BatteryHoldRepo().getActiveHold(id),
        new BatteryHoldRepo().getLatestCancelledUnacked(id),
    ]);
```

Then update the `batteryHold` prop mapping (lines 160-164) and add `batteryNotice`:

```tsx
                    batteryHold={activeHold ? {
                        mode: activeHold.mode,
                        target_reserve: activeHold.target_reserve,
                        original_reserve: activeHold.original_reserve,
                        created_at: activeHold.created_at.toISOString(),
                        safety_expires_at: activeHold.safety_expires_at.toISOString(),
                    } : null}
                    batteryNotice={activeNotice ? { current: activeNotice.target_reserve } : null}
```

> Note: on initial server render the notice's "current reserve" isn't re-read from Tesla, so `activeNotice.target_reserve` (the value we believe is set after a guard cancel — i.e. the user's changed value is unknown server-side) is a best-effort placeholder. The accurate `current` value is shown immediately after a *manual* restore via the POST response. This is acceptable for MVP; a future improvement could persist the observed `current` on the hold row.

- [ ] **Step 4: Verify build and lint**

Run: `npm run lint`
Expected: no errors.
Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/components/site/live/BatteryHoldCard.tsx src/components/site/live/LiveDetailView.tsx "src/app/site/[id]/live/page.tsx"
git commit -m "feat(battery-hold): two-step modal card with restore confirm + guard notice"
```

---

### Task 12: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all tests PASS.

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 3: Production build**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 4: Commit any fixups**

If steps 1–3 surfaced fixes:

```bash
git add -A
git commit -m "chore(battery-hold): verification fixups"
```

---

## Notes for the implementer

- **Persisted-notice `current` value caveat:** The accurate post-guard reserve is known only at restore time (the Tesla read in `restoreBattery`). The page-level notice uses `target_reserve` as a placeholder for `current`; the manual-restore path shows the real value via the POST response. Don't try to re-read Tesla on every live-page render to "fix" this — it would add a billable call to a hot path. Left as documented MVP behavior.
- **`site_info` read lag:** the guard compares the cached `backup_reserve_percent` to `target_reserve` with an exact integer match. All parked targets are non-clamped values, so a fresh read equals the sent value. A stale read could false-positive; accepted for MVP per the spec.
- **Migration ordering:** `20260525010000_…` sorts after the existing `20260525000000_add_battery_hold.sql`, so CI runs them in order.
- **No new dependencies.** Component tests stay on `react-dom/server` static rendering; do not add testing-library.
