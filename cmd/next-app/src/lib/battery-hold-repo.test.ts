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
