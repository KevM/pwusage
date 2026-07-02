export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { BatteryHoldRepo } from '@/lib/battery-hold-repo';
import { EnergyRepo } from '@/lib/energy-repo';
import { adaptTeslaData } from '@/lib/nilm/tesla-adapter';
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
    try {
      let decision;
      if (hold.mode === 'timer') {
        decision = evaluateHold(hold, [], now); // pure clock check; no samples needed
      } else {
        await refreshTodayData(hold.site_id);
        const start = new Date(hold.created_at.getTime() - LOOKBACK_MS);
        const rows = await energyRepo.getRawEnergyData(hold.site_id, start, now);
        decision = evaluateHold(hold, adaptTeslaData(rows), now);
      }

      if (!decision) {
        results.push({ siteId: hold.site_id, status: 'holding' });
        continue;
      }

      const client = await createSiteTeslaClient(hold.site_id);
      if (!client) {
        results.push({ siteId: hold.site_id, status: 'no-tokens' });
        continue;
      }
      const r = await restoreBattery({ client, repo, siteId: hold.site_id, reason: decision.reason });
      results.push({ siteId: hold.site_id, reason: decision.reason, restore: r.status });
    } catch (error) {
      results.push({ siteId: hold.site_id, status: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  }

  console.log(`[CRON] restore-reserve processed ${holds.length} hold(s): ${JSON.stringify(results)}`);
  return NextResponse.json({ success: true, processed: holds.length, results });
}
