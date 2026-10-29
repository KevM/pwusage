import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BatteryHold } from './db';
const mocks = vi.hoisted(() => ({ claim: vi.fn(), release: vi.fn(), record: vi.fn(), getActive: vi.fn(), raw: vi.fn(), refresh: vi.fn(), client: vi.fn(), restore: vi.fn(), reconcile: vi.fn(), live: vi.fn(), createRepo: vi.fn(), site: vi.fn() }));
vi.mock('./battery-hold-activity-repo', () => ({ reconcileBatteryHoldActivities: mocks.reconcile }));
vi.mock('./battery-hold-repo', () => ({ BatteryHoldRepo: class { claimHold = mocks.claim; releaseHold = mocks.release; recordMonitoring = mocks.record; getActiveHold = mocks.getActive; } }));
vi.mock('./energy-repo-factory', () => ({ createEnergyRepo: mocks.createRepo }));
vi.mock('./site-repo', () => ({ SiteRepo: class { getSite = mocks.site; } }));
vi.mock('./today-refresh', () => ({ refreshTodayData: mocks.refresh, refreshLiveStatus: mocks.live }));
vi.mock('./battery-hold-service', () => ({ createSiteTeslaClient: mocks.client, restoreBattery: mocks.restore }));
vi.mock('./nilm/tesla-adapter', () => ({ adaptTeslaData: (x: unknown) => x }));
import { monitorBatteryHolds as monitor } from './battery-hold-monitor-service';
function monitorBatteryHolds(holds: BatteryHold[]) {
  mocks.getActive.mockImplementation(async (siteId: string) => holds.find(h => h.site_id === siteId) ?? null);
  return monitor(holds);
}
const NOW = new Date('2026-10-14T12:00:00Z');
function hold(id: number, overrides: Partial<BatteryHold> = {}): BatteryHold {
  return { id, site_id: String(id), status: 'active', mode: 'auto', original_reserve: 20, target_reserve: 100,
    parked_soc: 90, baseline_load_w: 500, restore_reason: null, created_at: new Date(NOW.getTime() - 3600000),
    restored_at: null, safety_expires_at: new Date(NOW.getTime() + 3600000), acknowledged_at: null,
    cancelled_observed_reserve: null, ...overrides };
}
describe('bounded hold monitoring', () => {
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(NOW); vi.resetAllMocks();
    mocks.claim.mockResolvedValue(true); mocks.release.mockResolvedValue(undefined); mocks.record.mockResolvedValue(undefined);
    mocks.raw.mockResolvedValue([]); mocks.refresh.mockResolvedValue({ status: 'persisted' });
    mocks.client.mockResolvedValue({}); mocks.restore.mockResolvedValue({ status: 'ok' });
    mocks.reconcile.mockResolvedValue(2);
    mocks.createRepo.mockReturnValue({ getRawEnergyData: mocks.raw }); mocks.site.mockResolvedValue({ id: '1', timezone: 'America/Denver' });
    mocks.live.mockResolvedValue({ status: 'error' });
  });
  afterEach(() => vi.useRealTimers());
  it('restores after the second fresh check without a detected job', async () => {
    mocks.raw.mockResolvedValue([{ timestamp: new Date(NOW.getTime() - 5 * 60000).toISOString(), powerWatts: 500 }]);
    const previous = { phase: 'watching' as const, checked_at: new Date(NOW.getTime() - 15 * 60000).toISOString(), next_check_at: NOW.toISOString(), sampled_at: new Date(NOW.getTime() - 20 * 60000).toISOString(), estimated_load_w: null, no_load_checks: 1, no_load_last_checked_at: new Date(NOW.getTime() - 15 * 60000).toISOString(), no_load_last_sample_at: new Date(NOW.getTime() - 20 * 60000).toISOString() };
    await monitorBatteryHolds([hold(1, { monitoring: previous })]);
    expect(mocks.restore).toHaveBeenCalledWith(expect.objectContaining({ reason: 'no_load_detected' }));
  });
  it('attempts ten slow sites within 120 seconds with at most three workers and a failed site', async () => {
    let active = 0; let peak = 0;
    mocks.refresh.mockImplementation(async (site: string) => {
      active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 8000)); active--;
      if (site === '1') throw new Error('unavailable');
      return { status: 'persisted' };
    });
    const pending = monitorBatteryHolds(Array.from({ length: 10 }, (_, i) => hold(i + 1)));
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result.results).toHaveLength(10); expect(mocks.refresh).toHaveBeenCalledTimes(10);
    expect(peak).toBe(3); expect(result.runtimeMs).toBeLessThanOrEqual(120000); expect(result.failed).toBe(1);
  });
  it('reads hold history through the compact-aware repo in the site timezone', async () => {
    await monitorBatteryHolds([hold(1)]);
    expect(mocks.site).toHaveBeenCalledWith('1');
    expect(mocks.createRepo).toHaveBeenCalledWith('America/Denver');
    expect(mocks.raw).toHaveBeenCalledWith('1', new Date(NOW.getTime() - 3600000 - 30 * 60000), NOW);
  });
  it('restores expired Auto and timer holds before unnecessary history', async () => {
    await monitorBatteryHolds([hold(1), hold(2, { safety_expires_at: NOW }), hold(3, { mode: 'timer', safety_expires_at: NOW })]);
    expect(mocks.refresh).toHaveBeenCalledTimes(1); expect(mocks.refresh).toHaveBeenCalledWith('1', expect.anything());
    expect(mocks.restore.mock.calls.map(([arg]) => arg.expectedHoldId)).toEqual([2, 3]);
  });
  it('rechecks deadlines after history using a fresh clock', async () => {
    mocks.refresh.mockImplementation(async () => { vi.setSystemTime(new Date(NOW.getTime() + 60000)); return { status: 'persisted' }; });
    await monitorBatteryHolds([hold(1, { safety_expires_at: new Date(NOW.getTime() + 30000) })]);
    expect(mocks.restore).toHaveBeenCalledWith(expect.objectContaining({ reason: 'safety_timeout', expectedHoldId: 1 }));
  });
  it('uses the clock when queued work starts, including a deadline that elapsed in the queue', async () => {
    mocks.restore.mockImplementation(async () => { await new Promise(resolve => setTimeout(resolve, 2000)); return { status: 'ok' }; });
    const pending = monitorBatteryHolds([hold(1, { safety_expires_at: NOW }), hold(2, { safety_expires_at: NOW }),
      hold(3, { safety_expires_at: NOW }), hold(4, { safety_expires_at: new Date(NOW.getTime() + 1000) })]);
    await vi.runAllTimersAsync(); await pending;
    expect(mocks.refresh).not.toHaveBeenCalled(); expect(mocks.restore).toHaveBeenCalledTimes(4);
  });
  it('reconciles a pending write before history even when the load deadline is still in the future', async () => {
    await monitorBatteryHolds([hold(1, { restore_attempted_at: NOW, restore_reason: 'load_ended' })]);
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.restore).toHaveBeenCalledWith(expect.objectContaining({ reason: 'load_ended', expectedHoldId: 1 }));
  });
  it('does no external work when another instance or manual action owns the hold', async () => {
    mocks.claim.mockResolvedValue(false);
    const result = await monitorBatteryHolds([hold(1)]);
    expect(result.skipped).toBe(1); expect(mocks.refresh).not.toHaveBeenCalled(); expect(mocks.restore).not.toHaveBeenCalled();
  });
  it('a hung failure-telemetry write cannot reject the run or starve queued sites', async () => {
    mocks.refresh.mockRejectedValue(new Error('upstream failed'));
    mocks.record.mockImplementation(() => new Promise(() => {}));
    const pending = monitorBatteryHolds(Array.from({ length: 10 }, (_, i) => hold(i + 1)));
    const assertion = expect(pending).resolves.toMatchObject({ attempted: 10, failed: 10 });
    await vi.runAllTimersAsync(); await assertion;
    expect(mocks.refresh).toHaveBeenCalledTimes(10);
  });
  it('reconciles activities once per run, without a hold id, after every hold is released', async () => {
    await monitorBatteryHolds([hold(1), hold(2, { safety_expires_at: NOW })]);
    expect(mocks.reconcile).toHaveBeenCalledTimes(1);
    expect(mocks.reconcile).toHaveBeenCalledWith();
    const lastRelease = Math.max(...mocks.release.mock.invocationCallOrder);
    expect(mocks.reconcile.mock.invocationCallOrder[0]).toBeGreaterThan(lastRelease);
  });
  it('reconciles once for an empty run', async () => {
    const result = await monitorBatteryHolds([]);
    expect(mocks.reconcile).toHaveBeenCalledTimes(1);
    expect(mocks.reconcile).toHaveBeenCalledWith();
    expect(result).toMatchObject({ eligible: 0, activitiesSynced: 2 });
  });
  it('reports the activity sync count in the summary', async () => {
    mocks.reconcile.mockResolvedValue(3);
    const result = await monitorBatteryHolds([hold(1)]);
    expect(result.activitiesSynced).toBe(3);
  });
  it('keeps every result and the failure count when activity reconciliation returns null', async () => {
    mocks.reconcile.mockResolvedValue(null);
    const result = await monitorBatteryHolds([hold(1, { safety_expires_at: NOW }), hold(2)]);
    expect(result.activitiesSynced).toBeNull();
    expect(result.results).toHaveLength(2);
    expect(result).toMatchObject({ failed: 0, completed: 1 });
  });
  it('aborts hung per-site I/O and still attempts every queued site', async () => {
    const aborted: string[] = [];
    mocks.refresh.mockImplementation((site: string, options: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => { aborted.push(site); reject(options.signal.reason); }, { once: true });
    }));
    const pending = monitorBatteryHolds(Array.from({ length: 10 }, (_, i) => hold(i + 1)));
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(aborted).toHaveLength(10); expect(result.failed).toBe(10); expect(result.runtimeMs).toBeLessThanOrEqual(120000);
  });
  it('reads the live status for Auto and timer holds with a short cache, and records it', async () => {
    const liveStatus = { percentage_charged: 82, load_power: 1800, timestamp: '2026-10-14T11:59:30Z' };
    mocks.live.mockResolvedValue({ status: 'refreshed', liveStatus, fetchedAt: NOW.getTime() });
    await monitorBatteryHolds([hold(1), hold(2, { mode: 'timer' })]);
    expect(mocks.live).toHaveBeenCalledTimes(2);
    expect(mocks.live).toHaveBeenCalledWith('1', expect.objectContaining({ cacheTtlMs: 120000 }));
    expect(mocks.live).toHaveBeenCalledWith('2', expect.objectContaining({ cacheTtlMs: 120000 }));
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    for (const id of [1, 2]) {
      expect(mocks.record).toHaveBeenCalledWith(id, expect.objectContaining({ battery_percent: 82, home_load_w: 1800, live_at: '2026-10-14T11:59:30.000Z' }));
    }
  });
  it('a failed, missing or old live status leaves the check history-based and successful', async () => {
    const liveStatus = { percentage_charged: 82, load_power: 1800, timestamp: '2026-10-14T11:40:00Z' };
    mocks.live.mockResolvedValueOnce({ status: 'cached', liveStatus, fetchedAt: NOW.getTime() - 3 * 60000 })
      .mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ status: 'throttled' });
    const result = await monitorBatteryHolds([hold(1), hold(2), hold(3, { mode: 'timer' })]);
    expect(result).toMatchObject({ failed: 0 });
    expect(mocks.record).toHaveBeenCalledTimes(3);
    for (const [, monitoring] of mocks.record.mock.calls) expect(monitoring).toMatchObject({ battery_percent: null, home_load_w: null });
  });
  it('a hung live status is cut off without failing the check', async () => {
    mocks.live.mockImplementation(() => new Promise(() => {}));
    const pending = monitorBatteryHolds([hold(1), hold(2, { mode: 'timer' })]);
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result).toMatchObject({ failed: 0 });
    expect(mocks.record).toHaveBeenCalledTimes(2);
  });
  it('does not read the live status for a hold being restored', async () => {
    await monitorBatteryHolds([hold(1, { safety_expires_at: NOW }), hold(2, { restore_attempted_at: NOW, restore_reason: 'load_ended' })]);
    expect(mocks.live).not.toHaveBeenCalled();
  });
});
