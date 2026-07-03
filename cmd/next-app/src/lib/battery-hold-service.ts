import { TeslaClient, isTeslaAuthError } from './tesla-client';
import { BatteryHoldRepo } from './battery-hold-repo';
import { createTeslaClientForSite } from './today-refresh';
import type { BatteryHold } from './db';

export const SAFETY_HOLD_MS = 8 * 60 * 60 * 1000; // 8h backstop

import { computeTargetReserve, planReserve } from './battery-hold-rules';
export { computeTargetReserve };
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export type ParkResult =
  | { status: 'ok'; hold: BatteryHold }
  | { status: 'already_active'; hold: BatteryHold }
  | { status: 'no_soc' }
  | { status: 'needs_choice'; options: [80, 100] }
  | { status: 'needs_reauth' }
  | { status: 'error'; message: string };

export interface ParkDeps {
  client: TeslaClient; repo: BatteryHoldRepo; siteId: string; now?: Date;
  mode?: 'auto' | 'timer';
  durationHours?: number;
  reserveChoice?: 80 | 100;
}

export async function parkBattery(
  { client, repo, siteId, now = new Date(), mode = 'auto', durationHours, reserveChoice }: ParkDeps,
): Promise<ParkResult> {
  if (mode === 'timer') {
    if (durationHours === undefined || durationHours === null || typeof durationHours !== 'number' || Number.isNaN(durationHours) || durationHours <= 0) {
      return { status: 'error', message: 'Valid duration in hours is required for timer mode.' };
    }
  }

  const existing = await repo.getActiveHold(siteId);
  if (existing) return { status: 'already_active', hold: existing };

  let live: { percentage_charged: number; load_power: number };
  let info: { backup_reserve_percent: number };
  try {
    [live, info] = await Promise.all([client.getLiveStatus(siteId), client.getEnergySiteInfo(siteId)]);
  } catch (e) {
    return isTeslaAuthError(e) ? { status: 'needs_reauth' } : { status: 'error', message: errMsg(e) };
  }

  const soc = live?.percentage_charged;
  if (typeof soc !== 'number' || Number.isNaN(soc)) return { status: 'no_soc' };

  const loadPower = live?.load_power;
  if (typeof loadPower !== 'number' || Number.isNaN(loadPower)) {
    return { status: 'error', message: 'Failed to retrieve baseline load power.' };
  }

  const plan = planReserve(soc);
  let target: number;
  if (plan.ambiguous) {
    if (reserveChoice !== 80 && reserveChoice !== 100) return { status: 'needs_choice', options: plan.options! };
    target = reserveChoice;
  } else {
    target = plan.target;
  }

  const holdMs = mode === 'timer'
    ? Math.round((durationHours ?? 0) * 60 * 60 * 1000)
    : SAFETY_HOLD_MS;

  try {
    const resp = await client.setBackupReserve(siteId, target);
    if (resp?.Message && /Max Backup Reserve/i.test(resp.Message)) {
      console.warn(`[BatteryHold] unexpected clamp for ${siteId}: sent ${target}, got "${resp.Message}"`);
    }
  } catch (e) {
    return isTeslaAuthError(e) ? { status: 'needs_reauth' } : { status: 'error', message: errMsg(e) };
  }
  let hold: BatteryHold;
  try {
    hold = await repo.createHold({
      siteId,
      originalReserve: info.backup_reserve_percent,
      targetReserve: target,
      parkedSoc: soc,
      baselineLoadW: loadPower,
      safetyExpiresAt: new Date(now.getTime() + holdMs),
      mode,
    });
  } catch (dbError) {
    console.error(`[BatteryHold] Failed to write hold to database for site ${siteId}. Attempting compensating restore to ${info.backup_reserve_percent}%...`, dbError);
    try {
      await client.setBackupReserve(siteId, info.backup_reserve_percent);
    } catch (restoreError) {
      console.error(`[BatteryHold] Compensating restore failed for site ${siteId}:`, restoreError);
    }
    return { status: 'error', message: `Database error: ${errMsg(dbError)}` };
  }
  return { status: 'ok', hold };
}

export type RestoreResult =
  | { status: 'ok' }
  | { status: 'reserve_changed'; current: number }
  | { status: 'no_active_hold' }
  | { status: 'needs_reauth' }
  | { status: 'error'; message: string };

export interface RestoreDeps {
  client: TeslaClient; repo: BatteryHoldRepo; siteId: string;
  reason: 'load_ended' | 'manual' | 'safety_timeout' | 'timer_elapsed';
}

export async function restoreBattery({ client, repo, siteId, reason }: RestoreDeps): Promise<RestoreResult> {
  const hold = await repo.getActiveHold(siteId);
  if (!hold) return { status: 'no_active_hold' };

  // Guard: never overwrite a reserve the user changed manually mid-hold.
  // We bypass this guard (saving a Tesla API read) if:
  // 1. The restore is requested manually by the user.
  // 2. The hold was created very recently (within 5 minutes), where the Tesla API
  //    cache is likely stale and still showing the pre-parked reserve.
  const isRecent = Date.now() - new Date(hold.created_at).getTime() < 5 * 60 * 1000;
  if (reason !== 'manual' && !isRecent) {
    let current: number;
    try {
      const info = await client.getEnergySiteInfo(siteId);
      current = info.backup_reserve_percent;
    } catch (e) {
      return isTeslaAuthError(e) ? { status: 'needs_reauth' } : { status: 'error', message: errMsg(e) };
    }
    if (current !== hold.target_reserve && current !== hold.original_reserve) {
      await repo.markCancelled(hold.id, 'reserve_changed', current);
      return { status: 'reserve_changed', current };
    }
  }

  try {
    await client.setBackupReserve(siteId, hold.original_reserve);
  } catch (e) {
    return isTeslaAuthError(e) ? { status: 'needs_reauth' } : { status: 'error', message: errMsg(e) };
  }
  await repo.markRestored(hold.id, reason);
  return { status: 'ok' };
}

/** Build a TeslaClient for a site (null if no usable tokens). Delegate to shared factory in today-refresh. */
export function createSiteTeslaClient(siteId: string): Promise<TeslaClient | null> {
  return createTeslaClientForSite(siteId);
}
