import { randomUUID } from 'node:crypto';
import { BatteryHoldRepo } from './battery-hold-repo';
import { EnergyRepo } from './energy-repo';
import { adaptTeslaData } from './nilm/tesla-adapter';
import { summarizeHoldMonitoring, type BatteryHoldMonitoring } from './battery-hold-monitoring';
import { evaluateHold } from './battery-hold-detection';
import { refreshTodayData } from './today-refresh';
import { createSiteTeslaClient, restoreBattery } from './battery-hold-service';
import { ioSignal, withIoDeadline } from './io-deadline';
import type { BatteryHold } from './db';
import type { PowerData } from './nilm/types';

export const MONITOR_SITE_BUDGET_MS = 10000;
export const MONITOR_HISTORY_BUDGET_MS = 4000;
export const MONITOR_WORKERS = 3;
type MonitorResult = { siteId: string; status: 'holding' | 'skipped' | 'completed' | 'failed'; restore?: string };

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
      if (!decision && !hold.restore_attempted_at && hold.mode !== 'timer') {
        await refreshTodayData(hold.site_id, { timeoutMs: MONITOR_HISTORY_BUDGET_MS, signal: ioSignal() });
        now = new Date();
        decision = evaluateHold(hold, [], now);
        if (!decision) {
          const rows = await new EnergyRepo().getRawEnergyData(hold.site_id, new Date(hold.created_at.getTime() - 30 * 60000), now);
          samples = adaptTeslaData(rows);
          now = new Date();
          decision = evaluateHold(hold, samples, now);
        }
      }
      const monitoring = summarizeHoldMonitoring(hold, samples, now, decision);
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
  return { eligible: holds.length, attempted: results.filter(r => r.status !== 'skipped').length,
    skipped: results.filter(r => r.status === 'skipped').length,
    failed: results.filter(r => r.status === 'failed').length,
    completed: results.filter(r => r.status === 'completed').length,
    runtimeMs: Date.now() - started, results };
}
