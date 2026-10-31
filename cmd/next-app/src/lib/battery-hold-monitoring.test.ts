import { describe, expect, it } from 'vitest';
import { seedHoldMonitoring, summarizeHoldMonitoring } from './battery-hold-monitoring';
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
  it('requires two distinct fresh checks before stopping when no job starts', () => {
    const first = summarizeHoldMonitoring(hold, [point(5, 500), point(15, 510)], now, null);
    expect(first.no_load_checks).toBe(1);
    const secondTime = new Date('2026-10-02T10:30:00Z');
    const second = summarizeHoldMonitoring({ ...hold, monitoring: first }, [point(5, 500), point(15, 510), point(30, 520)], secondTime, null);
    expect(second.no_load_checks).toBe(2);
  });
  it('does not count stale data, the same sample, or repeated checks in one interval', () => {
    const first = summarizeHoldMonitoring(hold, [point(15, 500)], now, null);
    expect(summarizeHoldMonitoring({ ...hold, monitoring: first }, [point(15, 500)], new Date('2026-10-02T10:30:00Z'), null).no_load_checks).toBe(1);
    expect(summarizeHoldMonitoring({ ...hold, monitoring: first }, [point(15, 500), point(20, 500)], new Date('2026-10-02T10:21:00Z'), null).no_load_checks).toBe(1);
    expect(summarizeHoldMonitoring({ ...hold, monitoring: first }, [point(15, 500)], new Date('2026-10-02T11:00:00Z'), null).no_load_checks).toBe(1);
  });
  it('remembers a detected job even if later history is missing', () => {
    const first = summarizeHoldMonitoring(hold, [point(15, 500)], now, null);
    const running = summarizeHoldMonitoring({ ...hold, monitoring: first }, [point(15, 500), point(30, 3000)], new Date('2026-10-02T10:30:00Z'), null);
    expect(running.job_detected).toBe(true);
    expect(summarizeHoldMonitoring({ ...hold, monitoring: running }, [point(45, 500)], new Date('2026-10-02T10:45:00Z'), null)).toMatchObject({ job_detected: true, no_load_checks: 1 });
  });
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
  it('records the home load range from samples it already read: baseline, latest and peak', () => {
    const running = summarizeHoldMonitoring(hold, [point(0, 520.4), point(5, 9600), point(15, 9500)], now, null);
    expect(running).toMatchObject({ baseline_load_w: 500, home_load_w: 9500, peak_load_w: 9600, sampled_at: point(15, 0).timestamp });
    expect(summarizeHoldMonitoring(hold, [point(15, 480.6)], now, null)).toMatchObject({ phase: 'watching', home_load_w: 481, peak_load_w: 481 });
    // A stale latest sample is still reported with its own time; the phase stays honest.
    const stale = summarizeHoldMonitoring(hold, [point(0, 9500)], new Date('2026-10-02T10:45:00Z'), null);
    expect(stale).toMatchObject({ phase: 'waiting_for_data', home_load_w: 9500, sampled_at: start.toISOString() });
  });
  it('reports no load figures without samples, or for timer holds that never read history', () => {
    expect(summarizeHoldMonitoring(hold, [], now, null)).toMatchObject({ baseline_load_w: 500, home_load_w: null, peak_load_w: null });
    expect(summarizeHoldMonitoring({ ...hold, mode: 'timer' }, [], now, null)).toMatchObject({ baseline_load_w: null, home_load_w: null, peak_load_w: null });
  });
  it('reports watching when no rise was detected and timer for fixed holds', () => {
    expect(summarizeHoldMonitoring(hold, [point(15, 500)], now, null).phase).toBe('watching');
    expect(summarizeHoldMonitoring({ ...hold, mode: 'timer' }, [], now, null).phase).toBe('timer');
  });
  it('records the live battery charge and home load from this check, with Tesla\'s measurement time', () => {
    const live = { percentage_charged: 82.4, load_power: 1840.6, timestamp: '2026-10-02T10:15:30Z' };
    const result = summarizeHoldMonitoring(hold, [point(0, 520), point(5, 900), point(15, 700)], now, null, live);
    expect(result).toMatchObject({ phase: 'watching', battery_percent: 82.4, live_at: '2026-10-02T10:15:30.000Z',
      home_load_w: 1841, sampled_at: '2026-10-02T10:15:30.000Z', peak_load_w: 1841, estimated_load_w: null });
    // The history peak still wins when it is higher than the live load.
    expect(summarizeHoldMonitoring(hold, [point(5, 9600), point(15, 9500)], now, null, live)).toMatchObject({
      phase: 'load_running', home_load_w: 1841, peak_load_w: 9600, estimated_load_w: 9000 });
  });
  it('keeps the history outage warning when only the live status is fresh', () => {
    const live = { percentage_charged: 74, load_power: 600, timestamp: '2026-10-02T10:44:00Z' };
    const result = summarizeHoldMonitoring(hold, [point(0, 9500)], new Date('2026-10-02T10:45:00Z'), null, live);
    expect(result).toMatchObject({ phase: 'waiting_for_data', battery_percent: 74, home_load_w: 600, peak_load_w: 9500 });
    expect(summarizeHoldMonitoring(hold, [], now, null, live)).toMatchObject({ phase: 'waiting_for_data', home_load_w: 600, peak_load_w: 600 });
  });
  it('drops non-finite or unparseable live fields instead of writing NaN', () => {
    const result = summarizeHoldMonitoring(hold, [point(15, 500)], now, null, { percentage_charged: NaN, load_power: Infinity, timestamp: 'nope' });
    expect(result).toMatchObject({ battery_percent: null, live_at: null, home_load_w: 500, sampled_at: point(15, 0).timestamp });
    expect(JSON.stringify(result)).not.toContain('NaN');
    // A load without a timestamp is still shown, as of this check.
    expect(summarizeHoldMonitoring(hold, [], now, null, { percentage_charged: 80, load_power: 700, timestamp: '' }))
      .toMatchObject({ home_load_w: 700, sampled_at: now.toISOString(), live_at: null });
  });
  it('gives timer holds the live charge and current load, but no start or peak figures', () => {
    const live = { percentage_charged: 74, load_power: 1800, timestamp: '2026-10-02T10:15:30Z' };
    expect(summarizeHoldMonitoring({ ...hold, mode: 'timer' }, [], now, null, live)).toMatchObject({
      phase: 'timer', battery_percent: 74, home_load_w: 1800, sampled_at: '2026-10-02T10:15:30.000Z', baseline_load_w: null, peak_load_w: null });
  });
  it('seeds the first snapshot from the live status read at hold start', () => {
    const live = { percentage_charged: 74.6, load_power: 1612.4, timestamp: '2026-10-02T10:00:10Z' };
    const at = new Date('2026-10-02T10:01:00Z');
    expect(seedHoldMonitoring({ ...hold, baseline_load_w: 1612.4 }, live, at)).toEqual({
      phase: 'watching', checked_at: at.toISOString(), next_check_at: '2026-10-02T10:15:00.000Z',
      sampled_at: '2026-10-02T10:00:10.000Z', live_at: '2026-10-02T10:00:10.000Z', battery_percent: 74.6,
      estimated_load_w: null, baseline_load_w: 1612, home_load_w: 1612, peak_load_w: 1612,
      no_load_checks: 0, no_load_last_checked_at: null, no_load_last_sample_at: null, job_detected: false });
    expect(seedHoldMonitoring({ ...hold, mode: 'timer' }, live, at)).toMatchObject({
      phase: 'timer', battery_percent: 74.6, home_load_w: 1612, baseline_load_w: null, peak_load_w: null });
  });
});
