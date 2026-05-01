import { pool, Site, SiteWithTariffs, Tariff, EnergyData, TrmnlInstallation, TariffSeason, TariffSchedule } from './db';
import { wattsToKilowatts } from './energy-utils';
import { getRequestContext } from './request-context';

import { Schedule } from './schedule';

// Use global cache to persist across reloads in dev
const globalForCache = global as unknown as { siteCache: Map<string, { data: SiteWithTariffs; expires: number }> };
const siteCache = globalForCache.siteCache || new Map<string, { data: SiteWithTariffs; expires: number }>();
if (process.env.NODE_ENV !== 'production') globalForCache.siteCache = siteCache;
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

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

// SiteWithTariffs is now imported from db.ts

interface SiteIdRow {
    id: string;
}

interface SiteQueryOptions {
    includeJson?: boolean;
}

const SITE_BASE_COLUMNS = 'id, user_id, name, utility, updated, installed, timezone, billing_start_day, timezone_display_mode';
const SITE_COLUMNS_WITH_JSON = `${SITE_BASE_COLUMNS}, json`;

// User-centric functions
export async function getUserByToken(token: string): Promise<{ id: string, email?: string, roles?: string[] } | null> {
    const res = await pool.query('SELECT id, email, roles FROM "User" WHERE access_token = $1', [token]);
    if (res.rows.length === 0) return null;
    return res.rows[0];
}

export async function getUserTokens(userId: string): Promise<{ access_token: string, refresh_token: string } | null> {
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
    /**
     * Helper to get site-timezone midnight as a global Date object (UTC timestamp)
     */
    static getSiteMidnight(d: Date, tz: string): Date {
        if (isNaN(d.getTime())) {
            console.error(`[EnergyRepo] getSiteMidnight: Invalid Date received`);
            return new Date();
        }

        const formatter = new Intl.DateTimeFormat('en-US', {
            timeZone: tz,
            year: 'numeric', month: 'numeric', day: 'numeric',
            hour: 'numeric', minute: 'numeric', second: 'numeric',
            hour12: false
        });

        const parts = formatter.formatToParts(d);
        const partValues: Record<string, number> = {};
        for (const part of parts) {
            if (part.type !== 'literal') {
                partValues[part.type] = parseInt(part.value);
            }
        }

        const { year, month, day, hour, minute, second } = partValues;
        const siteLocalAsUTC = Date.UTC(year, month - 1, day, hour, minute, second);
        const offset = siteLocalAsUTC - d.getTime();
        const siteMidnightUTC = Date.UTC(year, month - 1, day, 0, 0, 0) - offset;

        return new Date(siteMidnightUTC);
    }

    async getInstallationAndSite(uuid: string): Promise<{ installation: TrmnlInstallation, site: SiteWithTariffs } | undefined> {
        const sql = `
            SELECT 
                i.*,
                s.name as site_name, s.updated as site_updated, s.installed as site_installed, s.timezone as site_timezone, 
                s.billing_start_day,
                u.access_token as tesla_access_token, u.refresh_token as tesla_refresh_token, u.auth_status as tesla_auth_status
            FROM "TrmnlInstallation" i
            JOIN "Site" s ON i.site_id = s.id
            LEFT JOIN "User" u ON s.user_id = u.id
            WHERE i.uuid = $1
            LIMIT 1
        `;

        const res = await pool.query(sql, [uuid]);
        const row = res.rows[0];
        if (!row) return undefined;

        const installation: TrmnlInstallation = {
            id: row.id,
            uuid: row.uuid,
            site_id: row.site_id,
            plugin_setting_id: row.plugin_setting_id,
            created_at: new Date(row.created_at),
            json: row.json,
            access_token: row.access_token,
            refresh_token: row.refresh_token
        };

        const siteWithTariffs = await this.getSite(row.site_id);
        if (!siteWithTariffs) return undefined;

        siteWithTariffs.access_token = row.tesla_access_token;
        siteWithTariffs.refresh_token = row.tesla_refresh_token;
        siteWithTariffs.auth_status = row.tesla_auth_status;

        return { installation, site: siteWithTariffs };
    }

    async getSitesForUser(userId: string, options?: SiteQueryOptions): Promise<Site[]> {
        const columns = options?.includeJson ? SITE_COLUMNS_WITH_JSON : SITE_BASE_COLUMNS;
        const { rows } = await pool.query(`SELECT ${columns} FROM "Site" WHERE user_id = $1`, [userId]);
        return rows as Site[];
    }

    async getUsageByTOU(siteId: string, start: Date, end: Date): Promise<UsageData[]> {
        const site = await this.getSite(siteId);
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

    async getSitesWithTariffs(siteIds: string[], options?: SiteQueryOptions): Promise<SiteWithTariffs[]> {
        if (siteIds.length === 0) return [];

        const now = Date.now();
        const requestCtx = getRequestContext();
        const results: SiteWithTariffs[] = [];
        const uncachedIds: string[] = [];

        for (const id of siteIds) {
            const reqCached = requestCtx.siteCache.get(id);
            if (reqCached && (!options?.includeJson || reqCached.json !== undefined)) {
                results.push(reqCached);
                continue;
            }
            const cached = siteCache.get(id);
            if (cached && cached.expires > now && (!options?.includeJson || cached.data.json !== undefined)) {
                requestCtx.siteCache.set(id, cached.data);
                results.push(cached.data);
                continue;
            }
            uncachedIds.push(id);
        }

        if (uncachedIds.length > 0) {
            const fresh = await this.loadSitesFromDB(uncachedIds, options);
            for (const site of fresh) {
                siteCache.set(site.id, { data: site, expires: now + CACHE_TTL_MS });
                requestCtx.siteCache.set(site.id, site);
                results.push(site);
            }
        }

        const inputOrder = new Map(siteIds.map((id, i) => [id, i]));
        results.sort((a, b) => (inputOrder.get(a.id) ?? 0) - (inputOrder.get(b.id) ?? 0));
        return results;
    }

    async getSite(siteId: string, options?: SiteQueryOptions): Promise<SiteWithTariffs | undefined> {
        const results = await this.getSitesWithTariffs([siteId], options);
        return results[0];
    }

    private async loadSitesFromDB(siteIds: string[], options?: SiteQueryOptions): Promise<SiteWithTariffs[]> {
        const jsonCol = options?.includeJson ? ', s.json' : '';
        const sql = `
            SELECT
                s.id, s.user_id, s.name, s.utility, s.updated, s.installed,
                s.timezone, s.billing_start_day, s.timezone_display_mode${jsonCol},
                u.access_token, u.refresh_token, u.auth_status,
                t.id          AS tariff_id,
                t.name        AS tariff_name,
                t.updated     AS tariff_updated,
                t.site_id     AS tariff_site_id,
                ts.id         AS season_id,
                ts.name       AS season_name,
                ts.from_month, ts.from_day, ts.to_month, ts.to_day,
                ts.buy_rate   AS season_buy_rate,
                ts.sell_rate  AS season_sell_rate,
                sch.id        AS schedule_id,
                sch.name      AS schedule_name,
                sch.buy_rate  AS schedule_buy_rate,
                sch.sell_rate AS schedule_sell_rate,
                sch.from_day_of_week, sch.from_hour, sch.from_minute,
                sch.to_day_of_week,   sch.to_hour,  sch.to_minute
            FROM "Site" s
            LEFT JOIN "User"           u   ON u.id          = s.user_id
            LEFT JOIN "Tariff"         t   ON t.site_id     = s.id
            LEFT JOIN "TariffSeason"   ts  ON ts.tariff_id  = t.id
            LEFT JOIN "TariffSchedule" sch ON sch.season_id = ts.id
            WHERE s.id = ANY($1::text[])
        `;
        const res = await pool.query(sql, [siteIds]);
        return this.assembleFromRows(res.rows, options);
    }

    private assembleFromRows(
        rows: Record<string, unknown>[],
        options?: SiteQueryOptions
    ): SiteWithTariffs[] {
        // Tariff/season IDs are global serial PKs — safe to use as cross-site map keys.
        const siteMap = new Map<string, SiteWithTariffs>();
        const tariffMap = new Map<number, Tariff>();
        const seasonMap = new Map<number, TariffSeason>();

        for (const row of rows) {
            const siteId = row.id as string;
            if (!siteMap.has(siteId)) {
                siteMap.set(siteId, {
                    id: siteId,
                    user_id: (row.user_id as string | null) ?? null,
                    name: row.name as string,
                    utility: (row.utility as string | null) ?? null,
                    updated: new Date(row.updated as string | Date),
                    installed: new Date(row.installed as string | Date),
                    timezone: row.timezone as string,
                    billing_start_day: row.billing_start_day as number,
                    timezone_display_mode: (row.timezone_display_mode as 'SITE' | 'BROWSER') ?? undefined,
                    json: options?.includeJson ? row.json : undefined,
                    access_token: (row.access_token as string | null) ?? null,
                    refresh_token: (row.refresh_token as string | null) ?? null,
                    auth_status: (row.auth_status as string | null) ?? null,
                    tariffs: [],
                });
            }
            const site = siteMap.get(siteId)!;

            if (row.tariff_id == null) continue;
            const tariffId = Number(row.tariff_id);
            if (!tariffMap.has(tariffId)) {
                const tariff: Tariff = {
                    id: tariffId,
                    site_id: row.tariff_site_id as string,
                    updated: new Date(row.tariff_updated as string | Date),
                    name: (row.tariff_name as string | null) ?? null,
                    seasons: [],
                };
                tariffMap.set(tariffId, tariff);
                site.tariffs.push(tariff);
            }
            const tariff = tariffMap.get(tariffId)!;

            if (row.season_id == null) continue;
            const seasonId = Number(row.season_id);
            if (!seasonMap.has(seasonId)) {
                const season: TariffSeason = {
                    id: seasonId,
                    tariff_id: tariffId,
                    name: (row.season_name as string | null) ?? null,
                    from_month: row.from_month as number,
                    from_day: row.from_day as number,
                    to_month: row.to_month as number,
                    to_day: row.to_day as number,
                    buy_rate: row.season_buy_rate as number,
                    sell_rate: row.season_sell_rate as number,
                    schedules: [],
                };
                seasonMap.set(seasonId, season);
                tariff.seasons!.push(season);
            }
            const season = seasonMap.get(seasonId)!;

            if (row.schedule_id == null) continue;
            season.schedules!.push({
                id: Number(row.schedule_id),
                season_id: seasonId,
                name: (row.schedule_name as string | null) ?? null,
                buy_rate: row.schedule_buy_rate != null ? Number(row.schedule_buy_rate) : null,
                sell_rate: row.schedule_sell_rate != null ? Number(row.schedule_sell_rate) : null,
                from_day_of_week: row.from_day_of_week as number | null,
                from_hour: row.from_hour as number | null,
                from_minute: row.from_minute as number | null,
                to_day_of_week: row.to_day_of_week as number | null,
                to_hour: row.to_hour as number | null,
                to_minute: row.to_minute as number | null,
            });
        }

        return Array.from(siteMap.values());
    }

    async getSiteIds(): Promise<string[]> {
        const { rows } = await pool.query<SiteIdRow>('SELECT id FROM "Site"');
        return rows.map((r) => r.id);
    }

    async getSites(options?: SiteQueryOptions): Promise<Site[]> {
        const columns = options?.includeJson ? SITE_COLUMNS_WITH_JSON : SITE_BASE_COLUMNS;
        const { rows } = await pool.query(`SELECT ${columns} FROM "Site"`);
        return rows as Site[];
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

    async updateSiteBillingDay(siteId: string, day: number) {
        await pool.query('UPDATE "Site" SET billing_start_day = $1 WHERE id = $2', [day, siteId]);
        siteCache.delete(siteId);
    }

    async updateSiteTimezoneDisplayMode(siteId: string, mode: 'SITE' | 'BROWSER') {
        await pool.query('UPDATE "Site" SET timezone_display_mode = $1 WHERE id = $2', [mode, siteId]);
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
        return {
            refreshHandler: async (refreshToken: string) => {
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
            },
            errorHandler: async (error: Error) => {
                const msg = error.message;
                if (msg.includes('401') || msg.includes('login_required') || msg.includes('invalid_grant')) {
                    const site = await this.getSite(siteId);
                    if (site && site.user_id) {
                        console.warn(`[TokenLock] Terminal auth failure for site ${siteId} (User ${site.user_id}). Marking revoked.`);
                        await pool.query('UPDATE "User" SET auth_status = $1, is_active = $2 WHERE id = $3', ['revoked', false, site.user_id]);
                        this.invalidateCache(siteId);
                    }
                }
            }
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

    async getLoadTags(siteId: string, start: Date, end: Date): Promise<import('./db').LoadTag[]> {
        const res = await pool.query(`
            SELECT * FROM "LoadTag"
            WHERE site_id = $1
            AND start_time >= $2
            AND end_time <= $3
        `, [siteId, start, end]);

        return res.rows.map(r => ({
            ...r,
            start_time: new Date(r.start_time),
            end_time: new Date(r.end_time),
            created_at: new Date(r.created_at)
        }));
    }

    async addLoadTag(siteId: string, start: Date, end: Date, tag: string) {
        const exists = await pool.query(`
            SELECT 1 FROM "LoadTag" 
            WHERE site_id = $1 AND start_time = $2 AND end_time = $3 AND tag = $4
        `, [siteId, start, end, tag]);

        if (exists.rowCount && exists.rowCount > 0) return;

        await pool.query(`
            INSERT INTO "LoadTag" (site_id, start_time, end_time, tag)
            VALUES ($1, $2, $3, $4)
        `, [siteId, start, end, tag]);
    }

    async removeLoadTag(siteId: string, start: Date, end: Date, tag: string) {
        await pool.query(`
            DELETE FROM "LoadTag"
            WHERE site_id = $1 AND start_time = $2 AND end_time = $3 AND tag = $4
        `, [siteId, start, end, tag]);
    }

    async cleanupOldData(cutoffDate: Date): Promise<{ energyDeleted: number; tagsDeleted: number }> {
        const energyRes = await pool.query(`
            DELETE FROM "EnergyData"
            WHERE timestamp < $1
        `, [cutoffDate]);

        const tagsRes = await pool.query(`
            DELETE FROM "LoadTag"
            WHERE end_time < $1
        `, [cutoffDate]);

        return {
            energyDeleted: energyRes.rowCount || 0,
            tagsDeleted: tagsRes.rowCount || 0
        };
    }
}
