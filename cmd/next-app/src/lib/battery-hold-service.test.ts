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
