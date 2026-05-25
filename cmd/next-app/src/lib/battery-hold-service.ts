import { TeslaClient } from './tesla-client';
import { BatteryHoldRepo } from './battery-hold-repo';
import { SiteRepo } from './site-repo';
import { TeslaTokenRepo } from './tesla-token-repo';
import { UserRepo } from './user-repo';
import type { BatteryHold } from './db';

export const SAFETY_HOLD_MS = 16 * 60 * 60 * 1000; // 16h backstop

import { computeTargetReserve, planReserve } from './battery-hold-rules';
export { computeTargetReserve };

function isAuthError(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return /\b(401|403)\b/.test(m) || /token|login_required|unauthor/i.test(m);
}
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
  const existing = await repo.getActiveHold(siteId);
  if (existing) return { status: 'already_active', hold: existing };

  let live: { percentage_charged: number; load_power: number };
  let info: { backup_reserve_percent: number };
  try {
    [live, info] = await Promise.all([client.getLiveStatus(siteId), client.getEnergySiteInfo(siteId)]);
  } catch (e) {
    return isAuthError(e) ? { status: 'needs_reauth' } : { status: 'error', message: errMsg(e) };
  }

  const soc = live?.percentage_charged;
  if (typeof soc !== 'number' || Number.isNaN(soc)) return { status: 'no_soc' };

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
    return isAuthError(e) ? { status: 'needs_reauth' } : { status: 'error', message: errMsg(e) };
  }

  const hold = await repo.createHold({
    siteId,
    originalReserve: info.backup_reserve_percent,
    targetReserve: target,
    parkedSoc: soc,
    baselineLoadW: live.load_power,
    safetyExpiresAt: new Date(now.getTime() + holdMs),
    mode,
  });
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

  // Guard: never overwrite a reserve the user changed manually mid-hold. We expect
  // the live reserve to still equal what we parked at (target_reserve); if not,
  // cancel the hold without writing so the user's setting stands.
  let current: number;
  try {
    const info = await client.getEnergySiteInfo(siteId);
    current = info.backup_reserve_percent;
  } catch (e) {
    return isAuthError(e) ? { status: 'needs_reauth' } : { status: 'error', message: errMsg(e) };
  }
  if (current !== hold.target_reserve) {
    await repo.markCancelled(hold.id, 'reserve_changed', current);
    return { status: 'reserve_changed', current };
  }

  try {
    await client.setBackupReserve(siteId, hold.original_reserve);
  } catch (e) {
    return isAuthError(e) ? { status: 'needs_reauth' } : { status: 'error', message: errMsg(e) };
  }
  await repo.markRestored(hold.id, reason);
  return { status: 'ok' };
}

/** Build a TeslaClient for a site (null if no usable tokens). Mirrors today-refresh.ts. */
export async function createSiteTeslaClient(siteId: string): Promise<TeslaClient | null> {
  const tokens = await new UserRepo().getTokensForSite(siteId);
  if (!tokens?.access_token || !tokens?.refresh_token) return null;
  const tokenRepo = new TeslaTokenRepo(new SiteRepo());
  const handlers = tokenRepo.getLockedRefreshHandler(siteId);
  return new TeslaClient({
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    tokenRefreshHandler: handlers.refreshHandler,
    onTokenError: handlers.errorHandler,
    onTokenUpdate: () => {},
  });
}
