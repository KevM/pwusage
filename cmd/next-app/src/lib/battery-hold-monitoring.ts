import type { BatteryHold } from './db';
import type { PowerData } from './nilm/types';
import type { RestoreDecision } from './battery-hold-detection';

export interface BatteryHoldMonitoring {
  phase: 'watching' | 'load_running' | 'confirming_end' | 'waiting_for_data' | 'restoring' | 'check_failed' | 'timer';
  checked_at: string;
  next_check_at: string;
  sampled_at: string | null;
  estimated_load_w: number | null;
  /** Home load when the hold started (Auto only). */
  baseline_load_w?: number | null;
  /** The latest five-minute home load sample, taken at `sampled_at`. */
  home_load_w?: number | null;
  /** The highest home load sample since the hold started. */
  peak_load_w?: number | null;
}

// The existing restore-reserve-trigger runs at :00, :15, :30 and :45 UTC.
export function summarizeHoldMonitoring(
  hold: BatteryHold, power: PowerData[], now: Date, decision: RestoreDecision | null,
): BatteryHoldMonitoring {
  const interval = 15 * 60 * 1000;
  const result: BatteryHoldMonitoring = {
    phase: hold.mode === 'timer' ? 'timer' : 'waiting_for_data',
    checked_at: now.toISOString(),
    next_check_at: new Date((Math.floor(now.getTime() / interval) + 1) * interval).toISOString(),
    sampled_at: null, estimated_load_w: null, baseline_load_w: null, home_load_w: null, peak_load_w: null,
  };
  // Timer holds never read history, so they have no load figures.
  if (hold.mode === 'timer') return { ...result, phase: decision ? 'restoring' : 'timer' };
  result.baseline_load_w = Math.round(hold.baseline_load_w);
  const samples = power.filter(p => Number.isFinite(p.powerWatts)
    && new Date(p.timestamp).getTime() >= hold.created_at.getTime()
    && new Date(p.timestamp).getTime() <= now.getTime())
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  const latest = samples.at(-1);
  const peak = Math.max(...samples.map(p => p.powerWatts));
  if (latest) {
    // Already-read samples only: reporting the range costs no Tesla call or query.
    result.sampled_at = new Date(latest.timestamp).toISOString();
    result.home_load_w = Math.round(latest.powerWatts);
    result.peak_load_w = Math.round(peak);
  }
  if (decision) return { ...result, phase: 'restoring' };
  if (!latest || now.getTime() - new Date(latest.timestamp).getTime() > 20 * 60 * 1000) return result;
  if (peak < hold.baseline_load_w + 1000) return { ...result, phase: 'watching' };
  const tolerance = Math.max(400, hold.baseline_load_w * 0.2);
  if (latest.powerWatts <= hold.baseline_load_w + tolerance) return { ...result, phase: 'confirming_end' };
  return { ...result, phase: 'load_running', estimated_load_w: Math.max(0, latest.powerWatts - hold.baseline_load_w) };
}
