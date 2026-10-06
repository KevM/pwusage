import type { RetentionQueryable } from './history-retention-repo';
import { pool, Tariff, EnergyData, TariffSchedule } from './db';
import { wattsToKilowatts } from './energy-utils';
import { priceBillUsage } from './bill-pricing';
import { getSiteMidnight, getValidTimezone } from './date-utils';

import { Schedule } from './schedule';
import { SiteRepo } from './site-repo';
import { TariffRepo } from './tariff-repo';

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


export class EnergyRepo {
    /**
     * Helper to get site-timezone midnight as a global Date object (UTC timestamp)
     */
    static getSiteMidnight(d: Date, tz: string): Date {
        return getSiteMidnight(d, tz);
    }

// === Queries ===
    async getLatestTimestamp(siteId: string): Promise<Date | null> {
        const res = await pool.query(
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
        const tz = getValidTimezone(timezone);
        const res = await pool.query(
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

    async getUsageByTOU(siteId: string, start: Date, end: Date): Promise<UsageData[]> {

        const siteRepo = new SiteRepo();
        const site = await siteRepo.getSite(siteId);
        if (!site) return [];

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

        // Calculate site-local "today" boundary and split point, clamped to
        // [start, end]. Without the lower clamp, a request for a cycle that
        // starts in the future fetches raw rows from today's midnight up to
        // `end` — rows that precede the requested range.
        const now = new Date();
        const todayStart = EnergyRepo.getSiteMidnight(now, site.timezone);
        const splitPoint = new Date(
            Math.max(start.getTime(), Math.min(todayStart.getTime(), end.getTime()))
        );

        // Fetch prior aggregates and today's raw data in parallel
        const [priorAggregates, todayRaw] = await Promise.all([
            this.getCycleAggregates(siteId, start, splitPoint),
            this.getRawEnergyData(siteId, splitPoint, end)
        ]);

        return EnergyRepo.aggregateUsageByTOU({
            siteId, start, priorAggregates, todayRaw, schedule, tariffMap, scheduleMap
        });
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
        const [cycle, today] = await Promise.all([
            this.getUsageByTOU(siteId, cycleStart, end),
            this.getUsageByTOU(siteId, todayStart, end)
        ]);
        return { cycle, today };
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
        const { rows } = await pool.query('SELECT 1 FROM "EnergyData" WHERE site_id = $1 LIMIT 1', [siteId]);
        return rows.length > 0;
    }

    async getLatestEnergyData(siteId: string, asOf?: Date): Promise<{
        timestamp: Date;
        batterySoc: number | null;
        batteryPower: number;
        solarPower: number;
        gridPower: number;
        loadPower: number;
    } | null> {
        const timestampLimit = asOf ? 'AND timestamp <= $2' : '';
        const params = asOf ? [siteId, asOf] : [siteId];
        const { rows } = await pool.query(`
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
    async getLatestBatterySoc(siteId: string, since: Date): Promise<{ value: number; timestamp: Date } | null> {
        const { rows } = await pool.query(`
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
        siteId: string, start: Date, end: Date
    ): Promise<CycleAggregateRow[]> {
        const queryStart = Date.now();
        const res = await pool.query(`
            SELECT
                date_trunc('day', timestamp) AS day,
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
        `, [siteId, start, end]);
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
        if (start.getTime() >= end.getTime()) return [];
        const queryStart = Date.now();
        const res = await pool.query(`
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
        const queryStart = Date.now();
        const res = await pool.query(`
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
            id: row.id,
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
    async insertEnergyDataBatch(rows: Array<{
        site_id: string;
        tariff_id: number;
        tariff_schedule_id?: number | null;
        timestamp: Date;
        load_power: number;
        solar_power: number;
        grid_power: number;
        battery_power: number;
        battery_soc: number | null;
    }>): Promise<void> {
        if (rows.length === 0) return;

        const valuePlaceholders: string[] = [];
        const params: unknown[] = [];
        let p = 1;
        for (const r of rows) {
            valuePlaceholders.push(`($${p++}::text, $${p++}::bigint, $${p++}::timestamptz, $${p++}::double precision, $${p++}::double precision, $${p++}::double precision, $${p++}::double precision, $${p++}::double precision, $${p++}::bigint)`);
            params.push(
                r.site_id, r.tariff_id, r.timestamp,
                r.load_power, r.solar_power, r.grid_power, r.battery_power,
                r.battery_soc, r.tariff_schedule_id ?? null
            );
        }

        params.push([...new Set(rows.map(row => row.site_id))]);
        await pool.query(`
            WITH history_policies AS MATERIALIZED (
                SELECT s.id,
                    (date_trunc('day', statement_timestamp() AT TIME ZONE COALESCE(NULLIF(s.timezone, ''), 'UTC'))
                        - make_interval(days => CASE
                            WHEN u.history_retention_days = 365 OR u.history_retention_transition_pending
                                OR u.history_retention_grace_until > statement_timestamp() THEN 365
                            ELSE 90 END)) AT TIME ZONE COALESCE(NULLIF(s.timezone, ''), 'UTC') AS cutoff
                FROM "Site" s JOIN "User" u ON u.id = s.user_id
                WHERE s.id = ANY($${p}::text[]) AND u.history_retention_days IN (90, 365)
            ), incoming(site_id, tariff_id, timestamp, load_power, solar_power, grid_power, battery_power, battery_soc, tariff_schedule_id) AS (
                VALUES ${valuePlaceholders.join(', ')}
            )
            INSERT INTO "EnergyData"(site_id, tariff_id, timestamp, load_power, solar_power, grid_power, battery_power, battery_soc, tariff_schedule_id)
            SELECT incoming.* FROM incoming JOIN history_policies policy ON policy.id = incoming.site_id
            WHERE incoming.timestamp >= policy.cutoff
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

    async deleteExpiredBatch(siteId: string, cutoff: Date, limit: number, db: RetentionQueryable = pool): Promise<number> {
        if (!Number.isInteger(limit) || limit < 1 || limit > 5000) throw new Error('Invalid retention batch size');
        const result = await db.query(`
            WITH candidates AS (
                SELECT id FROM "EnergyData" WHERE site_id = $1 AND timestamp < $2
                ORDER BY timestamp, id LIMIT $3 FOR UPDATE SKIP LOCKED
            )
            DELETE FROM "EnergyData" target USING candidates WHERE target.id = candidates.id
        `, [siteId, cutoff, limit]);
        return result.rowCount ?? 0;
    }

}
