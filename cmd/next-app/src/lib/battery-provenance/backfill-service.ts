import type { EnergyData, SiteWithTariffs } from '../db';
import { addLocalDays } from './local-day';

export interface BackfillJob {
  siteId: string;
  oldestDate: string;
  cursorDate: string;
  newestDate: string;
  daysDone: number;
  genesisAnchored: boolean;
}

export interface BackfillDeps {
  loadSite: (siteId: string) => Promise<SiteWithTariffs>;
  fetchRange: (site: SiteWithTariffs, start: Date, end: Date) => Promise<EnergyData[]>;
  ensureData: (siteId: string, start: Date, end: Date) => Promise<void>;
  rollupDay: (siteId: string, localDate: string, opts: { rows?: EnergyData[]; forceGenesisAtStart: boolean }) => Promise<{ genesisAnchored: boolean }>;
  recordProgress: (siteId: string, cursorDate: string, daysDone: number, genesisAnchored: boolean) => Promise<void>;
  markComplete: (siteId: string) => Promise<void>;
  markError: (siteId: string, message: string) => Promise<void>;
  retentionCutoff: () => Date;
  localDayBounds: (localDate: string, tz: string) => { start: Date; end: Date };
  now: () => number;
}

export interface TickOptions { daysPerTick: number; budgetMs: number; concurrency?: number; staggerMs?: number; }

export class BackfillService {
  constructor(private deps: BackfillDeps) {}

  async processSite(job: BackfillJob, opts: TickOptions): Promise<void> {
    const d = this.deps;
    let cursor = job.cursorDate;
    let daysDone = job.daysDone;
    let anchored = job.genesisAnchored;
    const startedAt = d.now();
    const concurrency = Math.max(1, opts.concurrency ?? 1);

    try {
      const site = await d.loadSite(job.siteId);
      let processed = 0;

      while (
        cursor <= job.newestDate &&
        processed < opts.daysPerTick &&
        d.now() - startedAt < opts.budgetMs
      ) {
        // Build the next batch of days (ascending), bounded by concurrency,
        // the remaining day-per-tick cap, and newest_date.
        const batch: Array<{ date: string; start: Date; end: Date; isOld: boolean }> = [];
        let scan = cursor;
        while (
          batch.length < concurrency &&
          processed + batch.length < opts.daysPerTick &&
          scan <= job.newestDate
        ) {
          const { start, end } = d.localDayBounds(scan, site.timezone);
          batch.push({ date: scan, start, end, isOld: end.getTime() < d.retentionCutoff().getTime() });
          scan = addLocalDays(scan, 1);
        }

        // Fetch every day in the batch concurrently, but optionaly staggered by staggerMs to prevent rate limits.
        // Pre-retention days return rows held in memory (never persisted); within-retention days are persisted via
        // ensureData and rolled up from the DB below.
        const fetched = await Promise.all(
          batch.map(async (day, index) => {
            if (index > 0 && opts.staggerMs && opts.staggerMs > 0) {
              await new Promise((resolve) => setTimeout(resolve, index * opts.staggerMs!));
            }
            if (day.isOld) return await d.fetchRange(site, day.start, day.end);
            await d.ensureData(site.id, day.start, day.end);
            return undefined;
          }),
        );

        // Roll up the batch sequentially to preserve tank-state continuity.
        for (let i = 0; i < batch.length; i++) {
          const day = batch[i];
          const forceGenesisAtStart = !anchored;
          const res = day.isOld
            ? await d.rollupDay(site.id, day.date, { rows: fetched[i], forceGenesisAtStart })
            : await d.rollupDay(site.id, day.date, { forceGenesisAtStart });
          if (!anchored && res.genesisAnchored) anchored = true;

          cursor = addLocalDays(day.date, 1);
          daysDone += 1;
          processed += 1;
          await d.recordProgress(site.id, cursor, daysDone, anchored);
        }
      }
      if (cursor > job.newestDate) await d.markComplete(site.id);
    } catch (e) {
      await d.markError(job.siteId, e instanceof Error ? e.message : String(e));
    }
  }
}
