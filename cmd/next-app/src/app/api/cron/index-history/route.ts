export const dynamic = 'force-dynamic';
export const maxDuration = 60; // Vercel Hobby budget limit is 60s

import { NextRequest, NextResponse } from 'next/server';
import { SiteRepo } from '@/lib/site-repo';
import { EnergyRepo } from '@/lib/energy-repo';
import { RollupRepo } from '@/lib/battery-provenance/rollup-repo';
import { RollupService } from '@/lib/battery-provenance/rollup-service';
import { RollupBackfillRepo } from '@/lib/battery-provenance/rollup-backfill-repo';
import { BackfillService } from '@/lib/battery-provenance/backfill-service';
import { localDayBoundsUtc } from '@/lib/battery-provenance/local-day';
import { createSiteTeslaClient } from '@/lib/battery-hold-service';
import { Importer } from '@/lib/importer';
import type { EnergyData } from '@/lib/db';

const DAYS_PER_TICK = parseInt(process.env.INDEX_HISTORY_DAYS_PER_TICK || '45', 10);
const SITES_PER_TICK = parseInt(process.env.INDEX_HISTORY_SITES_PER_TICK || '1', 10);
const BUDGET_MS = 50_000; // Leave 10s buffer before Vercel 60s limit
const RETENTION_DAYS = parseInt(process.env.DATA_RETENTION_DAYS || '365', 10);
const FETCH_CONCURRENCY = parseInt(process.env.INDEX_HISTORY_FETCH_CONCURRENCY || '6', 10);
const TESLA_MAX_RETRY_DELAY_MS = parseInt(process.env.TESLA_MAX_RETRY_DELAY_MS || '5000', 10);

export async function GET(request: NextRequest) {
  if (request.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const siteRepo = new SiteRepo();
  const energyRepo = new EnergyRepo();
  const rollupRepo = new RollupRepo();
  const backfillRepo = new RollupBackfillRepo();
  const processed: Array<{ siteId: string }> = [];

  for (let i = 0; i < SITES_PER_TICK; i++) {
    const job = await backfillRepo.claimNext();
    if (!job) break;

    const client = await createSiteTeslaClient(job.site_id, TESLA_MAX_RETRY_DELAY_MS);
    if (!client) {
      await backfillRepo.markError(job.site_id, 'no Tesla tokens');
      continue;
    }
    const importer = new Importer(client);
    const rollupService = new RollupService({
      loadSite: async (id) => {
        const s = await siteRepo.getSite(id);
        if (!s) throw new Error(`site ${id} not found`);
        return { id: s.id, timezone: s.timezone, tariffs: s.tariffs ?? [] };
      },
      loadEnergyData: (id, start, end) => energyRepo.getRawEnergyData(id, start, end),
      getSeedTank: (id, beforeTs) => rollupRepo.getSeedTank(id, beforeTs),
      hasAnyRollup: (id) => rollupRepo.hasAnyRollup(id),
      upsertRollups: (rows) => rollupRepo.upsertRollups(rows),
    });

    const service = new BackfillService({
      loadSite: async (id) => {
        const s = await siteRepo.getSite(id);
        if (!s) throw new Error(`site ${id} not found`);
        return s;
      },
      fetchRange: (site, start, end) => importer.fetchRange(site, start, end, 'day') as Promise<EnergyData[]>,
      ensureData: async (id, start, end) => { await importer.ensureDataForRange(id, start, end); },
      rollupDay: (id, localDate, opts) => rollupService.rollupDay(id, localDate, opts),
      recordProgress: (id, cursor, done, anchored) => backfillRepo.recordProgress(id, cursor, done, anchored),
      markComplete: (id) => backfillRepo.markComplete(id),
      markError: (id, msg) => backfillRepo.markError(id, msg),
      retentionCutoff: () => new Date(Date.now() - RETENTION_DAYS * 86400_000),
      localDayBounds: (localDate, tz) => localDayBoundsUtc(localDate, tz),
      now: () => Date.now(),
    });

    await service.processSite(
      { siteId: job.site_id, oldestDate: job.oldest_date, cursorDate: job.cursor_date,
        newestDate: job.newest_date, daysDone: job.days_done, genesisAnchored: job.genesis_anchored },
      { daysPerTick: DAYS_PER_TICK, budgetMs: BUDGET_MS, concurrency: FETCH_CONCURRENCY },
    );
    processed.push({ siteId: job.site_id });
  }

  return NextResponse.json({ success: true, processed });
}
