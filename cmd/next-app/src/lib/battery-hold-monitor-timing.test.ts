import { afterEach, expect, it, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import type { BatteryHold } from './db';
const state = vi.hoisted(() => ({ active: 0, peak: 0, attempted: new Set<number>() }));
vi.mock('./battery-hold-repo', () => ({ BatteryHoldRepo: class {
  async claimHold(id: number) { state.active++; state.peak = Math.max(state.peak, state.active); state.attempted.add(id); return true; }
  async releaseHold() { state.active--; }
  async recordMonitoring() {}
} }));
vi.mock('./energy-repo', () => ({ EnergyRepo: class {} }));
vi.mock('./battery-hold-activity-repo', () => ({ reconcileBatteryHoldActivities: async () => null }));
vi.mock('./today-refresh', () => ({ refreshTodayData: async () => new Promise(() => {}) }));
vi.mock('./battery-hold-service', () => ({
  createSiteTeslaClient: async () => ({}),
  restoreBattery: async () => new Promise(() => {}),
}));
import { monitorBatteryHolds } from './battery-hold-monitor-service';
const realtime = process.env.BATTERY_HOLD_TIMING_REALTIME === '1';
afterEach(() => vi.useRealTimers());
it('times ten hung sites, including timer and expired Auto restoration attempts', async () => {
  if (!realtime) vi.useFakeTimers();
  state.active = 0; state.peak = 0; state.attempted.clear();
  const now = new Date();
  const holds = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, site_id: String(i + 1), mode: i % 2 === 0 ? 'timer' : 'auto',
    status: 'active', original_reserve: 20, target_reserve: 100, baseline_load_w: 500,
    created_at: new Date(now.getTime() - 3600000), safety_expires_at: i === 9 ? new Date(now.getTime() + 3600000) : now,
  } as BatteryHold));
  // Future timer holds need no I/O and release immediately; Auto telemetry and
  // elapsed deadline restores deliberately never settle, modeling worst-case I/O.
  const pending = monitorBatteryHolds(holds);
  if (!realtime) await vi.runAllTimersAsync();
  const result = await pending;
  const metrics = { harness: realtime ? 'wall-clock' : 'simulated', eligible: result.eligible, attempted: result.attempted,
    failed: result.failed, completed: result.completed, runtimeMs: result.runtimeMs, peakWorkers: state.peak };
  console.log(JSON.stringify(metrics));
  if (realtime) await writeFile('/tmp/battery-hold-monitor-timing.json', JSON.stringify(metrics, null, 2));
  expect(state.attempted.size).toBe(10); expect(state.peak).toBe(3); expect(state.active).toBe(0);
  expect(result.runtimeMs).toBeLessThan(60000); expect(result.runtimeMs).toBeLessThanOrEqual(120000);
}, 120000);
