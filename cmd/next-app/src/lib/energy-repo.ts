import { pool, Tariff, Site, TariffSeason, TariffSchedule, EnergyData } from './db';
import { getDbReady } from './db-init';
import { Schedule } from './schedule';

// Use global cache to persist across reloads in dev
const globalForCache = global as unknown as { siteCache: Map<string, { data: SiteWithTariffs; expires: number }> };
const siteCache = globalForCache.siteCache || new Map<string, { data: SiteWithTariffs; expires: number }>();
if (process.env.NODE_ENV !== 'production') globalForCache.siteCache = siteCache;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes





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
    access_token?: string | null;
    refresh_token?: string | null;
}

interface SiteIdRow {
    id: string;
}

// User-centric functions
export async function getUserByToken(token: string): Promise<{ id: string, email?: string } | null> {
    const res = await pool.query('SELECT id, email FROM "User" WHERE access_token = $1', [token]);
    if (res.rows.length === 0) return null;
    return res.rows[0];
}

async function getUserTokens(userId: string): Promise<{ access_token: string, refresh_token: string } | null> {
    const res = await pool.query('SELECT access_token, refresh_token FROM "User" WHERE id = $1', [userId]);
    if (res.rows.length === 0) return null;
    return res.rows[0];
}

export async function getUserTokensForSite(siteId: string): Promise<{ access_token: string, refresh_token: string, user_id: string } | null> {
    const res = await pool.query(`
        SELECT u.access_token, u.refresh_token, u.id as user_id 
        FROM "User" u
        JOIN "Site" s ON s.user_id = u.id
        WHERE s.id = $1
    `, [siteId]);
    if (res.rows.length === 0) return null;
    return res.rows[0];
}

export class EnergyRepo {
    async getSitesForUser(userId: string): Promise<Site[]> {
        await getDbReady();
        const { rows } = await pool.query('SELECT * FROM "Site" WHERE user_id = $1', [userId]);
        return rows as Site[];
    }

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
            // ... (Variable declarations were hoisted in valid code, need to ensure they are here or above)
            // Let's declare them locally for this loop scope
            const ts = new Date(row.timestamp);



            const year = ts.getFullYear();
            const month = ts.getMonth() + 1; // 1-12
            const day = ts.getDate();
            const hour = ts.getHours();
            const weekday = ts.getDay(); // 0=Sun, 1=Mon

            // We bypass the Schedule's built-in "Intl" conversion which tries to shift timezones.
            // We TRUST that 'ts' represents the Wall Clock time at the site.
            const tp = schedule.getTariffPeriodForWallClock(month, day, hour, weekday, ts, year);

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
            const [, , buyRateStr, sellRateStr] = key.split('|');
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

        // Combine with User tokens
        // We return a composite object that looks like the old SiteWithTariffs 
        // but physically the tokens come from User.
        // To satisfy the type checker (which expects SiteWithTariffs -> Site -> no tokens),
        // we cast it or extend the type locally if needed.
        // Wait, Site interface no longer has access_token. 
        // But the rest of the app (TeslaClient config) needs them.
        // So we should return a type that HAS tokens, even if the DB Site model doesn't.

        let access_token: string | null = null;
        let refresh_token: string | null = null;

        if (site.user_id) {
            const userTokens = await getUserTokens(site.user_id);
            if (userTokens) {
                access_token = userTokens.access_token;
                refresh_token = userTokens.refresh_token;
            }
        }

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
            access_token,
            refresh_token,
            tariffs
        } as SiteWithTariffs; // We cast here because we want to pass tokens along at runtime

        siteCache.set(siteId, { data: result, expires: now + CACHE_TTL_MS });
        return result;
    }

    async getSiteIds(): Promise<string[]> {
        await getDbReady();
        const { rows } = await pool.query<SiteIdRow>('SELECT id FROM "Site"');
        return rows.map((r) => r.id);
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

    async getHourlyEnergyData(siteId: string, dateStr: string): Promise<Array<{
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
        }>();

        for (const row of rows) {
            // row.timestamp is a Date object parsed from DB.
            // If DB says "08:00:00", node-postgres makes a Date where "Local Time" is 08:00.
            // So .getHours() will return 8 in both Dev (CST) and Vercel (UTC).
            const ts = new Date(row.timestamp);
            const hr = ts.getHours();

            let bucket = buckets.get(hr);
            if (!bucket) {
                bucket = { homeUsage: 0, solarProduction: 0, gridUsage: 0, batteryUsage: 0 };
                buckets.set(hr, bucket);
            }

            bucket.homeUsage += row.load_power;
            bucket.solarProduction += row.solar_power;
            bucket.gridUsage += row.grid_power;
            bucket.batteryUsage += row.battery_power;
        }

        const sortedHours = Array.from(buckets.entries()).sort((a, b) => a[0] - b[0]);
        return sortedHours.map(([hour, bucket]) => ({
            hour,
            homeUsage: bucket.homeUsage / 1000, // Convert to kWh
            solarProduction: bucket.solarProduction / 1000,
            gridUsage: bucket.gridUsage / 1000,
            batteryUsage: bucket.batteryUsage / 1000,
            batterySoc: null // batterySoc is no longer aggregated, return null or remove if type allows
        }));
    }

    async getLatestEnergyData(siteId: string): Promise<{ timestamp: Date } | null> {
        await getDbReady();
        const { rows } = await pool.query(`
            SELECT timestamp
            FROM "EnergyData" 
            WHERE site_id = $1 
            ORDER BY timestamp DESC 
            LIMIT 1
        `, [siteId]);

        if (rows.length === 0) return null;
        return {
            timestamp: new Date(rows[0].timestamp)
        };
    }

    async updateSiteBillingDay(siteId: string, day: number) {
        await pool.query('UPDATE "Site" SET billing_start_day = $1 WHERE id = $2', [day, siteId]);
        siteCache.delete(siteId);
    }

    async updateSiteTokens(siteId: string, accessToken: string, refreshToken: string) {
        const site = await this.getSite(siteId);

        if (site && site.user_id) {
            await pool.query('UPDATE "User" SET access_token = $1, refresh_token = $2 WHERE id = $3', [accessToken, refreshToken, site.user_id]);
            console.log(`[EnergyRepo] Updated tokens for USER ${site.user_id} (via site ${siteId})`);
        } else {
            console.warn(`[EnergyRepo] Cannot update tokens for site ${siteId} - No User Linked!`);
        }

        // Invalidate cache to force re-read
        siteCache.delete(siteId);
    }

    async acquireRefreshLock(siteId: string): Promise<boolean> {
        const now = Date.now();
        const expires = now + 60000;

        const site = await this.getSite(siteId);
        if (site && site.user_id) {
            const result = await pool.query(`
                UPDATE "User"
                SET is_refreshing = 1, refresh_lock_expires = $1
                WHERE id = $2 AND (is_refreshing = 0 OR refresh_lock_expires < $3)
            `, [expires, site.user_id, now]);
            return (result.rowCount ?? 0) > 0;
        }

        return false;
    }

    async releaseRefreshLock(siteId: string) {
        const site = await this.getSite(siteId);
        if (site && site.user_id) {
            await pool.query('UPDATE "User" SET is_refreshing = 0, refresh_lock_expires = 0 WHERE id = $1', [site.user_id]);
        }
    }

    async waitForTokenRefresh(siteId: string, timeoutMs = 20000): Promise<{ access_token: string; refresh_token: string }> {
        const start = Date.now();
        const site = await this.getSite(siteId);
        if (!site || !site.user_id) throw new Error('Site/User not found for refresh wait');

        while (Date.now() - start < timeoutMs) {
            const res = await pool.query(`SELECT access_token, refresh_token, is_refreshing FROM "User" WHERE id = $1`, [site.user_id]);
            const row = res.rows[0];
            if (!row.is_refreshing) {
                return { access_token: row.access_token || '', refresh_token: row.refresh_token || '' };
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

    /**
     * Fetches raw, unaggregated 5-minute energy data for high fidelity analysis.
     */
    async getRawEnergyData(siteId: string, start: Date, end: Date): Promise<EnergyData[]> {
        await getDbReady();

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

        const res = await pool.query(`
            SELECT * FROM "EnergyData"
            WHERE site_id = $1 
            AND timestamp >= $2::timestamp 
            AND timestamp < $3::timestamp
            ORDER BY timestamp ASC
        `, [siteId, startStr, endStr]);

        return res.rows.map(row => ({
            ...row,
            timestamp: new Date(row.timestamp), // Ensure JS Date
            site_id: row.site_id.toString(), // Ensure string
            load_power: Number(row.load_power),
            solar_power: Number(row.solar_power),
            grid_power: Number(row.grid_power),
            battery_power: Number(row.battery_power),
        })) as EnergyData[];
    }

    // Tagging Methods
    private toSqlString(d: Date) {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        const h = String(d.getHours()).padStart(2, '0');
        const min = String(d.getMinutes()).padStart(2, '0');
        const s = String(d.getSeconds()).padStart(2, '0');
        return `${y}-${m}-${day} ${h}:${min}:${s}`;
    }

    async getLoadTags(siteId: string, start: Date, end: Date): Promise<import('./db').LoadTag[]> {
        await getDbReady();
        const res = await pool.query(`
            SELECT * FROM "LoadTag"
            WHERE site_id = $1
            AND start_time >= $2::timestamp
            AND end_time <= $3::timestamp
        `, [siteId, this.toSqlString(start), this.toSqlString(end)]);

        return res.rows.map(r => ({
            ...r,
            start_time: new Date(r.start_time),
            end_time: new Date(r.end_time),
            created_at: new Date(r.created_at)
        }));
    }

    async addLoadTag(siteId: string, start: Date, end: Date, tag: string) {
        await getDbReady();
        const startStr = this.toSqlString(start);
        const endStr = this.toSqlString(end);

        // Prevent duplicates
        const exists = await pool.query(`
            SELECT 1 FROM "LoadTag" 
            WHERE site_id = $1 AND start_time = $2::timestamp AND end_time = $3::timestamp AND tag = $4
        `, [siteId, startStr, endStr, tag]);

        if (exists.rowCount && exists.rowCount > 0) return;

        await pool.query(`
            INSERT INTO "LoadTag" (site_id, start_time, end_time, tag)
            VALUES ($1, $2::timestamp, $3::timestamp, $4)
        `, [siteId, startStr, endStr, tag]);
    }

    async removeLoadTag(siteId: string, start: Date, end: Date, tag: string) {
        await getDbReady();
        await pool.query(`
            DELETE FROM "LoadTag"
            WHERE site_id = $1 AND start_time = $2::timestamp AND end_time = $3::timestamp AND tag = $4
         `, [siteId, this.toSqlString(start), this.toSqlString(end), tag]);
    }
}
