export const dynamic = 'force-dynamic';
export const maxDuration = 60; // Vercel Hobby cap; loops in-band sites + may fetch partial days from Tesla

import { NextRequest, NextResponse } from 'next/server';
import { EnergyRepo } from '@/lib/energy-repo';
import { SiteRepo } from '@/lib/site-repo';
import { RollupService } from '@/lib/battery-provenance/rollup-service';
import { RollupRepo } from '@/lib/battery-provenance/rollup-repo';
import { HourlyRepo } from '@/lib/battery-provenance/hourly-repo';
import { localDateKey, localDayBoundsUtc } from '@/lib/battery-provenance/local-day';
import { classifyDayCoverage } from '@/lib/battery-provenance/day-coverage';
import { isInRollupBand } from '@/lib/battery-provenance/rollup-window';
import { createSiteTeslaClient } from '@/lib/battery-hold-service';
import { Importer } from '@/lib/importer';

export async function GET(request: NextRequest) {
  try {
    const authHeader = request.headers.get('authorization');
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const siteRepo = new SiteRepo();
    const energyRepo = new EnergyRepo();
    const rollupRepo = new RollupRepo();
    const hourlyRepo = new HourlyRepo();
    const now = new Date();
    const results: Array<{ siteId: string; localDate: string; action: string }> = [];

    const buildService = () => new RollupService({
      loadSite: async (siteId) => {
        const site = await siteRepo.getSite(siteId);
        if (!site) throw new Error(`site ${siteId} not found`);
        return { id: site.id, timezone: site.timezone, tariffs: site.tariffs ?? [] };
      },
      loadEnergyData: (siteId, start, end) => energyRepo.getRawEnergyData(siteId, start, end),
      getSeedTank: (siteId, beforeTs) => rollupRepo.getSeedTank(siteId, beforeTs),
      hasAnyRollup: (siteId) => rollupRepo.hasAnyRollup(siteId),
      upsertRollups: (rows) => rollupRepo.upsertRollups(rows),
      upsertHourly: (rows) => hourlyRepo.upsertHourly(rows),
    });

    const siteIds = await siteRepo.getSiteIds();

    for (const siteId of siteIds) {
      try {
        const site = await siteRepo.getSite(siteId);
        if (!site || !isInRollupBand(now, site.timezone)) continue;

        // Target yesterday-local
        const localDate = localDateKey(new Date(now.getTime() - 86400_000), site.timezone);
        if (await rollupRepo.hasRollupForDate(siteId, localDate)) {
          results.push({ siteId, localDate, action: 'skip-already-rolled' });
          continue;
        }

        const { start, end } = localDayBoundsUtc(localDate, site.timezone);
        const stamps = await energyRepo.getExistingTimestamps(siteId, start, end);
        const coverage = classifyDayCoverage(stamps.map(Number), start, end);

        if (coverage === 'empty') {
          results.push({ siteId, localDate, action: 'skip-no-data' });
          continue;
        }

        if (coverage === 'partial') {
          const client = await createSiteTeslaClient(siteId);
          if (client) {
            await new Importer(client).ensureDataForRange(siteId, start, end, undefined, { force: true });
          }
          const restamps = (await energyRepo.getExistingTimestamps(siteId, start, end)).map(Number);
          if (classifyDayCoverage(restamps, start, end) !== 'complete') {
            results.push({ siteId, localDate, action: 'skip-still-partial' });
            continue;
          }
        }

        const { rollupCount } = await buildService().rollupDay(siteId, localDate);
        results.push({ siteId, localDate, action: `rolled-${rollupCount}` });
      } catch (e) {
        console.error(`[CRON rollup] site ${siteId} failed:`, e);
      }
    }

    return NextResponse.json({ success: true, results });
  } catch (error) {
    console.error('[CRON rollup] failed:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
