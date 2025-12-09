import { pool, EnergyUsage, Tariff, Site, TariffSeason, TariffSchedule } from './db';
import { getDbReady } from './db-init';
import { Schedule } from './schedule';

// Use global cache to persist across reloads in dev
const globalForCache = global as unknown as { siteCache: Map<string, { data: SiteWithTariffs; expires: number }> };
const siteCache = globalForCache.siteCache || new Map<string, { data: SiteWithTariffs; expires: number }>();
if (process.env.NODE_ENV !== 'production') globalForCache.siteCache = siteCache;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

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
    buyRate?: number;
    sellRate?: number;
}

export interface SiteWithTariffs extends Site {
    tariffs: Tariff[];
}

export class EnergyRepo {
    async getUsageByTOU(siteId: string, start: Date, end: Date): Promise<UsageData[]> {
        const tariffsResult = await pool.query('SELECT * FROM "Tariff" WHERE site_id = $1', [siteId]);
        const tariffs = tariffsResult.rows as Tariff[];
        const tariffMap = new Map<number, Tariff>();
        tariffs.forEach(t => tariffMap.set(t.id, t));

        const site = await this.getSite(siteId);
        if (!site) return [];
        const schedule = new Schedule(site.tariffs, site.timezone);

        // PG Query using Strings to ensure strictly Wall Clock comparison
        // start and end are expected to be "Local Midnight" Date objects (e.g. 2025-11-09 00:00:00 Local)
        // We convert them to YYYY-MM-DD 00:00:00 strings to pass to SQL.

        const toSqlString = (d: Date) => {
            const y = d.getFullYear();
            const m = String(d.getMonth() + 1).padStart(2, '0');
            const day = String(d.getDate()).padStart(2, '0');
            const h = String(d.getHours()).padStart(2, '0');
            const min = String(d.getMinutes()).padStart(2, '0');
            const s = String(d.getSeconds()).padStart(2, '0');
            return `${y}-${m}-${day} ${h}:${min}:${s}`;
        };

        const startStr = toSqlString(start);
        const endStr = toSqlString(end);

        const rowsResult = await pool.query(`
            SELECT timestamp, tariff_id, load_power, solar_power, grid_power, battery_power 
            FROM "EnergyData"
            WHERE site_id = $1 AND timestamp >= $2::timestamp AND timestamp < $3::timestamp
        `, [siteId, startStr, endStr]);

        const rows = rowsResult.rows;

        const aggregation = new Map<string, UsageData>();

        for (const row of rows) {
            const ts = new Date(row.timestamp);
            const tp = schedule.getTariffPeriod(ts);

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
                const t = tariffMap.get(row.tariff_id);
                if (t) tariffName = t.name || 'Unknown';
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
                    tariff: tp?.tariff || tariffMap.get(row.tariff_id)!,
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

    async getSite(siteId: string): Promise<SiteWithTariffs | undefined> {
        await getDbReady();
        const now = Date.now();
        const cached = siteCache.get(siteId);
        if (cached && cached.expires > now) {
            return cached.data;
        }

        const siteRes = await pool.query('SELECT * FROM "Site" WHERE id = $1', [siteId]);
        const site = siteRes.rows[0] as Site | undefined;
        if (!site) return undefined;

        const tariffsRes = await pool.query('SELECT * FROM "Tariff" WHERE site_id = $1', [siteId]);
        const tariffs = tariffsRes.rows as Tariff[];

        for (const tariff of tariffs) {
            const seasonsRes = await pool.query('SELECT * FROM "TariffSeason" WHERE tariff_id = $1', [tariff.id]);
            tariff.seasons = seasonsRes.rows as TariffSeason[];

            for (const season of tariff.seasons!) {
                const schedRes = await pool.query('SELECT * FROM "TariffSchedule" WHERE season_id = $1', [season.id]);
                season.schedules = schedRes.rows as TariffSchedule[];
            }
        }

        const result = {
            ...site,
            tariffs
        };

        siteCache.set(siteId, { data: result, expires: now + CACHE_TTL_MS });
        return result;
    }

    async getSiteIds(): Promise<string[]> {
        await getDbReady();
        const { rows } = await pool.query('SELECT id FROM "Site"');
        return rows.map((r: any) => r.id);
    }

    async getSites(): Promise<Site[]> {
        await getDbReady();
        const { rows } = await pool.query('SELECT * FROM "Site"');
        return rows as Site[];
    }

    async hasData(siteId: string): Promise<boolean> {
        await getDbReady();
        const { rows } = await pool.query('SELECT 1 FROM "EnergyData" WHERE site_id = $1 LIMIT 1', [siteId]);
        return rows.length > 0;
    }

    async getHourlyEnergyData(siteId: string, dateStr: string, timeZone?: string): Promise<Array<{
        hour: number;
        homeUsage: number;
        solarProduction: number;
        gridUsage: number;
        batteryUsage: number;
        batterySoc: number | null;
    }>> {
        // Since we are storing Wall Clock time in the DB (TIMESTAMP without TZ),
        // we should query for the literal date range and bucket by the literal hour.
        // We avoid Date object timezone shifting by working with strings or naive 00:00 UTC Dates.

        const start = new Date(dateStr + 'T00:00:00Z'); // Naive 00:00
        const end = new Date(start.getTime() + 24 * 60 * 60 * 1000); // Naive 00:00 next day

        // When passing a Date object to PG, node-postgres uses the local timezone of the server.
        // If we want to strictly match "2023-01-01 00:00:00" in the DB, we should pass strings
        // or ensure the Date stringifies to that.
        // Safest is to pass ISO strings and let Postgres CAST, but TIMESTAMP w/o TZ might shift.
        // Actually, passing the date string directly is safest.

        const startStr = dateStr + ' 00:00:00';
        const endStr = new Date(end).toISOString().split('T')[0] + ' 00:00:00';
        // Logic check: if dateStr is 2025-12-08. end is 12-09.

        const rowsResult = await pool.query(`
            SELECT 
                timestamp,
                load_power,
                solar_power,
                grid_power,
                battery_power,
                battery_soc
            FROM "EnergyData"
            WHERE site_id = $1 AND timestamp >= $2::timestamp AND timestamp < $3::timestamp
        `, [siteId, startStr, endStr]);

        const rows = rowsResult.rows;
        const buckets = new Map<number, {
            homeUsage: number;
            solarProduction: number;
            gridUsage: number;
            batteryUsage: number;
            batterySocTotal: number;
            batterySocCount: number;
        }>();

        for (const row of rows) {
            // row.timestamp is a Date object parsed from DB.
            // If DB says "08:00:00", node-postgres makes a Date where "Local Time" is 08:00.
            // So .getHours() will return 8 in both Dev (CST) and Vercel (UTC).
            const ts = new Date(row.timestamp);
            const hr = ts.getHours();

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

    async updateSiteBillingDay(siteId: string, day: number) {
        await pool.query('UPDATE "Site" SET billing_start_day = $1 WHERE id = $2', [day, siteId]);
        siteCache.delete(siteId);
    }

    async updateSiteTokens(siteId: string, accessToken: string, refreshToken: string) {
        const cached = siteCache.get(siteId);
        if (cached && cached.data) {
            (cached.data as Site).access_token = accessToken;
            (cached.data as Site).refresh_token = refreshToken;
        }

        await pool.query('UPDATE "Site" SET access_token = $1, refresh_token = $2 WHERE id = $3', [accessToken, refreshToken, siteId]);
        console.log(`[EnergyRepo] Updated tokens for site ${siteId}`);
    }

    async acquireRefreshLock(siteId: string): Promise<boolean> {
        const now = Date.now();
        const expires = now + 60000; // 1 minute lock duration

        // Postgres update returning row count logic:
        // rowCount property on result
        const result = await pool.query(`
            UPDATE "Site"
            SET is_refreshing = 1, refresh_lock_expires = $1
            WHERE id = $2 AND (is_refreshing = 0 OR refresh_lock_expires < $3)
        `, [expires, siteId, now]);

        return (result.rowCount ?? 0) > 0;
    }

    async releaseRefreshLock(siteId: string) {
        await pool.query('UPDATE "Site" SET is_refreshing = 0, refresh_lock_expires = 0 WHERE id = $1', [siteId]);
    }

    async waitForTokenRefresh(siteId: string, timeoutMs = 20000): Promise<{ access_token: string; refresh_token: string }> {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            const res = await pool.query('SELECT access_token, refresh_token, is_refreshing FROM "Site" WHERE id = $1', [siteId]);
            const site = res.rows[0];
            if (!site.is_refreshing) {
                return { access_token: site.access_token || '', refresh_token: site.refresh_token || '' };
            }
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        throw new Error('Timeout waiting for token refresh lock');
    }

    invalidateCache(siteId: string) {
        siteCache.delete(siteId);
    }

    getLockedRefreshHandler(siteId: string) {
        return async (refreshToken: string) => {
            console.log(`[TokenLock] Attempting to acquire lock for site ${siteId}...`);
            if (await this.acquireRefreshLock(siteId)) {
                console.log(`[TokenLock] Lock acquired for site ${siteId}. Refreshing...`);
                try {
                    const { refreshAccessToken } = await import('./tesla-auth');
                    const newTokens = await refreshAccessToken(refreshToken);

                    await this.updateSiteTokens(siteId, newTokens.access_token, newTokens.refresh_token);
                    return newTokens;
                } finally {
                    await this.releaseRefreshLock(siteId);
                    console.log(`[TokenLock] Lock released for site ${siteId}.`);
                }
            } else {
                console.log(`[TokenLock] Lock busy for site ${siteId}. Waiting...`);
                return this.waitForTokenRefresh(siteId);
            }
        };
    }
}
