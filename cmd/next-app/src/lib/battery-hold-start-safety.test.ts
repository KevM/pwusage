import { describe, expect, it, vi } from 'vitest';
import { parkBattery, type ParkDeps } from './battery-hold-service';
import type { BatteryHold } from './db';

const now = new Date('2026-10-02T20:00:00Z');
function setup(reserve: unknown, restoredSecondsAgo: number | null = null) {
  const previous = restoredSecondsAgo === null ? null : {
    id: 1, site_id: 'home', status: 'restored', original_reserve: 20, target_reserve: 100,
    restored_at: new Date(now.getTime() - restoredSecondsAgo * 1000),
  } as BatteryHold;
  const client = {
    getLiveStatus: vi.fn().mockResolvedValue({ percentage_charged: 90, load_power: 450 }),
    getEnergySiteInfo: vi.fn().mockResolvedValue({ backup_reserve_percent: reserve }),
    setBackupReserve: vi.fn().mockResolvedValue({ Code: 200 }),
  };
  const repo = {
    getActiveHold: vi.fn().mockResolvedValue(null),
    getLatestRestoredHold: vi.fn().mockResolvedValue(previous),
    createHold: vi.fn().mockResolvedValue({ id: 2 }),
  };
  const deps: ParkDeps = { client: client as unknown as ParkDeps['client'], repo: repo as unknown as ParkDeps['repo'], siteId: 'home', now, reserveChoice: 100 };
  return { client, repo, deps };
}

describe('battery hold start safety', () => {
  it('waits when Tesla still reports a just-stopped hold target as the original reserve', async () => {
    const { deps, client, repo } = setup(100, 59);
    expect(await parkBattery(deps)).toEqual({ status: 'reserve_sync_pending' });
    expect(client.setBackupReserve).not.toHaveBeenCalled();
    expect(repo.createHold).not.toHaveBeenCalled();
  });
  it('starts normally once Tesla reports the restored reserve', async () => {
    const { deps, repo } = setup(20, 30);
    expect((await parkBattery(deps)).status).toBe('ok');
    expect(repo.createHold).toHaveBeenCalledWith(expect.objectContaining({ originalReserve: 20 }));
  });
  it('does not permanently reject a deliberate reserve change matching an older target', async () => {
    const { deps } = setup(100, 60);
    expect((await parkBattery(deps)).status).toBe('ok');
  });
  it('accepts a different manually selected reserve after the stop', async () => {
    const { deps, repo } = setup(30, 30);
    expect((await parkBattery(deps)).status).toBe('ok');
    expect(repo.createHold).toHaveBeenCalledWith(expect.objectContaining({ originalReserve: 30 }));
  });
  it.each([undefined, null, '20', -1, 101, 20.5, NaN, Infinity])('never changes the reserve when the original reading is invalid (%s)', async reserve => {
    const { deps, client, repo } = setup(reserve);
    expect((await parkBattery(deps)).status).toBe('error');
    expect(client.setBackupReserve).not.toHaveBeenCalled();
    expect(repo.createHold).not.toHaveBeenCalled();
  });
});
