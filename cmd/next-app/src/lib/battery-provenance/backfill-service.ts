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

export interface TickOptions { daysPerTick: number; budgetMs: number; }

export class BackfillService {
  constructor(private deps: BackfillDeps) {}

  async processSite(job: BackfillJob, opts: TickOptions): Promise<void> {
    const d = this.deps;
    let cursor = job.cursorDate;
    let daysDone = job.daysDone;
    let anchored = job.genesisAnchored;
    const startedAt = d.now();

    try {
      const site = await d.loadSite(job.siteId);
      let processed = 0;
      while (
        cursor <= job.newestDate &&
        processed < opts.daysPerTick &&
        d.now() - startedAt < opts.budgetMs
      ) {
        const { start, end } = d.localDayBounds(cursor, site.timezone);
        const forceGenesisAtStart = !anchored;

        let res: { genesisAnchored: boolean };
        if (end.getTime() < d.retentionCutoff().getTime()) {
          const rows = await d.fetchRange(site, start, end);          // Tesla → memory, never persisted
          res = await d.rollupDay(site.id, cursor, { rows, forceGenesisAtStart });
        } else {
          await d.ensureData(site.id, start, end);                    // persist recent EnergyData
          res = await d.rollupDay(site.id, cursor, { forceGenesisAtStart });
        }
        if (!anchored && res.genesisAnchored) anchored = true;

        cursor = addLocalDays(cursor, 1);
        daysDone += 1;
        processed += 1;
        await d.recordProgress(site.id, cursor, daysDone, anchored); // incremental commit
      }
      if (cursor > job.newestDate) await d.markComplete(site.id);
    } catch (e) {
      await d.markError(job.siteId, e instanceof Error ? e.message : String(e));
    }
  }
}
