import type { BatteryHold } from './db';
import type { PowerData } from './nilm/types';
import type { RestoreDecision } from './battery-hold-detection';
import type { EnergySiteLiveStatus } from './tesla-client';

/** The live_status fields a hold check reads: current charge and home load, and when Tesla measured them. */
export type HoldLiveStatus = Pick<EnergySiteLiveStatus, 'percentage_charged' | 'load_power' | 'timestamp'>;

export interface BatteryHoldMonitoring {
  phase: 'watching' | 'load_running' | 'confirming_end' | 'waiting_for_data' | 'restoring' | 'check_failed' | 'timer';
  checked_at: string;
  next_check_at: string;
  sampled_at: string | null;
  estimated_load_w: number | null;
  /** Home load when the hold started (Auto only). */
  baseline_load_w?: number | null;
  /** The current home load, taken at `sampled_at`: the live reading when this check had one, else the latest five-minute sample. */
  home_load_w?: number | null;
  /** The highest home load since the hold started (history samples and the live reading). */
  peak_load_w?: number | null;
  /** live_status.percentage_charged from this check, or from hold start. */
  battery_percent?: number | null;
  /** When Tesla measured the live reading (live_status.timestamp). */
  live_at?: string | null;
}

const CHECK_INTERVAL_MS = 15 * 60 * 1000;
const finite = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const isoOrNull = (value: unknown): string | null => {
  const ms = typeof value === 'string' && value ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

function baseMonitoring(hold: BatteryHold, now: Date, live: HoldLiveStatus | null | undefined): BatteryHoldMonitoring {
  return {
    phase: hold.mode === 'timer' ? 'timer' : 'waiting_for_data',
    checked_at: now.toISOString(),
    next_check_at: new Date((Math.floor(now.getTime() / CHECK_INTERVAL_MS) + 1) * CHECK_INTERVAL_MS).toISOString(),
    sampled_at: null, estimated_load_w: null, baseline_load_w: null, home_load_w: null, peak_load_w: null,
    battery_percent: finite(live?.percentage_charged), live_at: isoOrNull(live?.timestamp),
  };
}

/** The live load, when present, is the current figure; without a timestamp it is as of this check. */
function liveLoad(result: BatteryHoldMonitoring, live: HoldLiveStatus | null | undefined, now: Date) {
  const watts = finite(live?.load_power);
  return watts === null ? null : { watts, at: result.live_at ?? now.toISOString() };
}

/** The first snapshot, from the live status read when the hold started: the load observed equals the baseline. */
export function seedHoldMonitoring(hold: BatteryHold, live: HoldLiveStatus, now: Date): BatteryHoldMonitoring {
  const result = baseMonitoring(hold, now, live);
  const load = liveLoad(result, live, now);
  if (load) { result.home_load_w = Math.round(load.watts); result.sampled_at = load.at; }
  if (hold.mode === 'timer') return result;
  return { ...result, phase: 'watching', baseline_load_w: Math.round(hold.baseline_load_w), peak_load_w: result.home_load_w };
}

// The existing restore-reserve-trigger runs at :00, :15, :30 and :45 UTC.
export function summarizeHoldMonitoring(
  hold: BatteryHold, power: PowerData[], now: Date, decision: RestoreDecision | null,
  live?: HoldLiveStatus | null,
): BatteryHoldMonitoring {
  const result = baseMonitoring(hold, now, live);
  const load = liveLoad(result, live, now);
  // Timer holds never read history: the live reading is their only load figure.
  if (hold.mode === 'timer') {
    if (load) { result.home_load_w = Math.round(load.watts); result.sampled_at = load.at; }
    return { ...result, phase: decision ? 'restoring' : 'timer' };
  }
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
  if (load) {
    // The live load is the current figure; the peak includes it so it never reads above its own peak.
    result.sampled_at = load.at;
    result.home_load_w = Math.round(load.watts);
    result.peak_load_w = Math.round(Math.max(load.watts, ...(latest ? [peak] : [])));
  }
  // Phase and estimate stay history-based: detection reads only the five-minute samples.
  if (decision) return { ...result, phase: 'restoring' };
  if (!latest || now.getTime() - new Date(latest.timestamp).getTime() > 20 * 60 * 1000) return result;
  if (peak < hold.baseline_load_w + 1000) return { ...result, phase: 'watching' };
  const tolerance = Math.max(400, hold.baseline_load_w * 0.2);
  if (latest.powerWatts <= hold.baseline_load_w + tolerance) return { ...result, phase: 'confirming_end' };
  return { ...result, phase: 'load_running', estimated_load_w: Math.max(0, latest.powerWatts - hold.baseline_load_w) };
}
