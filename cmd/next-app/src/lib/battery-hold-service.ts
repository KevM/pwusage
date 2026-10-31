import { isTeslaConnectionRequired } from './tesla-refresh-outcome';
import { randomUUID } from 'node:crypto';
import { withIoDeadline, checkIoDeadline, abortable } from './io-deadline';
import { TeslaClient, TeslaAuthError, isTeslaAuthError } from './tesla-client';
import { BatteryHoldRepo } from './battery-hold-repo';
import { createTeslaClientForSite } from './tesla-client-factory';
import type { BatteryHold } from './db';
import { seedHoldMonitoring } from './battery-hold-monitoring';
import { reconcileBatteryHoldActivities } from './battery-hold-activity-repo';

const START_RESERVE_SETTLE_MS = 60 * 1000;
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
  | { status: 'reserve_sync_pending' }
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

  let live: { percentage_charged: number; load_power: number; timestamp: string };
  let info: { backup_reserve_percent: number };
  let lastRestored: BatteryHold | null;
  try {
    [live, info, lastRestored] = await Promise.all([
      client.getLiveStatus(siteId), client.getEnergySiteInfo(siteId), repo.getLatestRestoredHold(siteId),
    ]);
  } catch (e) {
    return (isTeslaAuthError(e) || isTeslaConnectionRequired(e)) ? { status: 'needs_reauth' } : { status: 'error', message: errMsg(e) };
  }

  const originalReserve = info?.backup_reserve_percent;
  if (typeof originalReserve !== 'number' || !Number.isInteger(originalReserve)
      || originalReserve < 0 || originalReserve > 100) {
    return { status: 'error', message: 'Tesla did not return a valid backup reserve. No hold was started.' };
  }
  // A successful restore command can precede Tesla's cached site_info update.
  // Do not mistake the just-stopped hold target for a new original reserve.
  if (lastRestored?.restored_at
      && now.getTime() - lastRestored.restored_at.getTime() < START_RESERVE_SETTLE_MS
      && lastRestored.original_reserve !== lastRestored.target_reserve
      && originalReserve === lastRestored.target_reserve) {
    return { status: 'reserve_sync_pending' };
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
    return (isTeslaAuthError(e) || isTeslaConnectionRequired(e)) ? { status: 'needs_reauth' } : { status: 'error', message: errMsg(e) };
  }
  let hold: BatteryHold;
  try {
    hold = await repo.createHold({
      siteId,
      originalReserve,
      targetReserve: target,
      parkedSoc: soc,
      baselineLoadW: loadPower,
      safetyExpiresAt: new Date(now.getTime() + holdMs),
      mode,
    });
  } catch (dbError) {
    console.error(`[BatteryHold] Failed to write hold to database for site ${siteId}. Attempting compensating restore to ${originalReserve}%...`, dbError);
    try {
      await client.setBackupReserve(siteId, originalReserve);
    } catch (restoreError) {
      console.error(`[BatteryHold] Compensating restore failed for site ${siteId}:`, restoreError);
    }
    return { status: 'error', message: `Database error: ${errMsg(dbError)}` };
  }
  // The app's first Live Activity state and the first push carry the figures read above.
  // The hold already started, so a failed write only leaves it for the first check.
  const monitoring = seedHoldMonitoring(hold, live, now);
  try {
    await repo.recordMonitoring(hold.id, monitoring);
    hold = { ...hold, monitoring };
  } catch {
    console.warn(`[BatteryHold] Initial monitoring write failed for hold ${hold.id}`);
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
  reason: 'load_ended' | 'no_load_detected' | 'manual' | 'safety_timeout' | 'timer_elapsed';
  expectedHoldId?: number;
  leaseOwner?: string;
}

export async function restoreBattery(deps: RestoreDeps): Promise<RestoreResult> {
  if (deps.leaseOwner) return restoreClaimedBattery(deps);
  // Manual stop uses the same claim as cron, bound to the hold observed here.
  let claimedId: number | undefined;
  const owner = randomUUID();
  let result: RestoreResult;
  try {
    result = await withIoDeadline(10000, async () => {
      const hold = await deps.repo.getActiveHold(deps.siteId);
      if (!hold || (deps.expectedHoldId !== undefined && hold.id !== deps.expectedHoldId)) return { status: 'no_active_hold' };
      claimedId = hold.id;
      if (!await deps.repo.claimHold(hold.id, owner)) return { status: 'error', message: 'A hold check or restoration is already in progress. Try again shortly.' };
      return restoreClaimedBattery({ ...deps, expectedHoldId: hold.id, leaseOwner: owner });
    });
  } catch (e) {
    result = { status: 'error', message: errMsg(e) };
  } finally {
    if (claimedId !== undefined) {
      try { await withIoDeadline(1000, () => deps.repo.releaseHold(claimedId!, owner)); }
      catch { console.warn(`[BatteryHold] Lease release deferred for hold ${claimedId}`); }
    }
  }
  // Push bookkeeping after the lease is released and outside the restore deadline.
  // Any claimed outcome may have changed the hold, so reconcile it; this never throws.
  if (claimedId !== undefined) await reconcileBatteryHoldActivities(claimedId);
  return result;
}

async function restoreClaimedBattery({ client, repo, siteId, reason, expectedHoldId, leaseOwner }: RestoreDeps): Promise<RestoreResult> {
  const hold = await repo.getActiveHold(siteId);
  if (!hold || hold.id !== expectedHoldId || !leaseOwner || !await repo.ownsHold(hold.id, leaseOwner)) return { status: 'no_active_hold' };
  const isRecent = Date.now() - hold.created_at.getTime() < 5 * 60 * 1000;
  // Uncertain commands always reconcile via a read, including manual retries.
  if (hold.restore_attempted_at || (reason !== 'manual' && !isRecent)) {
    let current: number;
    try { current = (await client.getEnergySiteInfo(siteId)).backup_reserve_percent; }
    catch (e) { return (isTeslaAuthError(e) || isTeslaConnectionRequired(e)) ? { status: 'needs_reauth' } : { status: 'error', message: errMsg(e) }; }
    if (!Number.isInteger(current) || current < 0 || current > 100) return { status: 'error', message: 'Tesla did not return a valid backup reserve.' };
    if (current !== hold.target_reserve && current !== hold.original_reserve) {
      checkIoDeadline();
      if (!await repo.markCancelled(hold.id, 'reserve_changed', current, leaseOwner)) return { status: 'error', message: 'The hold claim expired.' };
      return { status: 'reserve_changed', current };
    }
    if (hold.restore_attempted_at && current === hold.original_reserve) {
      checkIoDeadline();
      if (!await repo.markRestored(hold.id, reason, leaseOwner)) return { status: 'error', message: 'The hold claim expired.' };
      return { status: 'ok' };
    }
    if (hold.restore_attempted_at && Date.now() - hold.restore_attempted_at.getTime() < 15 * 60000) {
      return { status: 'error', message: 'Previous restoration outcome is pending. Waiting before another command.' };
    }
  }
  // Persist before sending: abort/transport failure is NOT proof no command ran.
  // The owner/identity check must still win immediately before the external write.
  if (!await repo.recordRestoreAttempt(hold.id, leaseOwner, reason)) return { status: 'error', message: 'Restoration is pending or the hold claim expired.' };
  try {
    checkIoDeadline();
    await abortable(client.setBackupReserve(siteId, hold.original_reserve));
  } catch (e) {
    // Only an explicit authentication rejection proves this command was not
    // applied. Message-based auth detection alone cannot establish that.
    if (e instanceof TeslaAuthError && (e.status === 401 || e.status === 403)) {
      try { await repo.clearRestoreAttempt(hold.id, leaseOwner); }
      catch { console.warn(`[BatteryHold] Rejected attempt cleanup deferred for hold ${hold.id}`); }
    }
    return (isTeslaAuthError(e) || isTeslaConnectionRequired(e)) ? { status: 'needs_reauth' } : { status: 'error', message: 'Restoration outcome is uncertain; the next check will reconcile it.' };
  }
  checkIoDeadline();
  if (!await repo.markRestored(hold.id, reason, leaseOwner)) return { status: 'error', message: 'Restoration acknowledgement could not be saved; the next check will reconcile it.' };
  return { status: 'ok' };
}

/** Build a TeslaClient for a site (null if no usable tokens). Delegate to shared factory in tesla-client-factory. */
export function createSiteTeslaClient(siteId: string): Promise<TeslaClient | null> {
  return createTeslaClientForSite(siteId);
}
