import { detectLoads } from './nilm/load-detection';
import type { PowerData } from './nilm/types';
import type { BatteryHold } from './db';

export interface RestoreDecision {
  restore: true;
  reason: 'load_ended' | 'no_load_detected' | 'safety_timeout' | 'timer_elapsed';
}

// A detected event whose start is within this window of the park counts as "the load".
const PARK_MATCH_WINDOW_MS = 20 * 60 * 1000;
// The load must have risen at least this far above baseline for the fallback to arm.
const RISE_THRESHOLD_W = 1000;
// Sustained return-to-baseline window for the fallback.
const FALLBACK_SUSTAINED_MS = 15 * 60 * 1000;
const MIN_FALLBACK_SAMPLES = 3;
const BASELINE_TOLERANCE_W = 400;
const BASELINE_TOLERANCE_FRAC = 0.2;

function ts(p: PowerData): number {
  return p.timestamp instanceof Date ? p.timestamp.getTime() : new Date(p.timestamp).getTime();
}

/**
 * Decide whether an active hold should be restored. Pure: no I/O.
 * Primary signal reuses NILM detectLoads (which only returns *closed* events);
 * a closed event near the park time means the charging load ended. A fallback
 * covers a missed edge: the load rose well above baseline and has since returned.
 * Safety timeout is the ultimate backstop.
 */
export function evaluateHold(hold: BatteryHold, recentPower: PowerData[], now: Date): RestoreDecision | null {
  // Timer mode: a strict N-hour hold. No NILM — only the clock matters.
  if (hold.mode === 'timer') {
    return now.getTime() >= hold.safety_expires_at.getTime()
      ? { restore: true, reason: 'timer_elapsed' }
      : null;
  }

  if (now.getTime() >= hold.safety_expires_at.getTime()) {
    return { restore: true, reason: 'safety_timeout' };
  }

  // Telemetry can be stale even when a refresh returned successfully (or failed).
  // Filter invalid/future samples before both NILM and fallback decisions.
  recentPower = recentPower.filter(p => Number.isFinite(p.powerWatts) && Number.isFinite(ts(p)) && ts(p) <= now.getTime());
  const latestMs = Math.max(...recentPower.map(ts));
  if (!Number.isFinite(latestMs) || now.getTime() - latestMs > 20 * 60 * 1000) return null;

  const parkedAt = hold.created_at.getTime();

  // Primary: a closed event that started around when we parked.
  const events = detectLoads(recentPower, RISE_THRESHOLD_W);
  const matched = events.some(e => Math.abs(new Date(e.startTime).getTime() - parkedAt) <= PARK_MATCH_WINDOW_MS);
  if (matched) {
    return { restore: true, reason: 'load_ended' };
  }

  // Fallback: only arm once the load actually rose above baseline since park.
  const sincePark = recentPower.filter(p => ts(p) >= parkedAt);
  const peak = sincePark.reduce((m, p) => Math.max(m, p.powerWatts), 0);
  if (peak < hold.baseline_load_w + RISE_THRESHOLD_W) {
    return null; // never rose: nothing has ended; keep holding.
  }

  const tolerance = Math.max(BASELINE_TOLERANCE_W, hold.baseline_load_w * BASELINE_TOLERANCE_FRAC);
  const cutoff = now.getTime() - FALLBACK_SUSTAINED_MS;
  const recent = recentPower.filter(p => ts(p) >= cutoff);
  if (recent.length >= MIN_FALLBACK_SAMPLES && recent.every(p => p.powerWatts <= hold.baseline_load_w + tolerance)) {
    return { restore: true, reason: 'load_ended' };
  }

  return null;
}
