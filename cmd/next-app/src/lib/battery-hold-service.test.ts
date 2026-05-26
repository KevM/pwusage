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
      mode: p.mode ?? 'auto',
    } as BatteryHold)),
    markRestored: vi.fn().mockResolvedValue(undefined),
    markCancelled: vi.fn().mockResolvedValue(undefined),
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
  it('floors at/below 80, snaps the clamp band toward the nearest endpoint', () => {
    expect(computeTargetReserve(55.9)).toBe(55);
    expect(computeTargetReserve(80)).toBe(80);
    expect(computeTargetReserve(81)).toBe(80);
    expect(computeTargetReserve(90)).toBe(100);
    expect(computeTargetReserve(95)).toBe(100);
    expect(computeTargetReserve(100)).toBe(100);
  });
});

describe('parkBattery', () => {
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
    const res = await parkBattery({ client: client as any, repo: repo as any, siteId: 's', reserveChoice: 100 });
    expect(res.status).toBe('needs_reauth');
  });
});

describe('restoreBattery', () => {
  it('restores to original_reserve when the current reserve matches the parked target', async () => {
    const repo = fakeRepo({ id: 5, original_reserve: 20, target_reserve: 100, created_at: new Date().toISOString() } as BatteryHold);
    const client = fakeClient({ getEnergySiteInfo: vi.fn().mockResolvedValue({ backup_reserve_percent: 100 }) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await restoreBattery({ client: client as any, repo: repo as any, siteId: 's', reason: 'manual' });
    expect(res.status).toBe('ok');
    expect(client.setBackupReserve).toHaveBeenCalledWith('s', 20);
    expect(repo.markRestored).toHaveBeenCalledWith(5, 'manual');
  });

  it('cancels without writing when the reserve was changed outside the app', async () => {
    const repo = fakeRepo({
      id: 5,
      original_reserve: 20,
      target_reserve: 100,
      created_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    } as BatteryHold);
    const client = fakeClient({ getEnergySiteInfo: vi.fn().mockResolvedValue({ backup_reserve_percent: 50 }) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await restoreBattery({ client: client as any, repo: repo as any, siteId: 's', reason: 'load_ended' });
    expect(res).toEqual({ status: 'reserve_changed', current: 50 });
    expect(client.setBackupReserve).not.toHaveBeenCalled();
    expect(repo.markCancelled).toHaveBeenCalledWith(5, 'reserve_changed', 50);
    expect(repo.markRestored).not.toHaveBeenCalled();
  });

  it('bypasses the guard if the restore is manual', async () => {
    const repo = fakeRepo({
      id: 5,
      original_reserve: 20,
      target_reserve: 100,
      created_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    } as BatteryHold);
    const client = fakeClient({
      getEnergySiteInfo: vi.fn().mockResolvedValue({ backup_reserve_percent: 50 }),
      setBackupReserve: vi.fn().mockResolvedValue({}),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await restoreBattery({ client: client as any, repo: repo as any, siteId: 's', reason: 'manual' });
    expect(res.status).toBe('ok');
    expect(client.getEnergySiteInfo).not.toHaveBeenCalled();
    expect(client.setBackupReserve).toHaveBeenCalledWith('s', 20);
  });

  it('bypasses the guard if the hold is recent (under 5 minutes)', async () => {
    const repo = fakeRepo({
      id: 5,
      original_reserve: 20,
      target_reserve: 100,
      created_at: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
    } as BatteryHold);
    const client = fakeClient({
      getEnergySiteInfo: vi.fn().mockResolvedValue({ backup_reserve_percent: 50 }),
      setBackupReserve: vi.fn().mockResolvedValue({}),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await restoreBattery({ client: client as any, repo: repo as any, siteId: 's', reason: 'load_ended' });
    expect(res.status).toBe('ok');
    expect(client.getEnergySiteInfo).not.toHaveBeenCalled();
    expect(client.setBackupReserve).toHaveBeenCalledWith('s', 20);
  });

  it('bypasses the guard if the current reserve matches the original reserve (stale cache safety)', async () => {
    const repo = fakeRepo({
      id: 5,
      original_reserve: 20,
      target_reserve: 100,
      created_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    } as BatteryHold);
    const client = fakeClient({
      getEnergySiteInfo: vi.fn().mockResolvedValue({ backup_reserve_percent: 20 }),
      setBackupReserve: vi.fn().mockResolvedValue({}),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await restoreBattery({ client: client as any, repo: repo as any, siteId: 's', reason: 'load_ended' });
    expect(res.status).toBe('ok');
    expect(client.getEnergySiteInfo).toHaveBeenCalled();
    expect(client.setBackupReserve).toHaveBeenCalledWith('s', 20);
    expect(repo.markCancelled).not.toHaveBeenCalled();
  });

  it('does not mark restored if the command fails', async () => {
    const repo = fakeRepo({ id: 5, original_reserve: 20, target_reserve: 100, created_at: new Date().toISOString() } as BatteryHold);
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
