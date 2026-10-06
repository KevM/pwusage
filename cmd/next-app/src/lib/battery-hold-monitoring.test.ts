import { describe, expect, it } from 'vitest';
import { summarizeHoldMonitoring } from './battery-hold-monitoring';
import type { BatteryHold } from './db';
const start = new Date('2026-10-02T10:00:00Z');
const hold: BatteryHold = {
  id: 1, site_id: 'home', status: 'active', mode: 'auto', original_reserve: 20,
  target_reserve: 100, parked_soc: 80, baseline_load_w: 500, created_at: start,
  safety_expires_at: new Date('2026-10-02T18:00:00Z'), restored_at: null,
  restore_reason: null, acknowledged_at: null, cancelled_observed_reserve: null,
};
const point = (minutes: number, watts: number) => ({ timestamp: new Date(start.getTime() + minutes * 60000).toISOString(), powerWatts: watts });
const now = new Date('2026-10-02T10:16:00Z');
describe('battery hold monitoring', () => {
  it('reports estimated excess power and the next quarter-hour check', () => {
    expect(summarizeHoldMonitoring(hold, [point(0, 500), point(15, 9500)], now, null)).toMatchObject({ phase: 'load_running', estimated_load_w: 9000, checked_at: now.toISOString(), next_check_at: '2026-10-02T10:30:00.000Z' });
  });
  it('distinguishes a return to baseline from a confirmed restoration', () => {
    const samples = [point(5, 9500), point(15, 550)];
    expect(summarizeHoldMonitoring(hold, samples, now, null).phase).toBe('confirming_end');
    expect(summarizeHoldMonitoring(hold, samples, now, { restore: true, reason: 'load_ended' }).phase).toBe('restoring');
  });
  it('never treats missing or old readings as a running load', () => {
    expect(summarizeHoldMonitoring(hold, [], now, null).phase).toBe('waiting_for_data');
    const stale = summarizeHoldMonitoring(hold, [point(0, 9500)], new Date('2026-10-02T10:45:00Z'), null);
    expect(stale.phase).toBe('waiting_for_data');
    expect(stale.estimated_load_w).toBeNull();
    expect(stale.sampled_at).toBe(start.toISOString());
  });
  it('reports watching when no rise was detected and timer for fixed holds', () => {
    expect(summarizeHoldMonitoring(hold, [point(15, 500)], now, null).phase).toBe('watching');
    expect(summarizeHoldMonitoring({ ...hold, mode: 'timer' }, [], now, null).phase).toBe('timer');
  });
});
