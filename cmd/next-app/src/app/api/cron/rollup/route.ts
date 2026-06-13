export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { EnergyRepo } from '@/lib/energy-repo';
import { SiteRepo } from '@/lib/site-repo';
import { RollupService } from '@/lib/battery-provenance/rollup-service';
import { RollupRepo } from '@/lib/battery-provenance/rollup-repo';
import { localDateKey } from '@/lib/battery-provenance/local-day';

export async function GET(request: NextRequest) {
    try {
        const authHeader = request.headers.get('authorization');
        if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const siteRepo = new SiteRepo();
        const energyRepo = new EnergyRepo();
        const rollupRepo = new RollupRepo();

        const service = new RollupService({
            loadSite: async (siteId) => {
                const site = await siteRepo.getSite(siteId);
                if (!site) throw new Error(`site ${siteId} not found`);
                return { id: site.id, timezone: site.timezone, tariffs: site.tariffs ?? [] };
            },
            loadEnergyData: (siteId, start, end) => energyRepo.getRawEnergyData(siteId, start, end),
            getSeedTank: (siteId, beforeTs) => rollupRepo.getSeedTank(siteId, beforeTs),
            hasAnyRollup: (siteId) => rollupRepo.hasAnyRollup(siteId),
            upsertRollups: (rows) => rollupRepo.upsertRollups(rows),
        });

        const siteIds = await siteRepo.getSiteIds();
        const results: Array<{ siteId: string; localDate: string; rollupCount: number }> = [];

        for (const siteId of siteIds) {
            try {
                const site = await siteRepo.getSite(siteId);
                if (!site) continue;
                // Previous local day for this site.
                const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
                const localDate = localDateKey(yesterday, site.timezone);
                const { rollupCount } = await service.rollupDay(siteId, localDate);
                results.push({ siteId, localDate, rollupCount });
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
