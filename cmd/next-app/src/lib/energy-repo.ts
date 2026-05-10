import { pool, Tariff, EnergyData, TariffSchedule } from './db';
import { wattsToKilowatts } from './energy-utils';
import { getSiteMidnight } from './date-utils';

import { Schedule } from './schedule';
import { SiteRepo } from './site-repo';

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

export interface CycleAggregateRow {
    day: Date;
    tariff_id: number;
    tariff_schedule_id: number | null;
    load_power: number;
    solar_power: number;
    grid_power: number;
    battery_power: number;
}


export class EnergyRepo {
    /**
     * Helper to get site-timezone midnight as a global Date object (UTC timestamp)
     */
    static getSiteMidnight(d: Date, tz: string): Date {
        return getSiteMidnight(d, tz);
    }

    async getUsageByTOU(siteId: string, start: Date, end: Date): Promise<UsageData[]> {
        const siteRepo = new SiteRepo();
        const site = await siteRepo.getSite(siteId);
        if (!site) return [];

        const tariffMap = new Map<number, Tariff>();
        site.tariffs.forEach(t => tariffMap.set(t.id, t));

        const scheduleMap = new Map<number, TariffSchedule>();
        site.tariffs.forEach(t => {
            if (t.seasons) {
                t.seasons.forEach(season => {
                    if (season.schedules) {
                        season.schedules.forEach(s => scheduleMap.set(s.id, s));
                    }
                });
            }
        });

        const schedule = new Schedule(site.tariffs, site.timezone);

        // Calculate site-local "today" boundary and split point
        const now = new Date();
        const todayStart = EnergyRepo.getSiteMidnight(now, site.timezone);
        const splitPoint = todayStart < end ? todayStart : end;

        // Fetch prior aggregates and today's raw data in parallel
        const [priorAggregates, todayRaw] = await Promise.all([
            this.getCycleAggregates(siteId, start, splitPoint),
            this.getRawEnergyData(siteId, splitPoint, end)
        ]);

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
                    buyRate = sched.buy_rate || 0;
                    sellRate = sched.sell_rate || 0;
                }
            } else {
                const tp = schedule.getTariffPeriod(row.day);
                if (tp) {
                    touName = tp.schedule.name || 'Standard';
                    buyRate = tp.schedule.buy_rate || 0;
                    sellRate = tp.schedule.sell_rate || 0;
                }
            }

            const tariff = tariffMap.get(row.tariff_id);
            const tariffName = tariff?.name || 'Unknown';
            const key = `${tariffName}|${touName}|${buyRate}|${sellRate}`;

            let data = aggregation.get(key);
            if (!data) {
                data = {
                    start: start,
                    homeUsage: 0,
                    gridUsage: 0,
                    solarProduction: 0,
                    batteryChange: 0,
                    tariff: tariff!,
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
                buyRate = tp.schedule.buy_rate || 0;
                sellRate = tp.schedule.sell_rate || 0;
                currentTariff = tp.tariff;
            } else {
                const t = tariffMap.get(row.tariff_id);
                if (t) {
                    tariffName = t.name || 'Unknown';
                    currentTariff = t;
                }
            }

            const key = `${tariffName}|${touName}|${buyRate}|${sellRate}`;

            let data = aggregation.get(key);
            if (!data) {
                data = {
                    start: start,
                    homeUsage: 0,
                    gridUsage: 0,
                    solarProduction: 0,
                    batteryChange: 0,
                    tariff: currentTariff!,
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

        // Calculate costs
        for (const [key, data] of aggregation) {
            const [, , buyRateStr, sellRateStr] = key.split('|');
            const buyRate = parseFloat(buyRateStr);
            const sellRate = parseFloat(sellRateStr);

            const gridKwh = wattsToKilowatts(data.gridUsage);
            if (gridKwh >= 0) {
                data.cost = gridKwh * buyRate;
            } else {
                data.cost = -Math.abs(gridKwh) * Math.abs(sellRate);
            }
        }

        return Array.from(aggregation.values());
    }

    async hasData(siteId: string): Promise<boolean> {
        const { rows } = await pool.query('SELECT 1 FROM "EnergyData" WHERE site_id = $1 LIMIT 1', [siteId]);
        return rows.length > 0;
    }

    async getLatestEnergyData(siteId: string): Promise<{ timestamp: Date; batterySoc: number | null } | null> {
        const { rows } = await pool.query(`
            SELECT timestamp, battery_soc
            FROM "EnergyData"
            WHERE site_id = $1
            ORDER BY timestamp DESC
            LIMIT 1
        `, [siteId]);

        if (rows.length === 0) return null;
        return {
            timestamp: new Date(rows[0].timestamp),
            batterySoc: rows[0].battery_soc === null || rows[0].battery_soc === undefined
                ? null
                : Number(rows[0].battery_soc)
        };
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
                site_id,
                tariff_id,
                tariff_schedule_id,
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
            site_id: row.site_id.toString(),
            tariff_id: row.tariff_id,
            tariff_schedule_id: row.tariff_schedule_id,
            load_power: Number(row.load_power),
            solar_power: Number(row.solar_power),
            grid_power: Number(row.grid_power),
            battery_power: Number(row.battery_power),
            battery_soc: null,
        })) as EnergyData[];
    }

    async getRawEnergyDataWithTz(siteId: string, start: Date, end: Date, targetTimezone?: string): Promise<EnergyData[]> {
        if (!targetTimezone) {
            return this.getRawEnergyData(siteId, start, end);
        }

        const sql = `
            WITH converted AS (
                SELECT
                    *,
                    timestamp AT TIME ZONE $4 as target_ts
                FROM "EnergyData"
                WHERE site_id = $1
                AND timestamp >= ($2::timestamptz - INTERVAL '1 day')
                AND timestamp <= ($3::timestamptz + INTERVAL '1 day')
            )
            SELECT * FROM converted
            WHERE target_ts >= $2::timestamptz
            AND target_ts < $3::timestamptz
            ORDER BY target_ts ASC
        `;

        const res = await pool.query(sql, [
            siteId,
            start,
            end,
            targetTimezone
        ]);

        return res.rows.map(row => ({
            ...row,
            timestamp: new Date(row.target_ts),
            site_id: row.site_id.toString(),
            load_power: Number(row.load_power),
            solar_power: Number(row.solar_power),
            grid_power: Number(row.grid_power),
            battery_power: Number(row.battery_power),
            battery_soc: row.battery_soc === null || row.battery_soc === undefined ? null : Number(row.battery_soc),
        })) as EnergyData[];
    }

    async cleanupOldEnergyData(cutoffDate: Date): Promise<{ energyDeleted: number }> {
        const energyRes = await pool.query(`
            DELETE FROM "EnergyData"
            WHERE timestamp < $1
        `, [cutoffDate]);

        return {
            energyDeleted: energyRes.rowCount || 0
        };
    }
}
