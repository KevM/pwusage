import { pool, Site, SiteWithTariffs, Tariff, TariffSeason } from './db';
import { getRequestContext } from './request-context';
import { latestStoredSampleSql } from './latest-stored-sample-sql';
import { UPSERT_SITE_SQL } from './site-upsert-sql';

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

export interface SiteHistoryOverview {
    id: string;
    name: string;
    timezone: string;
    installed: Date;
    owner_email: string | null;
    history_backfill_from: Date | null;
    history_migrated_at: Date | null;
    archived_days: number;
    first_archived_day: Date | null;
    last_archived_day: Date | null;
    last_energy_at: Date | null;
}

const SITE_BASE_COLUMNS = 'id, user_id, name, utility, updated, installed, timezone, billing_start_day, timezone_display_mode, sankey_renderer, last_live_refresh_at, last_live_claim_at, live_status_cache';
const SITE_COLUMNS_WITH_JSON = `${SITE_BASE_COLUMNS}, json`;

/** A site gap-heal checks, with its owner's last auth outage window. */
export type GapHealSite = { id: string; timezone: string; installed: Date; auth_lost_at: Date | null; auth_restored_at: Date | null };

export class SiteRepo {
    // === Queries ===
    /** One narrow row for the fast foreground path; no tariff tree or site JSON. */
    async getLiveRefreshState(siteId: string): Promise<Pick<Site, 'id' | 'last_live_refresh_at' | 'live_status_cache'> | undefined> {
        const { rows } = await pool.query<Pick<Site, 'id' | 'last_live_refresh_at' | 'live_status_cache'>>(`
            SELECT id, last_live_refresh_at, live_status_cache
            FROM "Site"
            WHERE id = $1
        `, [siteId]);
        return rows[0];
    }

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
        const tokenCols = options?.includeTokens ? ', u.access_token, u.refresh_token, u.auth_status, u.fleet_api_base_url, u.tesla_refresh_state, u.refresh_lock_expires' : '';
        const userJoin = options?.includeTokens ? 'LEFT JOIN "User" u ON u.id = s.user_id' : '';
        // Site-level columns are fetched one row per site, separately from the
        // tariff tree. Selecting them through the Site × Tariff × Season ×
        // Schedule join repeats the wide values (json blob, Tesla tokens,
        // live_status_cache) on every join row, multiplying DB egress by the
        // schedule count on hot paths like the TRMNL markup poll.
        const siteSql = `
            SELECT
                s.id, s.user_id, s.name, s.utility, s.updated, s.installed,
                s.timezone, s.billing_start_day, s.timezone_display_mode, s.sankey_renderer,
                s.last_live_refresh_at, s.last_live_claim_at, s.live_status_cache${jsonCol}${tokenCols}
            FROM "Site" s
            ${userJoin}
            WHERE s.id = ANY($1::text[])
        `;
        const tariffSql = `
            SELECT
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
            FROM "Tariff" t
            LEFT JOIN "TariffSeason"   ts  ON ts.tariff_id  = t.id
            LEFT JOIN "TariffSchedule" sch ON sch.season_id = ts.id
            WHERE t.site_id = ANY($1::text[]) AND t.is_current
        `;
        const [siteRes, tariffRes] = await Promise.all([
            pool.query(siteSql, [siteIds]),
            pool.query(tariffSql, [siteIds]),
        ]);
        return this.assembleFromRows(siteRes.rows, tariffRes.rows, options);
    }

    private assembleFromRows(
        siteRows: Record<string, unknown>[],
        tariffRows: Record<string, unknown>[],
        options?: SiteQueryOptions
    ): SiteWithTariffs[] {
        // Tariff/season IDs are global serial PKs — safe to use as cross-site map keys.
        const siteMap = new Map<string, SiteWithTariffs>();
        const tariffMap = new Map<number, Tariff>();
        const seasonMap = new Map<number, TariffSeason>();

        for (const row of siteRows) {
            const siteId = row.id as string;
            if (siteMap.has(siteId)) continue;
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
                last_live_refresh_at: row.last_live_refresh_at != null ? Number(row.last_live_refresh_at) : undefined,
                last_live_claim_at: row.last_live_claim_at != null ? Number(row.last_live_claim_at) : undefined,
                live_status_cache: row.live_status_cache ?? undefined,
                json: options?.includeJson ? row.json : undefined,
                access_token: options?.includeTokens ? (row.access_token as string | null) ?? null : undefined,
                refresh_token: options?.includeTokens ? (row.refresh_token as string | null) ?? null : undefined,
                tesla_refresh_state: options?.includeTokens ? row.tesla_refresh_state as SiteWithTariffs['tesla_refresh_state'] : undefined,
                refresh_lock_expires: options?.includeTokens ? Number(row.refresh_lock_expires) : undefined,
                auth_status: options?.includeTokens ? (row.auth_status as string | null) ?? null : undefined,
                fleet_api_base_url: options?.includeTokens ? (row.fleet_api_base_url as string | null) ?? null : undefined,
                tariffs: [],
            });
        }

        for (const row of tariffRows) {
            const site = siteMap.get(row.tariff_site_id as string);
            if (!site || row.tariff_id == null) continue;
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

    /**
     * Sites in recent use or whose last auth outage ended recently, whose owner
     * can still call Tesla (active, has a
     * refresh token, not revoked), least recently imported first so a
     * time-bounded gap heal round-robins across runs. "In use" means a live
     * status refresh since `activeSinceMs`: only demand paths set it (web,
     * mobile, TRMNL markup, active battery holds), never the heal itself.
     * A restore since `restoredSinceMs` also qualifies an idle site, provided
     * the last recorded outage ended and the account is currently active.
     */
    async getSitesForGapHeal(activeSinceMs: number, restoredSinceMs: number): Promise<GapHealSite[]> {
        const { rows } = await pool.query<GapHealSite>(`
            SELECT s.id, s.timezone, s.installed, u.auth_lost_at, u.auth_restored_at
            FROM "Site" s
            JOIN "User" u ON u.id = s.user_id
            WHERE u.is_active = true
              AND u.refresh_token IS NOT NULL
              AND u.auth_status IS DISTINCT FROM 'revoked'
              AND u.tesla_refresh_state = 'ready'
              AND (s.last_live_refresh_at >= $1
                   OR (u.auth_status = 'active'
                       AND u.auth_lost_at IS NOT NULL
                       AND u.auth_restored_at > u.auth_lost_at
                       AND u.auth_restored_at >= to_timestamp($2::double precision / 1000)))
            ORDER BY s.last_import_at ASC NULLS FIRST, s.id
        `, [activeSinceMs, restoredSinceMs]);
        return rows;
    }

    async getSites(options?: SiteQueryOptions): Promise<Site[]> {
        const columns = options?.includeJson ? SITE_COLUMNS_WITH_JSON : SITE_BASE_COLUMNS;
        const { rows } = await pool.query(`SELECT ${columns} FROM "Site"`);
        return rows as Site[];
    }

    /**
     * Currency code for a site, extracted from Site.json in SQL so hot paths
     * (TRMNL markup polls) don't transfer the whole EnergySiteInfo blob just
     * to read one field.
     */
    async getSiteCurrencyCode(siteId: string): Promise<string | null> {
        const res = await pool.query(
            `SELECT json -> 'tariff_content_v2' ->> 'currency' AS currency FROM "Site" WHERE id = $1`,
            [siteId]
        );
        return res.rows[0]?.currency ?? null;
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
        name?: string | null;
        utility?: string | null;
        installed?: Date | string | null;
        timezone?: string | null;
        json?: unknown;
    }): Promise<string | undefined> {
        const name = (params.name && params.name.trim() !== '') ? params.name.trim() : 'Unnamed Site';
        const timezone = (params.timezone && params.timezone.trim() !== '') ? params.timezone.trim() : 'UTC';
        const hasInstalled = params.installed !== undefined && params.installed !== null && params.installed !== '';
        const installed = hasInstalled ? params.installed! : new Date().toISOString();

        const { rows } = await pool.query<{ timezone: string }>(UPSERT_SITE_SQL,
            [params.id, name, params.utility ?? null, installed, timezone, JSON.stringify(params.json ?? {}), hasInstalled]);
        this.invalidateCache(params.id);
        return rows?.[0]?.timezone;
    }


    async acquireImportLock(params: {
        siteId: string;
        lockId: string;
        lockDurationMs?: number;
        force?: boolean;
        minIntervalMs?: number;
    }): Promise<boolean> {
        const { siteId, lockId, lockDurationMs = 60000, force = false, minIntervalMs = 0 } = params;
        const now = Date.now();
        const expires = now + lockDurationMs;

        if (force) {
            const result = await pool.query(`
                UPDATE "Site"
                SET import_lock_id = $1, import_lock_expires = $2, last_import_at = $3
                WHERE id = $4
            `, [lockId, expires, now, siteId]);
            return (result.rowCount ?? 0) > 0;
        }

        const result = await pool.query(`
            UPDATE "Site"
            SET import_lock_id = $1, import_lock_expires = $2, last_import_at = $3
            WHERE id = $4 
              AND (import_lock_id IS NULL OR import_lock_expires < $5)
              AND (last_import_at IS NULL OR $5 - last_import_at >= $6)
        `, [lockId, expires, now, siteId, now, minIntervalMs]);
        return (result.rowCount ?? 0) > 0;
    }

    async releaseImportLock(siteId: string, lockId: string): Promise<boolean> {
        const result = await pool.query(`
            UPDATE "Site"
            SET import_lock_id = NULL, import_lock_expires = 0
            WHERE id = $1 AND import_lock_id = $2
        `, [siteId, lockId]);
        return (result.rowCount ?? 0) > 0;
    }

    /**
     * Atomically claim the right to refresh a site's live status across
     * serverless instances, using last_live_claim_at as a dedicated claim
     * marker so last_live_refresh_at is kept separate and only updated when
     * live_status_cache is actually written. Returns false when another
     * instance refreshed or claimed within minIntervalMs.
     */
    async claimLiveRefresh(siteId: string, nowMs: number, minIntervalMs: number): Promise<boolean> {
        const result = await pool.query(`
            UPDATE "Site"
            SET last_live_claim_at = $1
            WHERE id = $2
              AND (last_live_claim_at IS NULL OR last_live_claim_at <= $3)
        `, [nowMs, siteId, nowMs - minIntervalMs]);
        this.invalidateCache(siteId);
        return (result.rowCount ?? 0) > 0;
    }

    /**
     * Undo a claimLiveRefresh after a failed fetch. Compare-and-set on the
     * claim value so a fresher write (e.g. a concurrent force refresh that
     * already called updateLiveStatusCache) is never clobbered.
     */
    async releaseLiveRefreshClaim(siteId: string, claimMs: number, previousMs: number | null): Promise<void> {
        await pool.query(`
            UPDATE "Site"
            SET last_live_claim_at = $1
            WHERE id = $2 AND last_live_claim_at = $3
        `, [previousMs, siteId, claimMs]);
        this.invalidateCache(siteId);
    }


    async getImportStatus(siteId: string): Promise<{ isImporting: boolean; lastImportAt: number }> {
        const res = await pool.query('SELECT import_lock_id, import_lock_expires, last_import_at FROM "Site" WHERE id = $1', [siteId]);
        if (res.rows.length === 0) {
            return { isImporting: false, lastImportAt: 0 };
        }
        const row = res.rows[0];
        const now = Date.now();
        const isImporting = !!(row.import_lock_id && Number(row.import_lock_expires) >= now);
        const lastImportAt = row.last_import_at ? Number(row.last_import_at) : 0;
        return { isImporting, lastImportAt };
    }

    async updateLiveStatusCache(siteId: string, status: unknown, fetchedAt: number): Promise<void> {
        await pool.query(`
            UPDATE "Site"
            SET live_status_cache = $1, last_live_refresh_at = $2
            WHERE id = $3
        `, [JSON.stringify(status), fetchedAt, siteId]);
        this.invalidateCache(siteId);
    }

    /**
     * First site-local day worth backfilling from Tesla. `installed` is the
     * hardware install; the days before utility provisioning never have data.
     * Kept out of SITE_BASE_COLUMNS: only history backfill reads it.
     */
    async getHistoryBackfillFrom(siteId: string): Promise<Date | null> {
        const { rows } = await pool.query<{ history_backfill_from: Date | null }>(
            'SELECT history_backfill_from FROM "Site" WHERE id = $1',
            [siteId]
        );
        return rows[0]?.history_backfill_from ?? null;
    }

    async setHistoryBackfillFrom(siteId: string, from: Date): Promise<void> {
        await pool.query(`
            UPDATE "Site"
            SET history_backfill_from = $2
            WHERE id = $1 AND (history_backfill_from IS NULL OR history_backfill_from < $2)
        `, [siteId, from]);
    }

    /** Stamped by scripts/migrate-site-history.ts after a complete --apply run. */
    async setHistoryMigratedAt(siteId: string, at: Date): Promise<void> {
        await pool.query('UPDATE "Site" SET history_migrated_at = $2 WHERE id = $1', [siteId, at]);
    }

    /**
     * Admin view of each site's history migration: owner, migration marker,
     * compact-archive coverage and latest energy sample. Ordered as the
     * migration's work queue: unmigrated sites with data in the last 7 days
     * first, then unmigrated sites gone quiet, then migrated sites; oldest
     * install first within each group. The archive aggregate reads only the
     * (site_id, day_start) primary key, never the archive payloads; the latest
     * sample (raw rows or day records) is two index lookups per site.
     */
    async getHistoryOverview(): Promise<SiteHistoryOverview[]> {
        const { rows } = await pool.query<SiteHistoryOverview>(`
            SELECT s.id, s.name, s.timezone, s.installed, u.email AS owner_email,
                s.history_backfill_from, s.history_migrated_at,
                COALESCE(a.archived_days, 0)::int AS archived_days,
                a.first_archived_day, a.last_archived_day, e.last_energy_at
            FROM "Site" s
            LEFT JOIN "User" u ON u.id = s.user_id
            LEFT JOIN (
                SELECT site_id, count(*) AS archived_days,
                    min(day_start) AS first_archived_day, max(day_start) AS last_archived_day
                FROM "EnergyDayArchive" WHERE status IS DISTINCT FROM 'empty' GROUP BY site_id
            ) a ON a.site_id = s.id
            LEFT JOIN LATERAL (SELECT ${latestStoredSampleSql('s.id')} AS last_energy_at) e ON true
            ORDER BY s.history_migrated_at IS NOT NULL,
                (e.last_energy_at >= now() - interval '7 days') IS NOT TRUE,
                s.installed ASC, s.id
        `);
        return rows;
    }

    // Utility
    invalidateCache(siteId: string) {
        siteCache.delete(siteId);
    }
}
