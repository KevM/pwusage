import { randomUUID } from 'node:crypto';
import { BatteryHoldRepo } from './battery-hold-repo';
import { EnergyRepo } from './energy-repo';
import { adaptTeslaData } from './nilm/tesla-adapter';
import { summarizeHoldMonitoring, type BatteryHoldMonitoring, type HoldLiveStatus } from './battery-hold-monitoring';
import { evaluateHold } from './battery-hold-detection';
import { refreshLiveStatus, refreshTodayData } from './today-refresh';
import { createSiteTeslaClient, restoreBattery } from './battery-hold-service';
import { reconcileBatteryHoldActivities } from './battery-hold-activity-repo';
import { ioSignal, withIoDeadline } from './io-deadline';
import type { BatteryHold } from './db';
import type { PowerData } from './nilm/types';

export const MONITOR_SITE_BUDGET_MS = 10000;
export const MONITOR_HISTORY_BUDGET_MS = 4000;
export const MONITOR_WORKERS = 3;
// One live_status per check: reuse a dashboard read from moments ago, never the previous check's.
export const MONITOR_LIVE_TTL_MS = 2 * 60 * 1000;
// Runs alongside the history refresh, inside the site budget; Tesla's own call is capped at 3s.
export const MONITOR_LIVE_BUDGET_MS = 4000;
type MonitorResult = { siteId: string; status: 'holding' | 'skipped' | 'completed' | 'failed'; restore?: string };

/** The current charge and home load, or null: a live-status failure never fails the check. */
async function readLiveStatus(siteId: string): Promise<HoldLiveStatus | null> {
  try {
    // refreshLiveStatus holds the cross-instance claim, so concurrent readers share one Tesla call.
    const result = await withIoDeadline(MONITOR_LIVE_BUDGET_MS, () =>
      refreshLiveStatus(siteId, { cacheTtlMs: MONITOR_LIVE_TTL_MS, timeoutMs: 3000 }));
    // A lost claim can hand back an older cached status; that is not this check's reading.
    if (!result.liveStatus || result.fetchedAt === undefined || Date.now() - result.fetchedAt > MONITOR_LIVE_TTL_MS) return null;
    return result.liveStatus;
  } catch {
    return null;
  }
}

async function processHold(hold: BatteryHold): Promise<MonitorResult> {
  const repo = new BatteryHoldRepo();
  const owner = randomUUID();
  const record = async (monitoring: BatteryHoldMonitoring) => {
    try { await repo.recordMonitoring(hold.id, monitoring); }
    catch { console.warn(`[BatteryHold] Monitoring write failed for hold ${hold.id}`); }
  };
  try {
    return await withIoDeadline(MONITOR_SITE_BUDGET_MS, async () => {
      if (!await repo.claimHold(hold.id, owner)) return { siteId: hold.site_id, status: 'skipped' };
      let now = new Date();
      let samples: PowerData[] = [];
      // Both timer and Auto safety deadlines precede any billable history work.
      let decision = evaluateHold(hold, [], now);
      let live: HoldLiveStatus | null = null;
      if (!decision && !hold.restore_attempted_at && hold.mode === 'timer') {
        live = await readLiveStatus(hold.site_id);
        now = new Date();
        decision = evaluateHold(hold, [], now);
      } else if (!decision && !hold.restore_attempted_at) {
        [live] = await Promise.all([
          readLiveStatus(hold.site_id),
          refreshTodayData(hold.site_id, { timeoutMs: MONITOR_HISTORY_BUDGET_MS, signal: ioSignal() }),
        ]);
        now = new Date();
        decision = evaluateHold(hold, [], now);
        if (!decision) {
          const rows = await new EnergyRepo().getRawEnergyData(hold.site_id, new Date(hold.created_at.getTime() - 30 * 60000), now);
          samples = adaptTeslaData(rows);
          now = new Date();
          decision = evaluateHold(hold, samples, now);
        }
      }
      const monitoring = summarizeHoldMonitoring(hold, samples, now, decision, live);
      if (!decision && !hold.restore_attempted_at) { await record(monitoring); return { siteId: hold.site_id, status: 'holding' }; }
      const client = await createSiteTeslaClient(hold.site_id);
      if (!client) { await record({ ...monitoring, phase: 'check_failed' }); return { siteId: hold.site_id, status: 'failed', restore: 'no-tokens' }; }
      const result = await restoreBattery({ client, repo, siteId: hold.site_id, reason: hold.restore_attempted_at ? (hold.restore_reason === 'reserve_changed' || !hold.restore_reason ? 'safety_timeout' : hold.restore_reason) : decision!.reason, expectedHoldId: hold.id, leaseOwner: owner });
      const completed = ['ok', 'reserve_changed', 'no_active_hold'].includes(result.status);
      if (!completed) await record({ ...monitoring, phase: 'check_failed' });
      return { siteId: hold.site_id, status: completed ? 'completed' : 'failed', restore: result.status };
    });
  } catch {
    try { await withIoDeadline(1000, () => record({ ...summarizeHoldMonitoring(hold, [], new Date(), null), phase: 'check_failed' })); }
    catch { console.warn(`[BatteryHold] Failure telemetry deferred for hold ${hold.id}`); }
    return { siteId: hold.site_id, status: 'failed' };
  } finally {
    // A cancelled scope cannot clean itself up; owner-conditioned release gets
    // a separate short DB budget. An unconfirmed release falls back to expiry.
    try { await withIoDeadline(1000, () => repo.releaseHold(hold.id, owner)); }
    catch { console.warn(`[BatteryHold] Lease release deferred for hold ${hold.id}`); }
  }
}

export async function monitorBatteryHolds(holds: BatteryHold[]) {
  const started = Date.now();
  const queue = [...holds].sort((a, b) => a.safety_expires_at.getTime() - b.safety_expires_at.getTime());
  const results: MonitorResult[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(MONITOR_WORKERS, queue.length) }, async () => {
    while (next < queue.length) {
      const hold = queue[next++];
      // Leave headroom for the site attempt, failure telemetry and lease cleanup.
      if (Date.now() - started > 40000) results.push({ siteId: hold.site_id, status: 'skipped' });
      else results.push(await processHold(hold));
    }
  }));
  // One reconcile covers every monitoring update and terminal transition of this run.
  const activitiesSynced = await reconcileBatteryHoldActivities();
  return { eligible: holds.length, attempted: results.filter(r => r.status !== 'skipped').length,
    skipped: results.filter(r => r.status === 'skipped').length,
    failed: results.filter(r => r.status === 'failed').length,
    completed: results.filter(r => r.status === 'completed').length,
    activitiesSynced,
    runtimeMs: Date.now() - started, results };
}
