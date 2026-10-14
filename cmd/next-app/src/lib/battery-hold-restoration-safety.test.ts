import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { restoreBattery, type RestoreDeps } from './battery-hold-service';
import type { BatteryHold } from './db';
import { TeslaAuthError, TeslaClient } from './tesla-client';
const NOW = new Date('2026-10-14T12:00:00Z');
function setup(overrides: Partial<BatteryHold> = {}) {
  const hold = { id: 1, original_reserve: 20, target_reserve: 100, created_at: new Date(NOW.getTime() - 3600000), ...overrides } as BatteryHold;
  const repo = { getActiveHold: vi.fn().mockResolvedValue(hold), claimHold: vi.fn().mockResolvedValue(true), releaseHold: vi.fn().mockResolvedValue(undefined),
    ownsHold: vi.fn().mockResolvedValue(true), recordRestoreAttempt: vi.fn().mockResolvedValue(true), clearRestoreAttempt: vi.fn().mockResolvedValue(true),
    markRestored: vi.fn().mockResolvedValue(true), markCancelled: vi.fn().mockResolvedValue(true) };
  const client = { getEnergySiteInfo: vi.fn().mockResolvedValue({ backup_reserve_percent: 100 }), setBackupReserve: vi.fn().mockResolvedValue({ Code: 200 }) };
  const deps: RestoreDeps = { client: client as unknown as RestoreDeps['client'], repo: repo as unknown as RestoreDeps['repo'], siteId: 's', reason: 'manual' };
  return { hold, repo, client, deps };
}
describe('hold identity and uncertain restoration', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  it.each([401, 403])('allows an immediate stop retry after a definitive %s rejection and reauthentication', async status => {
    const { deps, repo, hold } = setup();
    repo.recordRestoreAttempt.mockImplementation(async () => { hold.restore_attempted_at = new Date(); return true; });
    repo.clearRestoreAttempt.mockImplementation(async () => { hold.restore_attempted_at = null; return true; });
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('Unauthorized', { status }))
      .mockResolvedValueOnce(Response.json({ response: { code: 201 } }));
    expect((await restoreBattery({ ...deps, client: new TeslaClient('expired') })).status).toBe('needs_reauth');
    expect(hold.restore_attempted_at).toBeNull();
    expect((await restoreBattery({ ...deps, client: new TeslaClient('reauthenticated') })).status).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('preserves the marker if clearing a rejected attempt fails', async () => {
    const { deps, client, repo } = setup();
    client.setBackupReserve.mockRejectedValue(new TeslaAuthError('Rejected', 401));
    repo.clearRestoreAttempt.mockRejectedValue(new Error('Database unavailable'));
    expect((await restoreBattery(deps)).status).toBe('needs_reauth');
    expect(repo.clearRestoreAttempt).toHaveBeenCalled();
    expect(repo.markRestored).not.toHaveBeenCalled();
  });
  it('a monitor snapshot cannot restore a replacement hold', async () => {
    const { deps, client } = setup({ id: 2 });
    expect((await restoreBattery({ ...deps, expectedHoldId: 1, leaseOwner: crypto.randomUUID() })).status).toBe('no_active_hold');
    expect(client.setBackupReserve).not.toHaveBeenCalled();
  });
  it('manual stop cannot duplicate a restore owned by another instance', async () => {
    const { deps, client, repo } = setup(); repo.claimHold.mockResolvedValue(false);
    expect((await restoreBattery(deps)).status).toBe('error'); expect(client.setBackupReserve).not.toHaveBeenCalled();
  });
  it('records the attempt before a command whose completion is uncertain', async () => {
    const { deps, repo, client } = setup(); client.setBackupReserve.mockRejectedValue(new Error('transport timeout'));
    expect((await restoreBattery(deps)).status).toBe('error');
    expect(repo.recordRestoreAttempt.mock.invocationCallOrder[0]).toBeLessThan(client.setBackupReserve.mock.invocationCallOrder[0]);
    expect(repo.markRestored).not.toHaveBeenCalled();
    expect(repo.clearRestoreAttempt).not.toHaveBeenCalled();
  });
  it('reconciles an applied uncertain command without sending it again', async () => {
    const { deps, client, repo } = setup({ restore_attempted_at: new Date(NOW.getTime() - 60000) });
    client.getEnergySiteInfo.mockResolvedValue({ backup_reserve_percent: 20 });
    expect((await restoreBattery(deps)).status).toBe('ok');
    expect(client.setBackupReserve).not.toHaveBeenCalled(); expect(repo.markRestored).toHaveBeenCalled();
  });
  it('does not immediately resend an uncertain write when Tesla still reports the hold target', async () => {
    const { deps, client } = setup({ restore_attempted_at: new Date(NOW.getTime() - 60000) });
    expect((await restoreBattery(deps)).status).toBe('error'); expect(client.setBackupReserve).not.toHaveBeenCalled();
  });
  it('rechecks reserve changes even for a manual retry of an uncertain write', async () => {
    const { deps, client, repo } = setup({ restore_attempted_at: new Date(NOW.getTime() - 60000) });
    client.getEnergySiteInfo.mockResolvedValue({ backup_reserve_percent: 50 });
    expect((await restoreBattery(deps)).status).toBe('reserve_changed');
    expect(client.setBackupReserve).not.toHaveBeenCalled(); expect(repo.markCancelled).toHaveBeenCalled();
  });
  it('allows a guarded retry after a full poll interval', async () => {
    const { deps, client } = setup({ restore_attempted_at: new Date(NOW.getTime() - 15 * 60000) });
    expect((await restoreBattery(deps)).status).toBe('ok'); expect(client.setBackupReserve).toHaveBeenCalledTimes(1);
  });
  it('does not report restoration when ownership was lost at completion', async () => {
    const { deps, repo } = setup(); repo.markRestored.mockResolvedValue(false);
    expect((await restoreBattery(deps)).status).toBe('error');
  });
  it('a late command resolution after timeout never completes the lifecycle', async () => {
    const { deps, client, repo } = setup(); let finish: (() => void) | undefined;
    client.setBackupReserve.mockImplementation(() => new Promise(resolve => { finish = () => resolve({ Code: 200 }); }));
    const pending = restoreBattery(deps);
    await vi.advanceTimersByTimeAsync(10000);
    expect((await pending).status).toBe('error'); finish?.(); await vi.runAllTimersAsync();
    expect(repo.markRestored).not.toHaveBeenCalled();
  });
});
