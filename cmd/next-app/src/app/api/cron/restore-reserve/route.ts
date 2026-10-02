export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { BatteryHoldRepo } from '@/lib/battery-hold-repo';
import { EnergyRepo } from '@/lib/energy-repo';
import { adaptTeslaData } from '@/lib/nilm/tesla-adapter';
import { summarizeHoldMonitoring, type BatteryHoldMonitoring } from '@/lib/battery-hold-monitoring';
import type { PowerData } from '@/lib/nilm/types';
import { evaluateHold } from '@/lib/battery-hold-detection';
import { refreshTodayData } from '@/lib/today-refresh';
import { createSiteTeslaClient, restoreBattery } from '@/lib/battery-hold-service';

const LOOKBACK_MS = 30 * 60 * 1000;

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const repo = new BatteryHoldRepo();
  const energyRepo = new EnergyRepo();
  const holds = await repo.getAllActiveHolds();
  const now = new Date();
  const results: Array<Record<string, unknown>> = [];

  for (const hold of holds) {
    // Monitoring is best effort: a failed telemetry write must never block a restore.
    const record = async (monitoring: BatteryHoldMonitoring) => {
      try { await repo.recordMonitoring(hold.id, monitoring); }
      catch (error) { console.error(`[BatteryHold] Monitoring write failed for hold ${hold.id}`, error); }
    };
    try {
      let samples: PowerData[] = [];
      let decision;
      if (hold.mode === 'timer') {
        decision = evaluateHold(hold, [], now); // pure clock check; no samples needed
      } else {
        await refreshTodayData(hold.site_id);
        const start = new Date(hold.created_at.getTime() - LOOKBACK_MS);
        const rows = await energyRepo.getRawEnergyData(hold.site_id, start, now);
        samples = adaptTeslaData(rows);
        decision = evaluateHold(hold, samples, now);
      }

      const monitoring = summarizeHoldMonitoring(hold, samples, now, decision);
      if (!decision) {
        await record(monitoring);
        results.push({ siteId: hold.site_id, status: 'holding' });
        continue;
      }

      const client = await createSiteTeslaClient(hold.site_id);
      if (!client) {
        await record({ ...monitoring, phase: 'check_failed' });
        results.push({ siteId: hold.site_id, status: 'no-tokens' });
        continue;
      }
      const r = await restoreBattery({ client, repo, siteId: hold.site_id, reason: decision.reason });
      if (r.status !== 'ok' && r.status !== 'reserve_changed' && r.status !== 'no_active_hold') {
        await record({ ...monitoring, phase: 'check_failed' });
      }
      results.push({ siteId: hold.site_id, reason: decision.reason, restore: r.status });
    } catch (error) {
      await record({ ...summarizeHoldMonitoring(hold, [], now, null), phase: 'check_failed' });
      results.push({ siteId: hold.site_id, status: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  }

  console.log(`[CRON] restore-reserve processed ${holds.length} hold(s): ${JSON.stringify(results)}`);
  return NextResponse.json({ success: true, processed: holds.length, results });
}
