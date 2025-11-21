import { db, EnergyUsage, Tariff, Site } from './db';
import { Schedule } from './schedule';

function formatYMD(date: Date, timeZone: string): string {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(date); // YYYY-MM-DD
}

function getHourInTimeZone(date: Date, timeZone: string): number {
    const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hour: '2-digit',
        hourCycle: 'h23'
    });
    const parts = fmt.formatToParts(date);
    const hourStr = parts.find(p => p.type === 'hour')?.value;
    return Number(hourStr);
}

function getOffsetMinutesForDate(dateStr: string, timeZone: string): number | null {
    const [y, m, d] = dateStr.split('-').map(Number);
    if ([y, m, d].some(v => Number.isNaN(v))) return null;
    const baselineUtc = Date.UTC(y, m - 1, d, 12, 0, 0);
    const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone,
        timeZoneName: 'shortOffset'
    });
    const parts = fmt.formatToParts(new Date(baselineUtc));
    const tzName = parts.find(p => p.type === 'timeZoneName')?.value ?? '';
    const match = tzName.match(/GMT([+-]\d{2})(?::?(\d{2}))?/i);
    if (!match) return null;
    const hours = Number(match[1]);
    const minutes = match[2] ? Number(match[2]) : 0;
    return hours * 60 + Math.sign(hours) * minutes;
}

function getUtcRangeForDate(dateStr: string, timeZone: string, clampToNow: boolean): { start: Date; end: Date } {
    const [y, m, d] = dateStr.split('-').map(Number);
    const offsetMinutes = getOffsetMinutesForDate(dateStr, timeZone);
    if ([y, m, d].some(v => Number.isNaN(v)) || offsetMinutes === null) {
        const fallback = new Date(dateStr + 'T00:00:00');
        const start = new Date(fallback);
        start.setHours(0, 0, 0, 0);
        const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
        return { start, end };
    }
    const startUtcMs = Date.UTC(y, m - 1, d, 0, 0, 0) - offsetMinutes * 60 * 1000;
    let endUtcMs = startUtcMs + 24 * 60 * 60 * 1000;

    if (clampToNow) {
        const now = new Date();
        const nowDateStr = formatYMD(now, timeZone);
        if (nowDateStr === dateStr) {
            endUtcMs = Math.min(endUtcMs, now.getTime());
        }
    }

    return { start: new Date(startUtcMs), end: new Date(endUtcMs) };
}

export interface UsageData {
    start: Date;
    homeUsage: number;
    gridUsage: number;
    solarProduction: number;
    batteryChange: number;
    tariff: Tariff;
    touName?: string;
    cost?: number;
}

export interface SiteWithTariffs extends Site {
    tariffs: Tariff[];
}

export class EnergyRepo {
    getUsageByTOU(siteId: string, start: Date, end: Date): UsageData[] {
        // Get tariffs for the site first to map them
        const tariffs = db.prepare('SELECT * FROM Tariff WHERE site_id = ?').all(siteId) as Tariff[];
        const tariffMap = new Map<number, Tariff>();
        tariffs.forEach(t => tariffMap.set(t.id, t));

        // Get schedules to map names
        // We need to join EnergyData -> Tariff -> TariffSeason -> TariffSchedule?
        // Actually, EnergyData has tariff_id. But it doesn't store which Schedule was active.
        // The Importer calculates it but doesn't store it in EnergyData (only tariff_id).
        // Wait, the goal is to aggregate by TOU period (On-Peak, Off-Peak).
        // Since we don't store the Schedule ID in EnergyData, we have to re-calculate it OR assume the importer did it right?
        // The importer stores raw data. We need to apply the schedule logic again to group by TOU.
        // OR, we could have stored the Schedule ID in EnergyData? No, schema has tariff_id.

        // Re-calculating for every query is expensive but accurate if schedules change?
        // Actually, for "Usage for X - Y", we just want the totals.
        // The Importer ALREADY aggregated into EnergyUsage table?
        // No, EnergyUsage table is by Tariff ID. It loses the TOU granularity.
        // So we MUST query EnergyData (raw 5min/15min/1h intervals) and map each to a TOU period.

        const site = this.getSite(siteId);
        if (!site) return [];
        const schedule = new Schedule(site.tariffs);

        const startStr = start.toISOString();
        const endStr = end.toISOString();

        const rows = db.prepare(`
            SELECT timestamp, tariff_id, load_power, solar_power, grid_power, battery_power 
            FROM EnergyData
            WHERE site_id = ? AND timestamp >= ? AND timestamp < ?
        `).all(siteId, startStr, endStr) as any[];

        const aggregation = new Map<string, UsageData>();

        for (const row of rows) {
            const ts = new Date(row.timestamp);
            const tp = schedule.getTariffPeriod(ts);

            // Default to "Unknown" if no schedule match, or use the tariff name
            let touName = 'Unknown';
            let tariffName = 'Unknown';
            let buyRate = 0;
            let sellRate = 0;

            if (tp) {
                touName = tp.schedule.name || 'Standard';
                tariffName = tp.tariff.name || 'Unknown';
                buyRate = tp.schedule.buy_rate || 0;
                sellRate = tp.schedule.sell_rate || 0;
            } else {
                // Fallback to tariff name if available
                const t = tariffMap.get(row.tariff_id);
                if (t) tariffName = t.name || 'Unknown';
            }

            const key = `${tariffName}|${touName}|${buyRate}|${sellRate}`;

            let data = aggregation.get(key);
            if (!data) {
                data = {
                    start: start, // Just use the query start date for the bucket
                    homeUsage: 0,
                    gridUsage: 0,
                    solarProduction: 0,
                    batteryChange: 0,
                    tariff: tp?.tariff || tariffMap.get(row.tariff_id)!,
                    touName: touName,
                    cost: 0
                };
                aggregation.set(key, data);
            }

            data.homeUsage += row.load_power;
            data.gridUsage += row.grid_power;
            data.solarProduction += row.solar_power;
            data.batteryChange += row.battery_power;
        }

        // Calculate cost based on aggregated usage (Net Metering logic)
        for (const [key, data] of aggregation) {
            const [_, __, buyRateStr, sellRateStr] = key.split('|');
            const buyRate = parseFloat(buyRateStr);
            const sellRate = parseFloat(sellRateStr);

            const gridKwh = data.gridUsage / 1000;
            if (gridKwh >= 0) {
                data.cost = gridKwh * buyRate;
            } else {
                data.cost = gridKwh * sellRate;
            }
        }

        return Array.from(aggregation.values());
    }

    getSite(siteId: string): SiteWithTariffs | undefined {
        const site = db.prepare('SELECT * FROM Site WHERE id = ?').get(siteId) as Site | undefined;
        if (!site) return undefined;

        const tariffs = db.prepare('SELECT * FROM Tariff WHERE site_id = ?').all(siteId) as Tariff[];

        for (const tariff of tariffs) {
            const seasons = db.prepare('SELECT * FROM TariffSeason WHERE tariff_id = ?').all(tariff.id) as any[]; // Type cast later
            tariff.seasons = seasons;

            for (const season of seasons) {
                const schedules = db.prepare('SELECT * FROM TariffSchedule WHERE season_id = ?').all(season.id) as any[];
                season.schedules = schedules;
            }
        }

        return {
            ...site,
            tariffs
        };
    }

    getSiteIds(): string[] {
        const rows = db.prepare('SELECT id FROM Site').all() as { id: string }[];
        return rows.map(r => r.id);
    }

    getHourlyEnergyData(siteId: string, dateStr: string, timeZone?: string): Array<{
        hour: number;
        homeUsage: number;
        solarProduction: number;
        gridUsage: number;
        batteryUsage: number;
        batterySoc: number | null;
    }> {
        const tz = timeZone ?? 'UTC';
        const { start, end } = getUtcRangeForDate(dateStr, tz, false);

        const rows = db.prepare(`
            SELECT 
                timestamp,
                load_power,
                solar_power,
                grid_power,
                battery_power,
                battery_soc
            FROM EnergyData
            WHERE site_id = ? AND datetime(timestamp) >= datetime(?) AND datetime(timestamp) < datetime(?)
        `).all(siteId, start.toISOString(), end.toISOString()) as any[];

        const buckets = new Map<number, {
            homeUsage: number;
            solarProduction: number;
            gridUsage: number;
            batteryUsage: number;
            batterySocTotal: number;
            batterySocCount: number;
        }>();

        for (const row of rows) {
            const ts = new Date(row.timestamp);
            const rowDateStr = formatYMD(ts, tz);
            if (rowDateStr !== dateStr) continue;
            const hr = getHourInTimeZone(ts, tz);
            if (!buckets.has(hr)) {
                buckets.set(hr, {
                    homeUsage: 0,
                    solarProduction: 0,
                    gridUsage: 0,
                    batteryUsage: 0,
                    batterySocTotal: 0,
                    batterySocCount: 0
                });
            }

            const bucket = buckets.get(hr)!;
            bucket.homeUsage += row.load_power;
            bucket.solarProduction += row.solar_power;
            bucket.gridUsage += row.grid_power;
            bucket.batteryUsage += row.battery_power;
            if (row.battery_soc !== null && row.battery_soc !== undefined) {
                bucket.batterySocTotal += row.battery_soc;
                bucket.batterySocCount += 1;
            }
        }

        const sortedHours = Array.from(buckets.entries()).sort((a, b) => a[0] - b[0]);
        return sortedHours.map(([hour, bucket]) => ({
            hour,
            homeUsage: bucket.homeUsage / 1000, // Convert to kWh
            solarProduction: bucket.solarProduction / 1000,
            gridUsage: bucket.gridUsage / 1000,
            batteryUsage: bucket.batteryUsage / 1000,
            batterySoc: bucket.batterySocCount > 0 ? bucket.batterySocTotal / bucket.batterySocCount : null
        }));
    }
}
