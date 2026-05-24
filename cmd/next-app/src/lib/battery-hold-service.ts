import { TeslaClient } from './tesla-client';
import { BatteryHoldRepo } from './battery-hold-repo';
import { SiteRepo } from './site-repo';
import { TeslaTokenRepo } from './tesla-token-repo';
import { UserRepo } from './user-repo';
import type { BatteryHold } from './db';

export const SAFETY_HOLD_MS = 16 * 60 * 60 * 1000; // 16h backstop

import { computeTargetReserve } from './battery-hold-rules';
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
  | { status: 'needs_reauth' }
  | { status: 'error'; message: string };

export interface ParkDeps { client: TeslaClient; repo: BatteryHoldRepo; siteId: string; now?: Date; }

export async function parkBattery({ client, repo, siteId, now = new Date() }: ParkDeps): Promise<ParkResult> {
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

  const target = computeTargetReserve(soc);
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
    safetyExpiresAt: new Date(now.getTime() + SAFETY_HOLD_MS),
  });
  return { status: 'ok', hold };
}

export type RestoreResult =
  | { status: 'ok' }
  | { status: 'no_active_hold' }
  | { status: 'needs_reauth' }
  | { status: 'error'; message: string };

export interface RestoreDeps {
  client: TeslaClient; repo: BatteryHoldRepo; siteId: string;
  reason: 'load_ended' | 'manual' | 'safety_timeout';
}

export async function restoreBattery({ client, repo, siteId, reason }: RestoreDeps): Promise<RestoreResult> {
  const hold = await repo.getActiveHold(siteId);
  if (!hold) return { status: 'no_active_hold' };
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
