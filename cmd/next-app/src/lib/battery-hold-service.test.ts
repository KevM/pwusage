import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeTargetReserve, parkBattery, restoreBattery } from './battery-hold-service';
import type { BatteryHold } from './db';

const activity = vi.hoisted(() => ({ reconcile: vi.fn() }));
vi.mock('./battery-hold-activity-repo', () => ({ reconcileBatteryHoldActivities: activity.reconcile }));

function fakeRepo(active: BatteryHold | null) {
  return {
    getActiveHold: vi.fn().mockResolvedValue(active),
    claimHold: vi.fn().mockResolvedValue(true),
    releaseHold: vi.fn().mockResolvedValue(undefined),
    ownsHold: vi.fn().mockResolvedValue(true),
    recordRestoreAttempt: vi.fn().mockResolvedValue(true),
    getLatestRestoredHold: vi.fn().mockResolvedValue(null),
    createHold: vi.fn(async (p) => ({
      id: 1, site_id: p.siteId, status: 'active',
      original_reserve: p.originalReserve, target_reserve: p.targetReserve,
      parked_soc: p.parkedSoc, baseline_load_w: p.baselineLoadW,
      restore_reason: null, created_at: new Date(), restored_at: null,
      safety_expires_at: p.safetyExpiresAt,
      mode: p.mode ?? 'auto',
    } as BatteryHold)),
    markRestored: vi.fn().mockResolvedValue(true),
    markCancelled: vi.fn().mockResolvedValue(true),
    recordMonitoring: vi.fn().mockResolvedValue(undefined),
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

  it('seeds the hold with the battery charge and home load it read, and returns the hold with them', async () => {
    const repo = fakeRepo(null);
    const client = fakeClient({ getLiveStatus: vi.fn().mockResolvedValue({ percentage_charged: 70.4, load_power: 1612, timestamp: '2026-10-02T10:00:10Z' }) });
    const now = new Date('2026-10-02T10:01:00Z');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await parkBattery({ client: client as any, repo: repo as any, siteId: 's', mode: 'auto', now });
    const monitoring = { phase: 'watching', battery_percent: 70.4, home_load_w: 1612, baseline_load_w: 1612,
      live_at: '2026-10-02T10:00:10.000Z', checked_at: now.toISOString(), next_check_at: '2026-10-02T10:15:00.000Z' };
    expect(repo.recordMonitoring).toHaveBeenCalledWith(1, expect.objectContaining(monitoring));
    expect(res).toMatchObject({ status: 'ok', hold: { id: 1, monitoring } });
  });

  it('still starts the hold when the first monitoring write fails, returning it without monitoring', async () => {
    const repo = fakeRepo(null);
    repo.recordMonitoring.mockRejectedValue(new Error('db down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = fakeClient({ getLiveStatus: vi.fn().mockResolvedValue({ percentage_charged: 70, load_power: 450 }) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await parkBattery({ client: client as any, repo: repo as any, siteId: 's', mode: 'timer', durationHours: 2 });
    expect(res.status).toBe('ok');
    expect(res.status === 'ok' && res.hold.monitoring).toBeFalsy();
    expect(client.setBackupReserve).toHaveBeenCalledTimes(1);
    warn.mockRestore();
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

  it('returns error if timer mode is requested with invalid or missing durationHours', async () => {
    const repo = fakeRepo(null);
    const client = fakeClient({ getLiveStatus: vi.fn() });
    
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res1 = await parkBattery({ client: client as any, repo: repo as any, siteId: 's', mode: 'timer', durationHours: undefined });
    expect(res1.status).toBe('error');
    expect(res1.status === 'error' ? res1.message : '').toContain('Valid duration');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res2 = await parkBattery({ client: client as any, repo: repo as any, siteId: 's', mode: 'timer', durationHours: -1 });
    expect(res2.status).toBe('error');
    expect(res2.status === 'error' ? res2.message : '').toContain('Valid duration');
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

  it('returns error when load power is unavailable or NaN', async () => {
    const repo = fakeRepo(null);
    const client = fakeClient({ getLiveStatus: vi.fn().mockResolvedValue({ percentage_charged: 90, load_power: NaN }) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await parkBattery({ client: client as any, repo: repo as any, siteId: 's' });
    expect(res).toEqual({ status: 'error', message: 'Failed to retrieve baseline load power.' });
    expect(repo.createHold).not.toHaveBeenCalled();
  });

  it('maps a 403 to needs_reauth', async () => {
    const repo = fakeRepo(null);
    const client = fakeClient({ setBackupReserve: vi.fn().mockRejectedValue(new Error('Tesla API Error: 403 forbidden')) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await parkBattery({ client: client as any, repo: repo as any, siteId: 's', reserveChoice: 100 });
    expect(res.status).toBe('needs_reauth');
  });

  it('attempts compensating restore back to original reserve when database write fails', async () => {
    const repo = fakeRepo(null);
    repo.createHold = vi.fn().mockRejectedValue(new Error('DB Connection Timeout'));
    
    const client = fakeClient({
      getEnergySiteInfo: vi.fn().mockResolvedValue({ backup_reserve_percent: 25 }),
      setBackupReserve: vi.fn().mockResolvedValue({ Code: 200, Message: 'OK' }),
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await parkBattery({ client: client as any, repo: repo as any, siteId: 's', mode: 'auto', reserveChoice: 100 });
    
    expect(res).toEqual({ status: 'error', message: 'Database error: DB Connection Timeout' });
    expect(client.setBackupReserve).toHaveBeenCalledTimes(2);
    expect(client.setBackupReserve.mock.calls[0]).toEqual(['s', 100]);
    expect(client.setBackupReserve.mock.calls[1]).toEqual(['s', 25]);
  });
});

describe('restoreBattery', () => {
  it('restores to original_reserve when the current reserve matches the parked target', async () => {
    const repo = fakeRepo({ id: 5, original_reserve: 20, target_reserve: 100, created_at: new Date() } as unknown as BatteryHold);
    const client = fakeClient({ getEnergySiteInfo: vi.fn().mockResolvedValue({ backup_reserve_percent: 100 }) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await restoreBattery({ client: client as any, repo: repo as any, siteId: 's', reason: 'manual' });
    expect(res.status).toBe('ok');
    expect(client.setBackupReserve).toHaveBeenCalledWith('s', 20);
    expect(repo.markRestored).toHaveBeenCalledWith(5, 'manual', expect.any(String));
  });

  it('cancels without writing when the reserve was changed outside the app', async () => {
    const repo = fakeRepo({
      id: 5,
      original_reserve: 20,
      target_reserve: 100,
      created_at: new Date(Date.now() - 10 * 60 * 1000),
    } as unknown as BatteryHold);
    const client = fakeClient({ getEnergySiteInfo: vi.fn().mockResolvedValue({ backup_reserve_percent: 50 }) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await restoreBattery({ client: client as any, repo: repo as any, siteId: 's', reason: 'load_ended' });
    expect(res).toEqual({ status: 'reserve_changed', current: 50 });
    expect(client.setBackupReserve).not.toHaveBeenCalled();
    expect(repo.markCancelled).toHaveBeenCalledWith(5, 'reserve_changed', 50, expect.any(String));
    expect(repo.markRestored).not.toHaveBeenCalled();
  });

  it('bypasses the guard if the restore is manual', async () => {
    const repo = fakeRepo({
      id: 5,
      original_reserve: 20,
      target_reserve: 100,
      created_at: new Date(Date.now() - 10 * 60 * 1000),
    } as unknown as BatteryHold);
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
      created_at: new Date(Date.now() - 2 * 60 * 1000),
    } as unknown as BatteryHold);
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
      created_at: new Date(Date.now() - 10 * 60 * 1000),
    } as unknown as BatteryHold);
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
    const repo = fakeRepo({ id: 5, original_reserve: 20, target_reserve: 100, created_at: new Date() } as unknown as BatteryHold);
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

describe('restoreBattery push bookkeeping', () => {
  beforeEach(() => {
    activity.reconcile.mockReset();
    activity.reconcile.mockResolvedValue(1);
  });
  afterEach(() => vi.useRealTimers());

  const activeHold = (over: Partial<BatteryHold> = {}) => ({
    id: 5, site_id: 's', original_reserve: 20, target_reserve: 100, restore_attempted_at: null,
    created_at: new Date(Date.now() - 10 * 60 * 1000), ...over,
  } as unknown as BatteryHold);

  it('reconciles the claimed hold once after a manual stop, following lease release', async () => {
    const repo = fakeRepo(activeHold());
    const client = fakeClient({ getEnergySiteInfo: vi.fn().mockResolvedValue({ backup_reserve_percent: 100 }) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await restoreBattery({ client: client as any, repo: repo as any, siteId: 's', reason: 'manual' });
    expect(res).toEqual({ status: 'ok' });
    expect(activity.reconcile).toHaveBeenCalledTimes(1);
    expect(activity.reconcile).toHaveBeenCalledWith(5);
    expect(activity.reconcile.mock.invocationCallOrder[0]).toBeGreaterThan(repo.releaseHold.mock.invocationCallOrder[0]);
  });

  it('reconciles the claimed hold after a manual stop that finds the reserve changed', async () => {
    const repo = fakeRepo(activeHold({ restore_attempted_at: new Date() }));
    const client = fakeClient({ getEnergySiteInfo: vi.fn().mockResolvedValue({ backup_reserve_percent: 50 }) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await restoreBattery({ client: client as any, repo: repo as any, siteId: 's', reason: 'manual' });
    expect(res).toEqual({ status: 'reserve_changed', current: 50 });
    expect(activity.reconcile).toHaveBeenCalledTimes(1);
    expect(activity.reconcile).toHaveBeenCalledWith(5);
  });

  it('keeps a successful restore when reconciliation resolves null', async () => {
    activity.reconcile.mockResolvedValue(null);
    const repo = fakeRepo(activeHold());
    const client = fakeClient({ getEnergySiteInfo: vi.fn().mockResolvedValue({ backup_reserve_percent: 100 }) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await restoreBattery({ client: client as any, repo: repo as any, siteId: 's', reason: 'manual' });
    expect(res).toEqual({ status: 'ok' });
    expect(client.setBackupReserve).toHaveBeenCalledTimes(1);
  });

  it('a slow reconciliation neither changes the restore outcome nor repeats the Tesla command', async () => {
    vi.useFakeTimers();
    activity.reconcile.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve(null), 5000)));
    const repo = fakeRepo(activeHold());
    const client = fakeClient({ getEnergySiteInfo: vi.fn().mockResolvedValue({ backup_reserve_percent: 100 }) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pending = restoreBattery({ client: client as any, repo: repo as any, siteId: 's', reason: 'manual' });
    await vi.advanceTimersByTimeAsync(5000);
    await expect(pending).resolves.toEqual({ status: 'ok' });
    expect(client.setBackupReserve).toHaveBeenCalledTimes(1);
  });

  it('does not reconcile when there was no hold to claim', async () => {
    const repo = fakeRepo(null);
    const client = fakeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await restoreBattery({ client: client as any, repo: repo as any, siteId: 's', reason: 'manual' });
    expect(res).toEqual({ status: 'no_active_hold' });
    expect(activity.reconcile).not.toHaveBeenCalled();
  });

  it('leaves reconciliation to the monitor for lease-owned restores', async () => {
    const repo = fakeRepo(activeHold());
    const client = fakeClient({ getEnergySiteInfo: vi.fn().mockResolvedValue({ backup_reserve_percent: 100 }) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await restoreBattery({ client: client as any, repo: repo as any, siteId: 's', reason: 'load_ended', expectedHoldId: 5, leaseOwner: 'monitor-owner' });
    expect(res).toEqual({ status: 'ok' });
    expect(activity.reconcile).not.toHaveBeenCalled();
  });
});
