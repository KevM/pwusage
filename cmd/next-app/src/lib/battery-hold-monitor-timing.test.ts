import { afterEach, expect, it, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import type { BatteryHold } from './db';
const state = vi.hoisted(() => ({ active: 0, peak: 0, attempted: new Set<number>(), reconciles: 0, holds: [] as BatteryHold[] }));
vi.mock('./battery-hold-repo', () => ({ BatteryHoldRepo: class {
  async claimHold(id: number) { state.active++; state.peak = Math.max(state.peak, state.active); state.attempted.add(id); return true; }
  async getActiveHold(siteId: string) { return state.holds.find(hold => hold.site_id === siteId) ?? null; }
  async releaseHold() { state.active--; }
  async recordMonitoring() {}
} }));
vi.mock('./energy-repo-factory', () => ({ createEnergyRepo: () => ({}) }));
vi.mock('./site-repo', () => ({ SiteRepo: class {} }));
// The reconcile consumes its whole real budget, so the 60 s guard tracks ACTIVITY_SYNC_BUDGET_MS.
vi.mock('./battery-hold-activity-repo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./battery-hold-activity-repo')>();
  return {
    ...actual,
    reconcileBatteryHoldActivities: () => {
      state.reconciles++;
      return new Promise<null>(resolve => setTimeout(() => resolve(null), actual.ACTIVITY_SYNC_BUDGET_MS));
    },
  };
});
// The live status read is bounded on its own, so it is hung too.
vi.mock('./today-refresh', () => ({ refreshTodayData: async () => new Promise(() => {}), refreshLiveStatus: async () => new Promise(() => {}) }));
vi.mock('./battery-hold-service', () => ({
  createSiteTeslaClient: async () => ({}),
  restoreBattery: async () => new Promise(() => {}),
}));
import { monitorBatteryHolds } from './battery-hold-monitor-service';
const realtime = process.env.BATTERY_HOLD_TIMING_REALTIME === '1';
afterEach(() => vi.useRealTimers());
it('times ten hung sites, including timer and expired Auto restoration attempts', async () => {
  if (!realtime) vi.useFakeTimers();
  state.active = 0; state.peak = 0; state.reconciles = 0; state.attempted.clear();
  const now = new Date();
  const holds = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, site_id: String(i + 1), mode: i % 2 === 0 ? 'timer' : 'auto',
    status: 'active', original_reserve: 20, target_reserve: 100, baseline_load_w: 500,
    created_at: new Date(now.getTime() - 3600000), safety_expires_at: i === 9 ? new Date(now.getTime() + 3600000) : now,
  } as BatteryHold));
  state.holds = holds;
  // Future timer holds need no I/O and release immediately; Auto telemetry and
  // elapsed deadline restores deliberately never settle, modeling worst-case I/O.
  const pending = monitorBatteryHolds(holds);
  if (!realtime) await vi.runAllTimersAsync();
  const result = await pending;
  const metrics = { harness: realtime ? 'wall-clock' : 'simulated', eligible: result.eligible, attempted: result.attempted,
    failed: result.failed, completed: result.completed, runtimeMs: result.runtimeMs, peakWorkers: state.peak };
  console.log(JSON.stringify(metrics));
  if (realtime) await writeFile('/tmp/battery-hold-monitor-timing.json', JSON.stringify(metrics, null, 2));
  expect(state.attempted.size).toBe(10); expect(state.peak).toBe(3); expect(state.active).toBe(0); expect(state.reconciles).toBe(1);
  expect(result.runtimeMs).toBeLessThan(60000); expect(result.runtimeMs).toBeLessThanOrEqual(120000);
}, 120000);
