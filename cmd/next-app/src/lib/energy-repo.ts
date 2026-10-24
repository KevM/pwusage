import { buildBillOutlookHistory, type BillOutlookHistory, type BillOutlookDay } from './bill-outlook-history';
import {energyQueryExecutor,withRawEnergyAccess} from './energy-storage-access';
import type {EnergyWrite} from './prototypes/compact-energy-recovery';
import { pool, Tariff, EnergyData, TariffSchedule } from './db';
import { wattsToKilowatts } from './energy-utils';
import { priceBillUsage } from './bill-pricing';
import { getSiteMidnight, getValidTimezone } from './date-utils';

import { Schedule } from './schedule';
import { SiteRepo } from './site-repo';
import { TariffRepo } from './tariff-repo';
import {CompactHistoryStore,SETTLED_ARCHIVE_DAY_SQL} from './prototypes/compact-history-store';
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


/** Optional read backend. Production keeps SQL until an archive store is explicitly supplied. */
export interface CycleAggregatesAndCoverage { aggregates:CycleAggregateRow[];coverage:DailyCoverageStat[] }
export interface EnergyHistoryReader {
    getLatestEnergyData?(siteId:string,asOf?:Date):Promise<LatestEnergySnapshot|null>;
    getLatestBatterySoc?(siteId:string,since:Date):Promise<LatestBatterySoc|null>;
    getLatestTimestamp?(siteId:string):Promise<Date|null>;
    getCycleAggregatesAndCoverage?(siteId:string,start:Date,end:Date,timezone:string):Promise<CycleAggregatesAndCoverage>;
    getDailyCoverage?(siteId: string, start: Date, end: Date, timezone: string): Promise<DailyCoverageStat[]>;
    hasData?(siteId: string): Promise<boolean>;
    getRawEnergyData(siteId: string, start: Date, end: Date): Promise<EnergyData[]>;
    getCycleAggregates(siteId: string, start: Date, end: Date, timezone?: string): Promise<CycleAggregateRow[]>;
    getBucketedEnergyData(siteId: string, start: Date, end: Date): Promise<EnergyData[]>;
}

export class EnergyRepo {
    constructor(private readonly historyReader?: EnergyHistoryReader) {}

    /**
     * Helper to get site-timezone midnight as a global Date object (UTC timestamp)
     */
    static getSiteMidnight(d: Date, tz: string): Date {
        return getSiteMidnight(d, tz);
    }

// === Queries ===
    async getCycleAggregatesAndCoverage(siteId:string,start:Date,end:Date,timezone:string):Promise<CycleAggregatesAndCoverage> {
        if (this.historyReader?.getCycleAggregatesAndCoverage) return this.historyReader.getCycleAggregatesAndCoverage(siteId,start,end,timezone);
        const [aggregates,coverage]=await Promise.all([this.getCycleAggregates(siteId,start,end,timezone),this.getDailyCoverage(siteId,start,end,timezone)]);
        return {aggregates,coverage};
    }

    async getLatestTimestamp(siteId: string): Promise<Date | null> {
        if(this.historyReader?.getLatestTimestamp) return this.historyReader.getLatestTimestamp(siteId);
        const res = await energyQueryExecutor().query(
            'SELECT MAX(timestamp) as timestamp FROM "EnergyData" WHERE site_id = $1 AND timestamp <= NOW() at time zone \'UTC\'',
            [siteId]
        );
        const ts = res.rows[0]?.timestamp;
        return ts ? new Date(ts) : null;
    }

    /**
     * Summarize existing 5-minute rows in [start, end) as one row per
     * site-local day. Day boundaries are computed server-side with an explicit
     * `AT TIME ZONE`, so they never depend on the session timezone. `count`,
     * `first` and `last` describe what is already stored; `maxInteriorGapMs` is
     * the largest gap *between* consecutive rows of that local day, used to
     * detect real holes rather than the expected open edges of a day.
     */
    async getDailyCoverage(siteId: string, start: Date, end: Date, timezone: string): Promise<DailyCoverageStat[]> {
        if (this.historyReader?.getDailyCoverage) return this.historyReader.getDailyCoverage(siteId,start,end,timezone);
        const tz = getValidTimezone(timezone);
        const res = await energyQueryExecutor().query(
            `WITH s AS (
    SELECT
        timestamp,
        date_trunc('day', timestamp AT TIME ZONE $4::text) AS local_day,
        LAG(timestamp) OVER (
            PARTITION BY date_trunc('day', timestamp AT TIME ZONE $4::text)
            ORDER BY timestamp
        ) AS prev_ts
    FROM "EnergyData"
    WHERE site_id = $1
      AND timestamp >= $2
      AND timestamp < $3
)
SELECT
    to_char(local_day, 'YYYY-MM-DD') AS local_day_key,
    COUNT(*)::int AS count,
    MIN(timestamp) AS first,
    MAX(timestamp) AS last,
    COALESCE(MAX(EXTRACT(EPOCH FROM (timestamp - COALESCE(prev_ts, timestamp)))), 0) AS max_gap_sec
FROM s
GROUP BY local_day
ORDER BY local_day`,
            [siteId, start.toISOString(), end.toISOString(), tz]
        );
        return res.rows.map((r: { local_day_key: string; count: string | number; first: string | Date | null; last: string | Date | null; max_gap_sec: string | number }) => ({
            localDayKey: r.local_day_key,
            count: Number(r.count),
            first: r.first ? new Date(r.first) : null,
            last: r.last ? new Date(r.last) : null,
            maxInteriorGapMs: Number(r.max_gap_sec) * 1000,
        }));
    }

    /**
     * Stored samples on a 5-minute mark within each site's [start, end), for all
     * sites in one query. Rows are unique per (timestamp, site_id), so a count
     * equal to the number of 5-minute slots means the window has no gaps. A
     * settled archive day (`SETTLED_ARCHIVE_DAY_SQL`) counts as all of its slots,
     * since planning treats it as covered even once its raw rows are trimmed;
     * windows are site-local midnights, so such days lie wholly inside them.
     */
    async countAlignedSamples(
        windows: Array<{ siteId: string; start: Date; end: Date }>,
        database: Pick<Pool, 'query'> = energyQueryExecutor()
    ): Promise<Map<string, number>> {
        if (windows.length === 0) return new Map();
        const res = await database.query(
            `WITH w AS (
    SELECT * FROM unnest($1::text[], $2::timestamptz[], $3::timestamptz[]) AS w(site_id, start_ts, end_ts)
)
SELECT w.site_id, (
    SELECT COUNT(*)::int FROM "EnergyData" e
    WHERE e.site_id = w.site_id
      AND e.timestamp >= w.start_ts
      AND e.timestamp < w.end_ts
      AND EXTRACT(EPOCH FROM e.timestamp)::bigint % 300 = 0
      AND NOT EXISTS (
          SELECT 1 FROM "EnergyDayArchive" a
          WHERE a.site_id = e.site_id AND e.timestamp >= a.day_start AND e.timestamp < a.day_end
            AND ${SETTLED_ARCHIVE_DAY_SQL})
) + (
    SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (a.day_end - a.day_start))::int / 300), 0)::int
    FROM "EnergyDayArchive" a
    WHERE a.site_id = w.site_id
      AND a.day_start >= w.start_ts
      AND a.day_end <= w.end_ts
      AND ${SETTLED_ARCHIVE_DAY_SQL}
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
        if (this.historyReader?.hasData) return this.historyReader.hasData(siteId);
        const { rows } = await energyQueryExecutor().query('SELECT 1 FROM "EnergyData" WHERE site_id = $1 LIMIT 1', [siteId]);
        return rows.length > 0;
    }

    async getLatestEnergyData(siteId:string,asOf?:Date):Promise<LatestEnergySnapshot|null> {
        if(this.historyReader?.getLatestEnergyData)return this.historyReader.getLatestEnergyData(siteId,asOf);
        const timestampLimit = asOf ? 'AND timestamp <= $2' : '';
        const params = asOf ? [siteId, asOf] : [siteId];
        const { rows } = await energyQueryExecutor().query(`
            SELECT timestamp, battery_soc, battery_power, solar_power, grid_power, load_power
            FROM "EnergyData"
            WHERE site_id = $1
            ${timestampLimit}
            ORDER BY timestamp DESC
            LIMIT 1
        `, params);

        if (rows.length === 0) return null;
        return {
            timestamp: new Date(rows[0].timestamp),
            batterySoc: rows[0].battery_soc === null || rows[0].battery_soc === undefined
                ? null
                : Number(rows[0].battery_soc),
            batteryPower: Number(rows[0].battery_power),
            solarPower: Number(rows[0].solar_power),
            gridPower: Number(rows[0].grid_power),
            loadPower: Number(rows[0].load_power),
        };
    }

    /** One indexed row, only used when live status has no usable charge value. */
    async getLatestBatterySoc(siteId: string, since: Date): Promise<LatestBatterySoc | null> {
        if(this.historyReader?.getLatestBatterySoc)return this.historyReader.getLatestBatterySoc(siteId,since);
        const { rows } = await energyQueryExecutor().query(`
            SELECT timestamp, battery_soc
            FROM "EnergyData"
            WHERE site_id = $1 AND timestamp >= $2 AND battery_soc IS NOT NULL
            ORDER BY timestamp DESC
            LIMIT 1
        `, [siteId, since]);
        if (rows.length === 0) return null;
        return { value: Number(rows[0].battery_soc), timestamp: new Date(rows[0].timestamp) };
    }

    async getCycleAggregates(
        siteId: string, start: Date, end: Date, timezone?: string
    ): Promise<CycleAggregateRow[]> {
        if (this.historyReader) return this.historyReader.getCycleAggregates(siteId, start, end, timezone);
        const queryStart = Date.now();
        const res = await energyQueryExecutor().query(`
            SELECT
                ${timezone ? "date_trunc('day', timestamp, $4::text)" : "date_trunc('day', timestamp)"} AS day,
                tariff_id,
                tariff_schedule_id,
                SUM(load_power) AS load_power,
                SUM(solar_power) AS solar_power,
                SUM(grid_power) AS grid_power,
                SUM(battery_power) AS battery_power
            FROM "EnergyData"
            WHERE site_id = $1 AND timestamp >= $2 AND timestamp < $3
            GROUP BY day, tariff_id, tariff_schedule_id
            ORDER BY day ASC
        `, timezone ? [siteId, start, end, getValidTimezone(timezone)] : [siteId, start, end]);
        const queryDuration = Date.now() - queryStart;
        console.log(`[EnergyRepo] getCycleAggregates: Query = ${queryDuration}ms, Rows = ${res.rows.length}`);

        return res.rows.map(row => ({
            day: new Date(row.day),
            tariff_id: Number(row.tariff_id),
            tariff_schedule_id: row.tariff_schedule_id == null ? null : Number(row.tariff_schedule_id),
            load_power: Number(row.load_power),
            solar_power: Number(row.solar_power),
            grid_power: Number(row.grid_power),
            battery_power: Number(row.battery_power),
        }));
    }

    async getRawEnergyData(siteId: string, start: Date, end: Date): Promise<EnergyData[]> {
        if (this.historyReader) return this.historyReader.getRawEnergyData(siteId, start, end);
        if (start.getTime() >= end.getTime()) return [];
        const queryStart = Date.now();
        const res = await energyQueryExecutor().query(`
            SELECT site_id, timestamp, tariff_id, tariff_schedule_id, load_power, solar_power, grid_power, battery_power, battery_soc
            FROM "EnergyData"
            WHERE site_id = $1
            AND timestamp >= $2
            AND timestamp < $3
            ORDER BY timestamp ASC
        `, [siteId, start, end]);
        const queryDuration = Date.now() - queryStart;
        console.log(`[EnergyRepo] getRawEnergyData: Query = ${queryDuration}ms, Rows = ${res.rows.length}`);

        return res.rows.map(row => ({
            timestamp: new Date(row.timestamp),
            site_id: row.site_id.toString(),
            tariff_id: row.tariff_id,
            tariff_schedule_id: row.tariff_schedule_id,
            load_power: Number(row.load_power),
            solar_power: Number(row.solar_power),
            grid_power: Number(row.grid_power),
            battery_power: Number(row.battery_power),
            battery_soc: row.battery_soc === null || row.battery_soc === undefined ? null : Number(row.battery_soc),
        })) as EnergyData[];
    }

    async getBucketedEnergyData(siteId: string, start: Date, end: Date): Promise<EnergyData[]> {
        if (this.historyReader) return this.historyReader.getBucketedEnergyData(siteId, start, end);
        const queryStart = Date.now();
        const res = await energyQueryExecutor().query(`
            SELECT
                date_bin('15 minutes', timestamp, TIMESTAMPTZ '2000-01-01') as timestamp,
                MAX(timestamp) as sample_timestamp,
                site_id,
                tariff_id,
                tariff_schedule_id,
                COUNT(*)::int as sample_count,
                AVG(load_power) as load_power,
                AVG(solar_power) as solar_power,
                AVG(grid_power) as grid_power,
                AVG(battery_power) as battery_power,
                NULL as battery_soc,
                ROW_NUMBER() OVER (ORDER BY date_bin('15 minutes', timestamp, TIMESTAMPTZ '2000-01-01')) as id
            FROM "EnergyData"
            WHERE site_id = $1
            AND timestamp >= $2
            AND timestamp < $3
            GROUP BY date_bin('15 minutes', timestamp, TIMESTAMPTZ '2000-01-01'), site_id, tariff_id, tariff_schedule_id
            ORDER BY timestamp ASC
        `, [siteId, start, end]);
        const queryDuration = Date.now() - queryStart;
        console.log(`[EnergyRepo] getBucketedEnergyData: Query = ${queryDuration}ms, Rows = ${res.rows.length}`);

        return res.rows.map(row => ({
            id: Number(row.id),
            timestamp: new Date(row.timestamp),
            sample_timestamp: new Date(row.sample_timestamp),
            site_id: row.site_id.toString(),
            tariff_id: row.tariff_id,
            tariff_schedule_id: row.tariff_schedule_id,
            load_power: Number(row.load_power),
            solar_power: Number(row.solar_power),
            grid_power: Number(row.grid_power),
            battery_power: Number(row.battery_power),
            battery_soc: null,
            sample_count: Number(row.sample_count ?? 3),
        })) as EnergyData[];
    }


    // === Commands ===
    async insertEnergyDataBatch(rows:EnergyWrite[]):Promise<void> {
        if(!rows.length)return;
        if(process.env.COMPACT_HISTORY_READS_ENABLED!=='true') {
            const result=await withRawEnergyAccess([...new Set(rows.map(row=>row.site_id))],'write',()=>this.insertRawEnergyDataBatch(rows));
            if(result.kind==='raw')return;
        }
        // Release the selection transaction before taking the archive writer's
        // exclusive locks and restoring full touched days.
        await new CompactHistoryStore(pool).writeEnergyDataBatch(rows);
    }

    private async insertRawEnergyDataBatch(rows:EnergyWrite[]):Promise<void> {
        const valuePlaceholders: string[] = [];
        const params: unknown[] = [];
        let p = 1;
        for (const r of rows) {
            valuePlaceholders.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
            params.push(
                r.site_id, r.tariff_id, r.timestamp,
                r.load_power, r.solar_power, r.grid_power, r.battery_power,
                r.battery_soc, r.tariff_schedule_id ?? null
            );
        }

        await energyQueryExecutor().query(`
            INSERT INTO "EnergyData"(site_id, tariff_id, timestamp, load_power, solar_power, grid_power, battery_power, battery_soc, tariff_schedule_id)
            VALUES ${valuePlaceholders.join(', ')}
            ON CONFLICT(timestamp, site_id) DO UPDATE SET
                tariff_id = EXCLUDED.tariff_id,
                load_power = EXCLUDED.load_power,
                solar_power = EXCLUDED.solar_power,
                grid_power = EXCLUDED.grid_power,
                battery_power = EXCLUDED.battery_power,
                battery_soc = COALESCE(EXCLUDED.battery_soc, "EnergyData".battery_soc),
                tariff_schedule_id = EXCLUDED.tariff_schedule_id
        `, params);
    }

    async cleanupOldEnergyData(cutoffDate: Date): Promise<{ energyDeleted: number }> {

        const energyRes = await energyQueryExecutor().query(`
            DELETE FROM "EnergyData"
            WHERE timestamp < $1
        `, [cutoffDate]);

        return {
            energyDeleted: energyRes.rowCount || 0
        };
    }
}
