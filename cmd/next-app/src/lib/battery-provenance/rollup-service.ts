import type { Tariff } from '../db';
import type { EnergyData } from '../db';
import { aggregateHourly, type HourlyBucket } from './hourly-profile';
import { localDayBoundsUtc } from './local-day';

export interface RollupSite {
    id: string;
    timezone: string;
    tariffs: Tariff[];
}

export interface RollupDeps {
    loadSite: (siteId: string) => Promise<RollupSite>;
    loadEnergyData: (siteId: string, start: Date, end: Date) => Promise<EnergyData[]>;
    upsertHourly: (rows: HourlyBucket[]) => Promise<void>;
}

export class RollupService {
    constructor(private deps: RollupDeps) {}

    /** Build the hourly profile for a single local calendar day. Idempotent.
     *  opts.rows — aggregate these in-memory rows instead of reading the DB (backfill fetch-only path).
     *  opts.forceGenesisAtStart — accepted for BackfillService compatibility; no longer used.
     *    Battery provenance is computed on read (Phase C2), so genesis seeding was removed;
     *    genesisAnchored is always false. */
    async rollupDay(
        siteId: string,
        localDate: string,
        opts?: { rows?: EnergyData[]; forceGenesisAtStart?: boolean },
    ): Promise<{ rollupCount: number; genesisAnchored: boolean }> {
        const site = await this.deps.loadSite(siteId);
        const { start, end } = localDayBoundsUtc(localDate, site.timezone);

        const rows = opts?.rows ?? await this.deps.loadEnergyData(siteId, start, end);
        if (rows.length === 0) return { rollupCount: 0, genesisAnchored: false };

        const hourly = aggregateHourly(rows, site.timezone).filter(b => b.localDate === localDate);
        await this.deps.upsertHourly(hourly);
        return { rollupCount: hourly.length, genesisAnchored: false };
    }
}
