import { Schedule } from '../schedule';
import type { Tariff } from '../db';
import type { EnergyData } from '../db';
import { replayRows, type PeriodRollup } from './replay';
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
}

export class RollupService {
    constructor(private deps: RollupDeps) {}

    /** Roll up a single local calendar day for one site. Idempotent. */
    async rollupDay(siteId: string, localDate: string): Promise<{ rollupCount: number }> {
        const site = await this.deps.loadSite(siteId);
        const schedule = new Schedule(site.tariffs, site.timezone);
        const { start, end } = localDayBoundsUtc(localDate, site.timezone);

        const rows = await this.deps.loadEnergyData(siteId, start, end);
        if (rows.length === 0) return { rollupCount: 0 };

        const seedRow = await this.deps.getSeedTank(siteId, start);
        let seed: Tank = seedRow?.tank ?? EMPTY_TANK;
        let dayRows = rows;

        // Genesis: no prior rollup anywhere → anchor on a full battery.
        if (!seedRow && !(await this.deps.hasAnyRollup(siteId))) {
            const genesis = computeGenesisSeed(rows, schedule, site.timezone);
            if (genesis) {
                seed = genesis.seed;
                dayRows = rows.slice(genesis.anchorIndex);
            }
        }

        const { rollups } = replayRows(dayRows, schedule, site.timezone, seed);
        const forDate = rollups.filter(r => r.localDate === localDate);
        await this.deps.upsertRollups(forDate);
        return { rollupCount: forDate.length };
    }
}
