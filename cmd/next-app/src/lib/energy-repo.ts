import { buildBillOutlookHistory, type BillOutlookHistory, type BillOutlookDay } from './bill-outlook-history';
import { pool, Tariff, EnergyData, TariffSchedule } from './db';
import { wattsToKilowatts } from './energy-utils';
import { priceBillUsage } from './bill-pricing';
import { getSiteMidnight } from './date-utils';

import { Schedule } from './schedule';
import { SiteRepo } from './site-repo';
import { TariffRepo } from './tariff-repo';
import {SETTLED_ARCHIVE_DAY_SQL} from './prototypes/compact-history-store';
import type {Pool} from 'pg';

export interface LatestEnergySnapshot {timestamp:Date;batterySoc:number|null;batteryPower:number;solarPower:number;gridPower:number;loadPower:number}
export interface LatestBatterySoc {timestamp:Date;value:number}

export interface UsageData {
    start: Date;
    homeUsage: number;
    gridUsage: number;
    solarProduction: number;
    batteryChange: number;
    tariff: Tariff;
    touName?: string;
    cost?: number;
    buyRate?: number;
    sellRate?: number;
}

/**
 * Per-site-local-day coverage summary of the 5-minute `EnergyData` rows that
 * already exist in a window. Replaces shipping every raw timestamp to the
 * client: one row per local day carries enough to reconstruct coverage.
 */
export interface DailyCoverageStat {
    localDayKey: string;
    count: number;
    first: Date | null;
    last: Date | null;
    maxInteriorGapMs: number;
    /**
     * Set by compact reads: the day is a settled archive (see
     * `SETTLED_ARCHIVE_DAY_SQL`), so planning treats it as covered even when
     * its samples have gaps Tesla never filled.
     */
    archived?: boolean;
    /** Set by compact reads: a v2 day record still `open` (today, or a recent day short of samples). */
    open?: boolean;
    /** Set by compact reads: when a v2 day record was fetched from Tesla. */
    fetchedAt?: Date;
}

export interface CycleAggregateRow {
    day: Date;
    tariff_id: number;
    tariff_schedule_id: number | null;
    load_power: number;
    solar_power: number;
    grid_power: number;
    battery_power: number;
}

export interface UsageByTOUAggregationInputs {
    siteId: string;
    start: Date;
    priorAggregates: CycleAggregateRow[];
    todayRaw: EnergyData[];
    schedule: Schedule;
    tariffMap: Map<number, Tariff>;
    scheduleMap: Map<number, TariffSchedule>;
}

/**
 * Canonical "today so far" scalar totals. Single source of truth — both the
 * live page and the Trmnl markup endpoint compute these from the same
 * `EnergyData` rows via `sumTodayRows`, so the two surfaces never disagree.
 *
 * Sign convention: positive grid = importing, negative = exporting. The
 * gross splits (`importKwh` / `exportKwh`) are always non-negative magnitudes
 * for display; `gridNetKwh = importKwh - exportKwh`.
 */
export interface TodayTotals {
    homeKwh: number;
    solarKwh: number;
    gridNetKwh: number;
    importKwh: number;
    exportKwh: number;
    batteryNetKwh: number;
    latestBatterySoc: number | null;
}

const EMPTY_TODAY_TOTALS: TodayTotals = {
    homeKwh: 0, solarKwh: 0, gridNetKwh: 0,
    importKwh: 0, exportKwh: 0, batteryNetKwh: 0,
    latestBatterySoc: null
};

/**
 * Sum a set of 5-minute `EnergyData` rows into `TodayTotals` (kWh). Each row
 * stores energy (Wh) for its interval, so summing the columns and dividing
 * by 1000 produces total kWh for the range. Import/export are split by the
 * sign of each row's `grid_power` before conversion.
 */
export function sumTodayRows(rows: EnergyData[]): TodayTotals {
    if (rows.length === 0) return { ...EMPTY_TODAY_TOTALS };

    let homeWh = 0;
    let solarWh = 0;
    let gridNetWh = 0;
    let importWh = 0;
    let exportWh = 0;
    let batteryWh = 0;
    let latestSoc: { value: number; timestamp: Date } | null = null;

    for (const row of rows) {
        homeWh += row.load_power;
        solarWh += row.solar_power;
        gridNetWh += row.grid_power;
        if (row.grid_power > 0) importWh += row.grid_power;
        else if (row.grid_power < 0) exportWh += -row.grid_power;
        batteryWh += row.battery_power;
        if (typeof row.battery_soc === 'number'
            && (!latestSoc || row.timestamp > latestSoc.timestamp)) {
            latestSoc = { value: row.battery_soc, timestamp: row.timestamp };
        }
    }

    return {
        homeKwh: wattsToKilowatts(homeWh),
        solarKwh: wattsToKilowatts(solarWh),
        gridNetKwh: wattsToKilowatts(gridNetWh),
        importKwh: wattsToKilowatts(importWh),
        exportKwh: wattsToKilowatts(exportWh),
        batteryNetKwh: wattsToKilowatts(batteryWh),
        latestBatterySoc: latestSoc?.value ?? null
    };
}


/** Read backend: day records (`CompactHistoryReader`), the only energy store. */
export interface CycleAggregatesAndCoverage { aggregates:CycleAggregateRow[];coverage:DailyCoverageStat[] }
export interface EnergyHistoryReader {
    getLatestEnergyData(siteId:string,asOf?:Date):Promise<LatestEnergySnapshot|null>;
    getLatestBatterySoc(siteId:string,since:Date):Promise<LatestBatterySoc|null>;
    getLatestTimestamp(siteId:string):Promise<Date|null>;
    getCycleAggregatesAndCoverage(siteId:string,start:Date,end:Date,timezone:string):Promise<CycleAggregatesAndCoverage>;
    getDailyCoverage(siteId: string, start: Date, end: Date, timezone: string): Promise<DailyCoverageStat[]>;
    hasData(siteId: string): Promise<boolean>;
    getRawEnergyData(siteId: string, start: Date, end: Date): Promise<EnergyData[]>;
    getCycleAggregates(siteId: string, start: Date, end: Date, timezone?: string): Promise<CycleAggregateRow[]>;
    getBucketedEnergyData(siteId: string, start: Date, end: Date): Promise<EnergyData[]>;
}

export class EnergyRepo {
    constructor(private readonly historyReader: EnergyHistoryReader) {}

    /**
     * Helper to get site-timezone midnight as a global Date object (UTC timestamp)
     */
    static getSiteMidnight(d: Date, tz: string): Date {
        return getSiteMidnight(d, tz);
    }

// === Queries ===
    async getCycleAggregatesAndCoverage(siteId:string,start:Date,end:Date,timezone:string):Promise<CycleAggregatesAndCoverage> {
        return this.historyReader.getCycleAggregatesAndCoverage(siteId,start,end,timezone);
    }

    async getLatestTimestamp(siteId: string): Promise<Date | null> {
        return this.historyReader.getLatestTimestamp(siteId);
    }

    /** One row per site-local day in [start, end) describing the stored samples (see `DailyCoverageStat`). */
    async getDailyCoverage(siteId: string, start: Date, end: Date, timezone: string): Promise<DailyCoverageStat[]> {
        return this.historyReader.getDailyCoverage(siteId,start,end,timezone);
    }

    /**
     * Stored samples on a 5-minute mark within each site's [start, end), for all
     * sites in one query. A count equal to the number of 5-minute slots means the
     * window has no gaps. A settled day record (`SETTLED_ARCHIVE_DAY_SQL`) counts
     * as all of its slots, since planning treats it as covered. Any other record
     * counts its `sample_count` when every sample is on the 5-minute grid
     * (`axis = 'grid'`); an off-grid day counts nothing, so the coverage audit
     * decides. Windows are site-local midnights, so records lie wholly inside them.
     */
    static async countAlignedSamples(
        windows: Array<{ siteId: string; start: Date; end: Date }>,
        database: Pick<Pool, 'query'> = pool
    ): Promise<Map<string, number>> {
        if (windows.length === 0) return new Map();
        const res = await database.query(
            `WITH w AS (
    SELECT * FROM unnest($1::text[], $2::timestamptz[], $3::timestamptz[]) AS w(site_id, start_ts, end_ts)
)
SELECT w.site_id, (
    SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (a.day_end - a.day_start))::int / 300), 0)::int
    FROM "EnergyDayArchive" a
    WHERE a.site_id = w.site_id
      AND a.day_start >= w.start_ts
      AND a.day_end <= w.end_ts
      AND ${SETTLED_ARCHIVE_DAY_SQL}
) + (
    SELECT COALESCE(SUM(a.sample_count), 0)::int
    FROM "EnergyDayArchive" a
    WHERE a.site_id = w.site_id
      AND a.day_start >= w.start_ts
      AND a.day_end <= w.end_ts
      AND a.axis = 'grid'
      AND NOT ${SETTLED_ARCHIVE_DAY_SQL}
) AS n
FROM w`,
            [windows.map(w => w.siteId), windows.map(w => w.start.toISOString()), windows.map(w => w.end.toISOString())]
        );
        return new Map(res.rows.map((r: { site_id: string; n: string | number }) => [r.site_id, Number(r.n)]));
    }

    private async usageContext(siteId:string) {

        const siteRepo = new SiteRepo();
        const site = await siteRepo.getSite(siteId);
        if (!site) return null;

        // Name-resolution map must cover ALL tariff versions: historical EnergyData
        // rows keep an older version's tariff_id and would otherwise show 'Unknown'.
        // Historical aggregates retain their resolved rates; today uses Schedule.
        const tariffRepo = new TariffRepo();
        const [allVersions, allSchedules] = await Promise.all([
            tariffRepo.getTariffsForSite(siteId),
            tariffRepo.getSchedulesForSite(siteId),
        ]);
        const { tariffMap, scheduleMap } = EnergyRepo.buildTariffLookupMaps(site.tariffs, allVersions, allSchedules);
        const schedule = new Schedule(site.tariffs, site.timezone);

        return {siteId,timezone:site.timezone,schedule,tariffMap,scheduleMap};
    }

    async getUsageByTOU(siteId: string, start: Date, end: Date): Promise<UsageData[]> {
        const context=await this.usageContext(siteId);
        if(!context)return [];
        // Calculate site-local "today" boundary and split point, clamped to
        // [start, end]. Without the lower clamp, a request for a cycle that
        // starts in the future fetches raw rows from today's midnight up to
        // `end` — rows that precede the requested range.
        const now = new Date();
        const todayStart = EnergyRepo.getSiteMidnight(now, context.timezone);
        const splitPoint = new Date(
            Math.max(start.getTime(), Math.min(todayStart.getTime(), end.getTime()))
        );

        // Fetch prior aggregates and today's raw data in parallel
        const [priorAggregates, todayRaw] = await Promise.all([
            this.getCycleAggregates(siteId, start, splitPoint),
            this.getRawEnergyData(siteId, splitPoint, end)
        ]);

        return EnergyRepo.aggregateUsageByTOU({
            ...context,start,priorAggregates,todayRaw
        });
    }

    /** One bounded read for recorded bill history and the current total. No Tesla requests. */
    async getBillOutlook(siteId: string, start: Date, end: Date): Promise<{ usage: UsageData[]; outlook: BillOutlookHistory | null }> {
        const context = await this.usageContext(siteId);
        if (!context) return { usage: [], outlook: null };
        const now = new Date();
        const stop = new Date(Math.min(+now, +end));
        const split = new Date(Math.max(+start, Math.min(+EnergyRepo.getSiteMidnight(now, context.timezone), +stop)));
        const [prior, raw] = await Promise.all([
            start < split ? this.getCycleAggregatesAndCoverage(siteId, start, split, context.timezone)
                : Promise.resolve({ aggregates: [], coverage: [] }),
            split < stop ? this.getRawEnergyData(siteId, split, stop) : Promise.resolve([]),
        ]);
        const usage = EnergyRepo.aggregateUsageByTOU({ ...context, start, priorAggregates: prior.aggregates, todayRaw: raw });
        const last = Math.max(...prior.coverage.flatMap(day => day.last ? [+day.last] : []), ...raw.map(row => +row.timestamp));
        if (!Number.isFinite(last) || last < +start) return { usage, outlook: null };
        const cutoff = new Date(Math.min(last + 300_000, +end));
        const days: BillOutlookDay[] = [{ date: start.toISOString(), buckets: [], complete: true }];
        for (let day = start; day < cutoff;) {
            // 36 hours from local midnight always falls on the following local day, including DST.
            const next = EnergyRepo.getSiteMidnight(new Date(+day + 36 * 3600_000), context.timezone);
            const through = new Date(Math.min(+next, +cutoff));
            const aggregates = prior.aggregates.filter(row => row.day >= day && row.day < through);
            const rows = raw.filter(row => row.timestamp >= day && row.timestamp < through);
            const coverage = prior.coverage.find(row => row.first && row.first >= day && row.first < through);
            const expected = Math.round((+through - +day) / 300_000);
            const count = day < split ? coverage?.count ?? 0 : new Set(rows.map(row => +row.timestamp)).size;
            const totals = EnergyRepo.aggregateUsageByTOU({ ...context, start, priorAggregates: aggregates, todayRaw: rows });
            days.push({ date: through.toISOString(), complete: count === expected && expected > 0
                && (coverage?.maxInteriorGapMs ?? 0) <= 300_000,
                buckets: totals.map(row => ({ tariffName: row.tariff.name || 'Unknown', periodName: row.touName || 'Unknown',
                    netGridKwh: row.gridUsage / 1000, buyRate: row.buyRate ?? 0, sellRate: row.sellRate ?? 0 })) });
            day = next;
        }
        const points = buildBillOutlookHistory(days);
        return { usage, outlook: { points, observedThrough: cutoff.toISOString(), complete: points.at(-1)?.complete ?? false } };
    }

    /**
     * Build the tariff/schedule name-resolution maps from already-fetched
     * version lists. All versions matter: historical EnergyData rows keep an
     * older version's tariff_id and would otherwise resolve to 'Unknown'.
     */
    static buildTariffLookupMaps(
        siteTariffs: Tariff[],
        allVersions: Tariff[],
        allSchedules: TariffSchedule[]
    ): { tariffMap: Map<number, Tariff>; scheduleMap: Map<number, TariffSchedule> } {
        const tariffMap = new Map<number, Tariff>();
        allVersions.forEach(t => tariffMap.set(t.id, t));
        siteTariffs.forEach(t => tariffMap.set(t.id, t));

        const scheduleMap = new Map<number, TariffSchedule>();
        siteTariffs.forEach(t => {
            t.seasons?.forEach(season => {
                season.schedules?.forEach(s => scheduleMap.set(s.id, s));
            });
        });
        allSchedules.forEach(s => scheduleMap.set(s.id, s));

        return { tariffMap, scheduleMap };
    }

    /**
     * Pure aggregation core of getUsageByTOU: groups cycle aggregates and
     * today's raw rows by (tariff, TOU period, rates), then nets costs across
     * rate buckets within each tariff/TOU name for the requested bill window.
     * Exposed so callers that already fetched the inputs (the TRMNL markup
     * route) can aggregate without re-running the same queries.
     */
    static aggregateUsageByTOU(inputs: UsageByTOUAggregationInputs): UsageData[] {
        const { siteId, start, priorAggregates, todayRaw, schedule, tariffMap, scheduleMap } = inputs;
        const aggregation = new Map<string, UsageData>();

        // Pass 1: Prior day aggregates (use tariff_schedule_id for TOU lookup)
        for (const row of priorAggregates) {
            let touName = 'Unknown';
            let buyRate = 0;
            let sellRate = 0;

            if (row.tariff_schedule_id != null) {
                const sched = scheduleMap.get(row.tariff_schedule_id);
                if (sched) {
                    touName = sched.name || 'Standard';
                    const season = tariffMap.get(row.tariff_id)?.seasons?.find(s => s.id === sched.season_id);
                    buyRate = sched.buy_rate ?? season?.buy_rate ?? 0;
                    sellRate = sched.sell_rate ?? season?.sell_rate ?? 0;
                }
            } else {
                const midpoint = new Date(row.day.getTime() + 12 * 60 * 60 * 1000);
                const tp = schedule.getTariffPeriod(midpoint);
                if (tp) {
                    touName = tp.schedule.name || 'Standard';
                    buyRate = tp.schedule.buy_rate ?? tp.season.buy_rate ?? 0;
                    sellRate = tp.schedule.sell_rate ?? tp.season.sell_rate ?? 0;
                }
            }

            const tariff = tariffMap.get(row.tariff_id) || {
                id: row.tariff_id,
                site_id: siteId,
                name: 'Unknown',
                updated: new Date()
            };
            const tariffName = tariff.name || 'Unknown';
            const key = JSON.stringify([tariffName, touName, buyRate, sellRate]);

            let data = aggregation.get(key);
            if (!data) {
                data = {
                    start: start,
                    homeUsage: 0,
                    gridUsage: 0,
                    solarProduction: 0,
                    batteryChange: 0,
                    tariff: tariff,
                    touName: touName,
                    cost: 0,
                    buyRate: buyRate,
                    sellRate: sellRate
                };
                aggregation.set(key, data);
            }

            data.homeUsage += row.load_power;
            data.gridUsage += row.grid_power;
            data.solarProduction += row.solar_power;
            data.batteryChange += row.battery_power;
        }

        // Pass 2: Today's raw rows (use Schedule.getTariffPeriod for TOU lookup)
        for (const row of todayRaw) {
            const ts = row.timestamp;
            const tp = schedule.getTariffPeriod(ts);

            let touName = 'Unknown';
            let tariffName = 'Unknown';
            let buyRate = 0;
            let sellRate = 0;
            let currentTariff: Tariff | undefined;

            if (tp) {
                touName = tp.schedule.name || 'Standard';
                tariffName = tp.tariff.name || 'Unknown';
                buyRate = tp.schedule.buy_rate ?? tp.season.buy_rate ?? 0;
                sellRate = tp.schedule.sell_rate ?? tp.season.sell_rate ?? 0;
                currentTariff = tp.tariff;
            } else {
                const t = tariffMap.get(row.tariff_id) || {
                    id: row.tariff_id,
                    site_id: siteId,
                    name: 'Unknown',
                    updated: new Date()
                };
                tariffName = t.name || 'Unknown';
                currentTariff = t;
            }

            const key = JSON.stringify([tariffName, touName, buyRate, sellRate]);

            let data = aggregation.get(key);
            if (!data) {
                data = {
                    start: start,
                    homeUsage: 0,
                    gridUsage: 0,
                    solarProduction: 0,
                    batteryChange: 0,
                    tariff: currentTariff,
                    touName: touName,
                    cost: 0,
                    buyRate: buyRate,
                    sellRate: sellRate
                };
                aggregation.set(key, data);
            }

            data.homeUsage += row.load_power;
            data.gridUsage += row.grid_power;
            data.solarProduction += row.solar_power;
            data.batteryChange += row.battery_power;
        }

        // The billing balance spans seasonal and version rate changes.
        priceBillUsage(Array.from(aggregation.values()));

        return Array.from(aggregation.values());
    }

    /**
     * Returns both billing-cycle totals and today's totals in a single call,
     * keyed by TOU period name (via getUsageByTOU). Used by the live detail
     * page to compute marginal cost per period and show today's contribution.
     */
    async getCycleAndTodayTotals(
        siteId: string,
        cycleStart: Date,
        todayStart: Date,
        end: Date
    ): Promise<{ cycle: UsageData[]; today: UsageData[] }> {
        const context=await this.usageContext(siteId);
        if(!context)return {cycle:[],today:[]};
        const midnight=EnergyRepo.getSiteMidnight(new Date(),context.timezone);
        const split=(start:Date)=>new Date(Math.max(+start,Math.min(+midnight,+end)));
        const cycleSplit=split(cycleStart),todaySplit=split(todayStart);
        const cyclePrior=cycleStart<cycleSplit?this.getCycleAggregates(siteId,cycleStart,cycleSplit):Promise.resolve([]);
        const todayPrior=+todayStart===+cycleStart?cyclePrior:todayStart<todaySplit?this.getCycleAggregates(siteId,todayStart,todaySplit):Promise.resolve([]);
        const rawStart=new Date(Math.min(+cycleSplit,+todaySplit));
        const [cycleAggregates,todayAggregates,raw]=await Promise.all([cyclePrior,todayPrior,
            rawStart<end?this.getRawEnergyData(siteId,rawStart,end):Promise.resolve([])]);
        // Net the cycle and today independently; a cycle credit cannot price today's usage.
        return {
            cycle:EnergyRepo.aggregateUsageByTOU({...context,start:cycleStart,priorAggregates:cycleAggregates,
                todayRaw:raw.filter(r=>r.timestamp>=cycleSplit && r.timestamp<end)}),
            today:EnergyRepo.aggregateUsageByTOU({...context,start:todayStart,priorAggregates:todayAggregates,
                todayRaw:raw.filter(r=>r.timestamp>=todaySplit && r.timestamp<end)})
        };
    }

    /**
     * Canonical "today so far" totals. Fetches the raw 5-minute rows once and
     * runs them through `sumTodayRows`. Both the live page and the Trmnl
     * markup route call this (or `sumTodayRows` directly on rows they already
     * have) — there should not be a third place that re-derives these.
     */
    async getTodayTotals(siteId: string, todayStart: Date, end: Date): Promise<TodayTotals> {
        const rows = await this.getRawEnergyData(siteId, todayStart, end);
        return sumTodayRows(rows);
    }

    async hasData(siteId: string): Promise<boolean> {
        return this.historyReader.hasData(siteId);
    }

    async getLatestEnergyData(siteId:string,asOf?:Date):Promise<LatestEnergySnapshot|null> {
        return this.historyReader.getLatestEnergyData(siteId,asOf);
    }

    /** Only used when live status has no usable charge value. */
    async getLatestBatterySoc(siteId: string, since: Date): Promise<LatestBatterySoc | null> {
        return this.historyReader.getLatestBatterySoc(siteId,since);
    }

    async getCycleAggregates(siteId: string, start: Date, end: Date, timezone?: string): Promise<CycleAggregateRow[]> {
        return this.historyReader.getCycleAggregates(siteId, start, end, timezone);
    }

    async getRawEnergyData(siteId: string, start: Date, end: Date): Promise<EnergyData[]> {
        return this.historyReader.getRawEnergyData(siteId, start, end);
    }

    async getBucketedEnergyData(siteId: string, start: Date, end: Date): Promise<EnergyData[]> {
        return this.historyReader.getBucketedEnergyData(siteId, start, end);
    }
}
