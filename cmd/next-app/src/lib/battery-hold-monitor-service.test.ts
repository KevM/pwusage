import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BatteryHold } from './db';
const mocks = vi.hoisted(() => ({ claim: vi.fn(), release: vi.fn(), record: vi.fn(), raw: vi.fn(), refresh: vi.fn(), client: vi.fn(), restore: vi.fn() }));
vi.mock('./battery-hold-repo', () => ({ BatteryHoldRepo: class { claimHold = mocks.claim; releaseHold = mocks.release; recordMonitoring = mocks.record; } }));
vi.mock('./energy-repo', () => ({ EnergyRepo: class { getRawEnergyData = mocks.raw; } }));
vi.mock('./today-refresh', () => ({ refreshTodayData: mocks.refresh }));
vi.mock('./battery-hold-service', () => ({ createSiteTeslaClient: mocks.client, restoreBattery: mocks.restore }));
vi.mock('./nilm/tesla-adapter', () => ({ adaptTeslaData: (x: unknown) => x }));
import { monitorBatteryHolds } from './battery-hold-monitor-service';
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
  });
  afterEach(() => vi.useRealTimers());
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
});
