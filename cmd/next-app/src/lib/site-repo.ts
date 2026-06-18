import { pool, Site, SiteWithTariffs, Tariff, TariffSeason } from './db';
import { getRequestContext } from './request-context';

// Use global cache to persist across reloads in dev
const globalForCache = global as unknown as { siteCache: Map<string, { data: SiteWithTariffs; expires: number }> };
const siteCache = globalForCache.siteCache || new Map<string, { data: SiteWithTariffs; expires: number }>();
if (process.env.NODE_ENV !== 'production') globalForCache.siteCache = siteCache;
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

interface SiteIdRow {
    id: string;
}

export interface SiteQueryOptions {
    includeJson?: boolean;
    includeTokens?: boolean;
}

const SITE_BASE_COLUMNS = 'id, user_id, name, utility, updated, installed, timezone, billing_start_day, timezone_display_mode, sankey_renderer';
const SITE_COLUMNS_WITH_JSON = `${SITE_BASE_COLUMNS}, json`;

export class SiteRepo {
    // === Queries ===
    async getSitesForUser(userId: string, options?: SiteQueryOptions): Promise<Site[]> {
        const columns = options?.includeJson ? SITE_COLUMNS_WITH_JSON : SITE_BASE_COLUMNS;
        const { rows } = await pool.query(`SELECT ${columns} FROM "Site" WHERE user_id = $1`, [userId]);
        return rows as Site[];
    }

    async getSitesWithTariffs(siteIds: string[], options?: SiteQueryOptions): Promise<SiteWithTariffs[]> {
        if (siteIds.length === 0) return [];

        const now = Date.now();
        const requestCtx = getRequestContext();
        const results: SiteWithTariffs[] = [];
        const uncachedIds: string[] = [];

        // When includeTokens is requested, always hit the DB to get fresh auth_status.
        // The global cache can serve stale auth_status (e.g., after external recovery scripts
        // reset users from 'revoked' to 'active'), which would cause the markup endpoint to
        // continue showing re-auth QR codes for up to 15 minutes.
        for (const id of siteIds) {
            if (options?.includeTokens) {
                uncachedIds.push(id);
                continue;
            }

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
                // Don't populate the global cache when tokens/auth_status are included —
                // those fields can change outside this process and shouldn't be cached.
                if (!options?.includeTokens) {
                    siteCache.set(site.id, { data: site, expires: now + CACHE_TTL_MS });
                    requestCtx.siteCache.set(site.id, site);
                }
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
        const tokenCols = options?.includeTokens ? ', u.access_token, u.refresh_token, u.auth_status' : '';
        const sql = `
            SELECT
                s.id, s.user_id, s.name, s.utility, s.updated, s.installed,
                s.timezone, s.billing_start_day, s.timezone_display_mode, s.sankey_renderer${jsonCol}${tokenCols},
                t.id          AS tariff_id,
                t.name        AS tariff_name,
                t.updated     AS tariff_updated,
                t.site_id     AS tariff_site_id,
                t.reporting_only AS tariff_reporting_only,
                t.effective_from::text AS tariff_effective_from,
                t.version     AS tariff_version,
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
            LEFT JOIN "Tariff"         t   ON t.site_id     = s.id AND t.is_current AND NOT t.reporting_only
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
                    sankey_renderer: (row.sankey_renderer as string) ?? undefined,
                    json: options?.includeJson ? row.json : undefined,
                    access_token: options?.includeTokens ? (row.access_token as string | null) ?? null : undefined,
                    refresh_token: options?.includeTokens ? (row.refresh_token as string | null) ?? null : undefined,
                    auth_status: options?.includeTokens ? (row.auth_status as string | null) ?? null : undefined,
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
                    reporting_only: row.tariff_reporting_only === true,
                    effective_from: (row.tariff_effective_from as string | null) ?? null,
                    version: row.tariff_version != null ? Number(row.tariff_version) : undefined,
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

    // === Queries ===
    async getSiteJson(siteId: string): Promise<unknown | null> {
        const res = await pool.query('SELECT json FROM "Site" WHERE id = $1', [siteId]);
        if (res.rows.length === 0) return null;
        return res.rows[0].json ?? null;
    }

    // === Commands ===
    async updateSiteBillingDay(siteId: string, day: number) {
        await pool.query('UPDATE "Site" SET billing_start_day = $1 WHERE id = $2', [day, siteId]);
        siteCache.delete(siteId);
    }

    async updateSiteTimezoneDisplayMode(siteId: string, mode: 'SITE' | 'BROWSER') {
        await pool.query('UPDATE "Site" SET timezone_display_mode = $1 WHERE id = $2', [mode, siteId]);
        siteCache.delete(siteId);
    }

    async updateSiteSankeyRenderer(siteId: string, rendererId: string) {
        await pool.query('UPDATE "Site" SET sankey_renderer = $1 WHERE id = $2', [rendererId, siteId]);
        siteCache.delete(siteId);
    }

    async assignSiteToUser(siteId: string, userId: string): Promise<void> {
        await pool.query('UPDATE "Site" SET user_id = $1 WHERE id = $2', [userId, siteId]);
        this.invalidateCache(siteId);
    }

    async upsertSite(params: {
        id: string;
        name: string;
        utility: string | null;
        installed: Date | string;
        timezone: string;
        json: unknown;
    }): Promise<void> {
        await pool.query(`
            INSERT INTO "Site"(id, name, utility, updated, installed, timezone, json)
            VALUES ($1, $2, $3, NOW(), $4, $5, $6)
            ON CONFLICT(id) DO UPDATE SET
                name=EXCLUDED.name,
                utility=EXCLUDED.utility,
                installed=EXCLUDED.installed,
                timezone=EXCLUDED.timezone,
                json=EXCLUDED.json
        `, [params.id, params.name, params.utility, params.installed, params.timezone, JSON.stringify(params.json)]);
        this.invalidateCache(params.id);
    }

    // Utility
    invalidateCache(siteId: string) {
        siteCache.delete(siteId);
    }
}
