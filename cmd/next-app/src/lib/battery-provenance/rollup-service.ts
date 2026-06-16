import { Schedule } from '../schedule';
import type { Tariff } from '../db';
import type { EnergyData } from '../db';
import { replayRows, type PeriodRollup } from './replay';
import { aggregateHourly, type HourlyBucket } from './hourly-profile';
import { computeGenesisSeed } from './genesis';
import { EMPTY_TANK, type Tank } from './tank';
import { localDayBoundsUtc } from './local-day';

export interface RollupSite {
    id: string;
    timezone: string;
    tariffs: Tariff[];
}

export interface RollupDeps {
    loadSite: (siteId: string) => Promise<RollupSite>;
    loadEnergyData: (siteId: string, start: Date, end: Date) => Promise<EnergyData[]>;
    getSeedTank: (siteId: string, beforeTs: Date) => Promise<{ tank: Tank; tankAsOf: Date } | null>;
    hasAnyRollup: (siteId: string) => Promise<boolean>;
    upsertRollups: (rows: PeriodRollup[]) => Promise<void>;
    upsertHourly: (rows: HourlyBucket[]) => Promise<void>;
}

export class RollupService {
    constructor(private deps: RollupDeps) {}

    /** Roll up a single local calendar day for one site. Idempotent.
     *  opts.rows  — roll up these in-memory rows instead of reading the DB (backfill fetch-only path).
     *  opts.forceGenesisAtStart — run computeGenesisSeed even if rollups already exist (backfill re-anchor). */
    async rollupDay(
        siteId: string,
        localDate: string,
        opts?: { rows?: EnergyData[]; forceGenesisAtStart?: boolean },
    ): Promise<{ rollupCount: number; genesisAnchored: boolean }> {
        const site = await this.deps.loadSite(siteId);
        const schedule = new Schedule(site.tariffs, site.timezone);
        const { start, end } = localDayBoundsUtc(localDate, site.timezone);

        const rows = opts?.rows ?? await this.deps.loadEnergyData(siteId, start, end);
        if (rows.length === 0) return { rollupCount: 0, genesisAnchored: false };

        const seedRow = await this.deps.getSeedTank(siteId, start);
        let seed: Tank = seedRow?.tank ?? EMPTY_TANK;
        let genesisAnchorTimestamp: Date | undefined;
        let genesisAnchored = false;

        if (opts?.forceGenesisAtStart || (!seedRow && !(await this.deps.hasAnyRollup(siteId)))) {
            const genesis = computeGenesisSeed(rows, schedule, site.timezone);
            if (genesis) {
                seed = genesis.seed;
                genesisAnchorTimestamp = genesis.anchorTimestamp;
                genesisAnchored = true;
            }
        }

        const { rollups } = replayRows(rows, schedule, site.timezone, seed, {
            genesisAnchorTimestamp,
        });
        const forDate = rollups.filter(r => r.localDate === localDate);
        await this.deps.upsertRollups(forDate);
        const hourly = aggregateHourly(rows, site.timezone).filter(b => b.localDate === localDate);
        await this.deps.upsertHourly(hourly);
        return { rollupCount: forDate.length, genesisAnchored };
    }
}
