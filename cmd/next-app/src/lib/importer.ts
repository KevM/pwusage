import { pool, SiteWithTariffs, TariffSeason, TariffSchedule } from './db';
import { Schedule } from './schedule';
import { TeslaClient, EnergyHistoryEntry, EnergySiteInfo, SoeHistoryEntry } from './tesla-client';
import { EnergyRepo } from './energy-repo';
import { UserRepo } from './user-repo';

import { PoolClient } from 'pg';

function logSync(msg: string) {
    const ts = new Date().toISOString();
    console.log(`[${ts}] [Importer] ${msg}`);
}

export interface EnergyDataRow {
    site_id: string;
    tariff_id: number;
    timestamp: Date;
    load_power: number;
    solar_power: number;
    grid_power: number;
    battery_power: number;
    battery_soc: number | null;
}





export class Importer {
    private client: TeslaClient;
    private repo: EnergyRepo;
    private userRepo: UserRepo;

    // Prevent multiple simultaneous syncs (persist across HMR in dev)
    private static get pendingSyncs(): Set<string> {
        return (global as unknown as { importerPendingSyncs?: Set<string> }).importerPendingSyncs ??= new Set<string>();
    }

    private static get maintenanceCache(): Map<string, number> {
        return (global as unknown as { importerMaintenanceCache?: Map<string, number> }).importerMaintenanceCache ??= new Map<string, number>();
    }

    constructor(client: TeslaClient) {
        this.client = client;
        this.repo = new EnergyRepo();
        this.userRepo = new UserRepo();
    }

    async getTodayData(siteId: string): Promise<EnergyDataRow[]> {
        const site = await this.repo.getSite(siteId);
        if (!site) return [];

        const now = new Date();
        const start = EnergyRepo.getSiteMidnight(now, site.timezone);

        console.log(`[Importer] Fetching today's data: ${start.toISOString()} to ${now.toISOString()}`);

        // We fetch from Tesla. We don't write to DB yet.
        return this.fetchRange(site, start, now, 'day');
    }

    async persistHistory(siteId: string, rows: EnergyDataRow[], latestTimestamp: Date | null) {
        if (rows.length === 0) return;

        const site = await this.repo.getSite(siteId);
        if (!site) return;

        // Surgical Filter: only insert rows around or newer than what we have.
        // We allow a 10-minute overlap to catch any points that might have changed or were synthetic.
        let filteredRows = rows;
        if (latestTimestamp) {
            const threshold = latestTimestamp.getTime() - 10 * 60 * 1000;
            filteredRows = rows.filter(r => r.timestamp.getTime() >= threshold);
        }

        if (filteredRows.length === 0) {
            console.log(`[Importer] No new or updated rows to persist for site ${siteId}`);
            return;
        }

        console.log(`[Importer] Background persisting ${filteredRows.length} rows for site ${siteId} (Filtered from ${rows.length})`);

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await this.insertEnergyData(client, site, filteredRows);
            await client.query('COMMIT');
            console.log(`[Importer] Background persistence complete for site ${siteId}`);
        } catch (e) {
            await client.query('ROLLBACK');
            console.error(`[Importer] Background persistence failed for site ${siteId}`, e);
        } finally {
            client.release();
        }
    }

    /**
     * Lightweight version of ensureDataForRange for active dashboard users.
     * Only checks the last ~1 hour of data to ensure the 'Today' chart and totals are fresh.
     * Avoids full-day coverage checks and gap loops for historical data.
     */
    async ensureRecentData(siteId: string, onProgress?: (msg: string) => void, latestKnown?: Date): Promise<{ rows: EnergyDataRow[], latestTimestamp: Date | null }> {
        if (Importer.pendingSyncs.has(siteId)) {
            if (onProgress) onProgress(`Skip: Sync already in progress.`);
            return { rows: [], latestTimestamp: null };
        }
        Importer.pendingSyncs.add(siteId);

        try {
            const site = await this.repo.getSite(siteId);
            if (!site) return { rows: [], latestTimestamp: null };

            const now = new Date();

            let fetchStart: Date;
            let latest: Date | null = null;

            if (latestKnown) {
                latest = latestKnown;
            } else {
                const latestRes = await pool.query(`
                    SELECT timestamp FROM "EnergyData"
                    WHERE site_id = $1
                    AND timestamp <= NOW()
                    ORDER BY timestamp DESC LIMIT 1
                `, [siteId]);
                if (latestRes.rows.length > 0) {
                    latest = new Date(latestRes.rows[0].timestamp);
                }
            }

            if (!latest) {
                // No data at all? Start from site midnight (UTC)
                fetchStart = EnergyRepo.getSiteMidnight(now, site.timezone);
            } else {
                const diffMinutes = (now.getTime() - latest.getTime()) / (60 * 1000);

                console.log(`[Importer] Latest data point: ${latest.toISOString()}. Age: ${diffMinutes.toFixed(1)}m`);

                if (diffMinutes <= 15) {
                    // Already fresh
                    if (onProgress) onProgress(`Data is fresh (${diffMinutes.toFixed(1)}m old).`);
                    return { rows: [], latestTimestamp: latest };
                }

                // SURGICAL: Fetch from the last point we have, with a 10 min overlap to catch updates
                fetchStart = new Date(latest.getTime() - 10 * 60 * 1000);
            }

            // 2. Data is stale, fetch just the surgical slice
            const sliceStr = latest ? "surgical slice" : "initial daily sweep";
            if (onProgress) onProgress(`Refreshing ${sliceStr} (${fetchStart.toISOString().substring(11, 16)} to now)...`);

            // We fetch from the gap start to NOW.
            const rows = await this.importRange(siteId, fetchStart, now, 'day');
            return { rows, latestTimestamp: latest };
        } finally {
            Importer.pendingSyncs.delete(siteId);
        }
    }

    async ensureDataForRange(siteId: string, start: Date, end: Date, onProgress?: (msg: string) => void, options?: { force?: boolean }): Promise<EnergyDataRow[]> {
        const force = options?.force ?? false;
        if (Importer.pendingSyncs.has(siteId) && !force) {
            logSync(`Skip: Data for range already being synced for site ${siteId}`);
            return [];
        }
        if (!force) Importer.pendingSyncs.add(siteId);
        logSync(`Audit Start: ${siteId}, Range: ${start.toISOString()} to ${end.toISOString()}, force=${force}`);

        try {
            const allRows: EnergyDataRow[] = [];
            if (onProgress) onProgress(`Checking data coverage...`);
            const force = options?.force ?? false;
            const site = await this.repo.getSite(siteId);
            if (!site) throw new Error(`Site ${siteId} not found in database`);

            // Initialize cursor to site-timezone midnight (matching todayStart logic)
            let cursor = EnergyRepo.getSiteMidnight(start, site.timezone);

            // Clamp cursor to installation date
            const installDate = new Date(site.installed);
            const installMidnight = EnergyRepo.getSiteMidnight(installDate, site.timezone);
            if (cursor.getTime() < installMidnight.getTime()) {
                console.log(`[Importer] Clamping start date to installation: ${installMidnight.toISOString()}`);
                cursor = installMidnight;
            }

            const now = new Date();
            // todayStart represents 00:00 of the current day in the SITE'S timezone
            const todayStart = EnergyRepo.getSiteMidnight(now, site.timezone);

            const rangeStartStr = cursor.toISOString();
            const rangeEndStr = end.toISOString();

            // One query to rule them all
            const rowsRes = await pool.query(`
            SELECT timestamp FROM "EnergyData" 
            WHERE site_id = $1 
            AND timestamp >= $2 
            AND timestamp < $3
            ORDER BY timestamp ASC
        `, [siteId, rangeStartStr, rangeEndStr]);

            const existingTimestamps = rowsRes.rows.map((r: { timestamp: string | Date }) => new Date(r.timestamp).getTime());
            let tsIndex = 0;

            const todayKey = new Intl.DateTimeFormat('en-CA', { timeZone: site.timezone }).format(todayStart);

            while (cursor.getTime() <= end.getTime()) {
                const dateKey = new Intl.DateTimeFormat('en-CA', { timeZone: site.timezone }).format(cursor);
                const isToday = dateKey === todayKey;

                const windowStart = cursor.getTime();
                const nextDay = EnergyRepo.getSiteMidnight(new Date(windowStart + 30 * 60 * 60 * 1000), site.timezone);
                const windowEnd = nextDay.getTime();

                while (tsIndex < existingTimestamps.length && existingTimestamps[tsIndex] < windowStart) {
                    tsIndex++;
                }

                // Find min/max timestamps in this window to determine coverage
                let firstInWindow: number | null = null;
                let lastInWindow: number | null = null;
                let countInWindow = 0;

                let tempIdx = tsIndex;
                while (tempIdx < existingTimestamps.length && existingTimestamps[tempIdx] < windowEnd) {
                    if (firstInWindow === null) firstInWindow = existingTimestamps[tempIdx];
                    lastInWindow = existingTimestamps[tempIdx];
                    countInWindow++;
                    tempIdx++;
                }

                const hasAnyData = countInWindow > 0;

                let needsImport = false;

                if (!hasAnyData || force) {
                    needsImport = true;
                } else {
                    const threshold = 30 * 60 * 1000;
                    const missingStart = firstInWindow && (firstInWindow - windowStart > threshold);
                    const effectiveWindowEnd = isToday ? now.getTime() : windowEnd;
                    const missingEnd = lastInWindow && (effectiveWindowEnd - lastInWindow > threshold);

                    if (missingStart || missingEnd) {
                        const type = missingStart ? (missingEnd ? 'full' : 'start') : 'end';
                        logSync(`Gap detected for ${dateKey} (${type}). windowStart: ${new Date(windowStart).toISOString()}, windowEnd: ${new Date(windowEnd).toISOString()}, first: ${firstInWindow ? new Date(firstInWindow).toISOString() : 'null'}, last: ${lastInWindow ? new Date(lastInWindow).toISOString() : 'null'}`);

                        // AGGRESSIVE: If any gap, fetch the whole 24h day window.
                        // This ensures Tesla returns the 5-minute intervals correctly.
                        const rows = await this.importRange(siteId, new Date(windowStart), new Date(windowEnd), 'day');
                        allRows.push(...rows);
                        logSync(`Aggressive Day Sync complete for ${dateKey}: ${rows.length} rows`);
                    } else {
                        logSync(`No Gap detected for ${dateKey}. Count: ${countInWindow}`);
                    }
                }


                if (needsImport) {
                    const dateStr = cursor.toISOString().split('T')[0];
                    if (onProgress) onProgress(`Importing ${dateStr}...`);
                    logSync(`Gap/Stale detected/forced for ${dateStr}. Importing...`);

                    let importEnd = nextDay;
                    if (isToday) importEnd = now;

                    const rows = await this.importRange(siteId, cursor, importEnd, 'day');
                    allRows.push(...rows);
                }

                cursor = nextDay;
            }

            // Store maintenance time
            Importer.maintenanceCache.set(siteId, Date.now());
            return allRows;
        } finally {
            Importer.pendingSyncs.delete(siteId);
        }
    }

    /**
     * Helper to check if maintenance is needed
     */
    static shouldRunMaintenance(siteId: string): boolean {
        const last = Importer.maintenanceCache.get(siteId) || 0;
        const oneHour = 60 * 60 * 1000;
        return (Date.now() - last) > oneHour;
    }

    async importRange(siteId: string, start: Date, end: Date, period: string = "day", onProgress?: (date: Date) => void): Promise<EnergyDataRow[]> {
        const allRows: EnergyDataRow[] = [];
        const site = await this.repo.getSite(siteId);
        if (!site) {
            console.error(`Site ${siteId} not found for importRange`);
            throw new Error(`Site ${siteId} not found in database`);
        }

        let cursor = new Date(start);
        const chunkMs = 24 * 60 * 60 * 1000;

        while (cursor < end) {
            // Find next chunk boundary (24h) or end
            let next = new Date(Math.min(cursor.getTime() + chunkMs, end.getTime()));

            // CRITICAL: Tesla's calendar_history endpoint often fails to return 5-minute data 
            // if the range crosses a UTC midnight boundary. 
            // We'll detect if this chunk crosses UTC midnight and split it there.
            const utcMidnight = new Date(cursor.getTime());
            utcMidnight.setUTCHours(23, 59, 59, 999);
            const nextUtcMidnight = new Date(utcMidnight.getTime() + 1);

            if (nextUtcMidnight > cursor && nextUtcMidnight < next) {
                logSync(`Splitting range at UTC midnight: ${nextUtcMidnight.toISOString()}`);
                next = nextUtcMidnight;
            }

            if (onProgress) onProgress(cursor);

            const rows = await this.loadInterval(site, cursor, next, period);
            allRows.push(...rows);
            cursor = next;
        }
        return allRows;
    }

    async fetchRange(site: SiteWithTariffs, start: Date, end: Date, period: string = "day"): Promise<EnergyDataRow[]> {
        const allRows: EnergyDataRow[] = [];
        let cursor = new Date(start);
        const chunkMs = 24 * 60 * 60 * 1000;

        while (cursor < end) {
            const next = new Date(Math.min(cursor.getTime() + chunkMs, end.getTime()));

            const history = await this.client.getEnergyHistory(site.id, cursor, next, period, site.timezone);
            let soeHistory: SoeHistoryEntry[] = [];
            try {
                soeHistory = await this.client.getSoeHistory(site.id, cursor, next, period, site.timezone);
            } catch (error) {
                console.warn(`[Importer] SOE history fetch failed for ${site.id} (${cursor.toISOString()}-${next.toISOString()})`, error);
            }
            if (history && history.length > 0) {
                const rows = await this.processHistory(null as unknown as PoolClient, site, history, soeHistory, period);
                allRows.push(...rows);
            }
            cursor = next;
        }
        return allRows;
    }

    async ensureSite(siteId: string): Promise<SiteWithTariffs | undefined> {
        try {
            const info = await this.client.getEnergySiteInfo(siteId);

            // Update last_checked_at since we successfully called the API
            const siteForUser = await this.repo.getSite(siteId);
            if (siteForUser?.user_id) {
                await this.userRepo.updateLastChecked(siteForUser.user_id);
            }

            const existingSiteRes = await pool.query('SELECT json FROM "Site" WHERE id = $1', [siteId]);
            const existingSite = existingSiteRes.rows[0];
            let tariffsChanged = true;

            if (existingSite && existingSite.json) {
                try {
                    const existingInfo = existingSite.json as EnergySiteInfo;

                    // Use canonical stringify to prevent flapping on key order differences
                    const canonicalize = (obj: unknown): string => {
                        if (obj === null || typeof obj !== 'object') {
                            return JSON.stringify(obj);
                        }
                        if (Array.isArray(obj)) {
                            return '[' + obj.map(canonicalize).join(',') + ']';
                        }
                        const keys = Object.keys(obj as object).sort();
                        return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalize((obj as Record<string, unknown>)[k])).join(',') + '}';
                    };

                    if (canonicalize(existingInfo.tariff_content_v2) === canonicalize(info.tariff_content_v2)) {
                        tariffsChanged = false;
                    }
                } catch {
                    // ignore
                }
            }

            await pool.query(`
                INSERT INTO "Site"(id, name, updated, installed, timezone, json)
                VALUES ($1, $2, NOW(), $3, $4, $5)
                ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name, installed=EXCLUDED.installed, timezone=EXCLUDED.timezone, json=EXCLUDED.json
            `, [siteId, info.site_name, info.installation_date, info.installation_time_zone, JSON.stringify(info)]);

            if (tariffsChanged) {
                console.log(`Tariff content changed for site ${siteId}, updating tariffs...`);
                // Use a client for atomicity of tariff replacement
                const client = await pool.connect();
                try {
                    await client.query('BEGIN');

                    const tariffIdsRes = await client.query('SELECT id FROM "Tariff" WHERE site_id = $1', [siteId]);
                    const tariffIds = tariffIdsRes.rows;

                    for (const t of tariffIds) {
                        await client.query('DELETE FROM "TariffSchedule" WHERE season_id IN (SELECT id FROM "TariffSeason" WHERE tariff_id = $1)', [t.id]);
                        await client.query('DELETE FROM "TariffSeason" WHERE tariff_id = $1', [t.id]);
                    }
                    await client.query('DELETE FROM "Tariff" WHERE site_id = $1', [siteId]);

                    await this.updateTariffs(client, siteId, info);

                    await client.query('COMMIT');
                } catch (e) {
                    await client.query('ROLLBACK');
                    throw e;
                } finally {
                    client.release();
                }
            } else {
                console.log(`Tariff content unchanged for site ${siteId}, skipping tariff update.`);
            }

            // Invalidate cache to ensure subsequent fetches get the new/confirmed schema/json
            this.repo.invalidateCache(siteId);

            return this.repo.getSite(siteId);
        } catch (e: unknown) {
            const errorMsg = e instanceof Error ? e.message : String(e);
            if (errorMsg.includes('401') || errorMsg.includes('login_required')) {
                const siteForUser = await this.repo.getSite(siteId);
                if (siteForUser?.user_id) {
                    console.warn(`[Import] Auth error in ensureSite for user ${siteForUser.user_id}, marking revoked`);
                    await this.userRepo.updateUserStatus(siteForUser.user_id, 'revoked', false);
                }
            }
            console.error(`Error ensuring site ${siteId}`, e);
            throw e;
        }
    }

    private async updateTariffs(client: PoolClient, siteId: string, info: EnergySiteInfo) {
        // ... (Similar logic but using client.query)
        if (!info.tariff_content_v2) {
            await this.ensureDefaultTariff(client, siteId, 'Default Rate');
            return;
        }

        const tariffContent = info.tariff_content_v2;
        for (const seasonName in tariffContent.seasons) {
            const seasonData = tariffContent.seasons[seasonName];
            const tariffName = tariffContent.utility ?? info.site_name ?? 'Utility Tariff';

            let fixedSeasonName = seasonName;
            const sFrom = seasonData.fromMonth;
            if (seasonName.toLowerCase() === 'summer' && (sFrom >= 10 || sFrom <= 2)) {
                fixedSeasonName = 'Winter';
            } else if (seasonName.toLowerCase() === 'winter' && (sFrom >= 5 && sFrom <= 9)) {
                fixedSeasonName = 'Summer';
            }

            await client.query(`
                INSERT INTO "Tariff"(site_id, name, updated)
                VALUES ($1, $2, NOW())
                ON CONFLICT(site_id, name) DO UPDATE SET name=EXCLUDED.name
            `, [siteId, tariffName]);

            const tariffRowRes = await client.query(`SELECT id FROM "Tariff" WHERE site_id = $1 AND name = $2`, [siteId, tariffName]);
            const tariffRow = tariffRowRes.rows[0];

            await client.query(`
                INSERT INTO "TariffSeason"(tariff_id, name, from_month, from_day, to_month, to_day, buy_rate, sell_rate)
                VALUES ($1, $2, $3, $4, $5, $6, 0, 0)
            `, [tariffRow.id, fixedSeasonName, seasonData.fromMonth, seasonData.fromDay, seasonData.toMonth, seasonData.toDay]);

            const seasonRowRes = await client.query(`SELECT id FROM "TariffSeason" WHERE tariff_id = $1 AND name = $2`, [tariffRow.id, fixedSeasonName]);
            const seasonRow = seasonRowRes.rows[0];

            const seasonBuyRates = tariffContent.energy_charges?.[seasonName]?.rates ?? {};
            const seasonSellRates = tariffContent.sell_tariff?.energy_charges?.[seasonName]?.rates ?? {};
            const defaultBuyRate = 0;
            const defaultSellRate = 0;

            for (const touName in seasonData.tou_periods) {
                const periodGroup = seasonData.tou_periods[touName];
                const touBuyRate = seasonBuyRates[touName] ?? defaultBuyRate;
                const touSellRate = seasonSellRates[touName] ?? defaultSellRate;

                if (!periodGroup.periods) continue;

                for (const p of periodGroup.periods) {
                    await client.query(`
                        INSERT INTO "TariffSchedule"(season_id, name, buy_rate, sell_rate, from_day_of_week, to_day_of_week, from_hour, from_minute, to_hour, to_minute)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                    `, [
                        seasonRow.id,
                        touName,
                        touBuyRate,
                        touSellRate,
                        p.fromDayOfWeek,
                        p.toDayOfWeek,
                        p.fromHour,
                        p.fromMinute,
                        p.toHour,
                        p.toMinute
                    ]);
                }
            }
        }
    }

    private async ensureDefaultTariff(client: PoolClient, siteId: string, name: string) {
        await client.query(`
            INSERT INTO "Tariff"(site_id, name, updated)
            VALUES ($1, $2, NOW())
            ON CONFLICT(site_id, name) DO UPDATE SET name=EXCLUDED.name
        `, [siteId, name]);

        const tariffRowRes = await client.query(`SELECT id FROM "Tariff" WHERE site_id = $1 AND name = $2`, [siteId, name]);
        const tariffRow = tariffRowRes.rows[0];

        if (tariffRow) {
            await client.query(`DELETE FROM "TariffSchedule" WHERE season_id IN (SELECT id FROM "TariffSeason" WHERE tariff_id = $1)`, [tariffRow.id]);
            await client.query(`DELETE FROM "TariffSeason" WHERE tariff_id = $1`, [tariffRow.id]);
            await this.ensureDefaultSeasonAndSchedule(client, tariffRow.id, 0, 0);
        }
    }

    private async ensureDefaultSeasonAndSchedule(client: PoolClient, tariffId: number, buyRate: number, sellRate: number) {
        await client.query(`
            INSERT INTO "TariffSeason"(tariff_id, name, from_month, from_day, to_month, to_day, buy_rate, sell_rate)
            VALUES ($1, 'All Year', 1, 1, 12, 31, $2, $3)
            ON CONFLICT DO NOTHING
        `, [tariffId, buyRate, sellRate]);

        const seasonRowRes = await client.query(`SELECT id FROM "TariffSeason" WHERE tariff_id = $1 LIMIT 1`, [tariffId]);
        const seasonRow = seasonRowRes.rows[0];

        if (seasonRow) {
            await this.ensureDefaultSchedule(client, seasonRow.id, buyRate, sellRate, 'Default');
        }
    }

    private async ensureDefaultSchedule(client: PoolClient, seasonId: number, buyRate: number, sellRate: number, name: string = 'Default') {
        const hasSchRes = await client.query(`SELECT 1 FROM "TariffSchedule" WHERE season_id = $1 LIMIT 1`, [seasonId]);
        if (hasSchRes.rows.length === 0) {
            await client.query(`
                INSERT INTO "TariffSchedule"(season_id, name, buy_rate, sell_rate, from_day_of_week, to_day_of_week, from_hour, to_hour)
                VALUES ($1, $2, $3, $4, 0, 6, 0, 24)
            `, [seasonId, name, buyRate, sellRate]);
        }
    }

    private async loadInterval(site: SiteWithTariffs, start: Date, end: Date, period: string): Promise<EnergyDataRow[]> {
        let actualEnd = new Date(end);

        if (period === 'day' || period === 'hour') {
            // Tesla API can be finicky about exact midnight boundaries for full days.
            // Subtracting 1s ensures we are safely within the previous day's data availability window.
            actualEnd = new Date(actualEnd.getTime() - 1000);
        }

        console.log(`[Import] loadInterval ${start.toISOString()} - ${actualEnd.toISOString()} (${period})`);
        let history;
        try {
            history = await this.client.getEnergyHistory(site.id, start, actualEnd, period, site.timezone);
        } catch (err: unknown) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            if (errorMsg.includes('401') || errorMsg.includes('login_required')) {
                console.warn(`[Import] Auth error for user ${site.user_id}, marking as revoked`);
                if (site.user_id) {
                    await this.userRepo.updateUserStatus(site.user_id, 'revoked', false);
                    this.repo.invalidateCache(site.id);
                }
            }
            throw err;
        }
        let soeHistory: SoeHistoryEntry[] = [];
        try {
            soeHistory = await this.client.getSoeHistory(site.id, start, actualEnd, period, site.timezone);
        } catch (error) {
            console.warn(`[Importer] SOE history fetch failed for ${site.id} (${start.toISOString()}-${actualEnd.toISOString()})`, error);
        }

        // Update last_checked_at if we successfully called the API
        if (history && site.user_id) {
            await this.userRepo.updateLastChecked(site.user_id);
        }

        console.log(`[Import] History Rows Fetched: ${history?.length ?? 0}`);


        if (!history || history.length === 0) {
            // No data from Tesla - just return empty array
            // Installation date clamping prevents unnecessary requests
            console.log(`[Importer] No data from Tesla for ${start.toISOString()}.`);
            return [];
        }
        else {
            const client = await pool.connect();
            try {
                const msg1 = `[Import] Insert Transaction Start. History Rows: ${history.length}`;
                console.log(msg1);

                await client.query('BEGIN');

                // SURGICAL: We no longer delete the whole day. 
                // We rely on ON CONFLICT DO UPDATE to refresh points and overwrite synthetic zeros.
                const energyDatas = await this.processHistory(client, site, history, soeHistory, period);

                // Surgical Filter: Tesla often returns more data than requested (e.g., the whole day).
                // We only want to write the rows that fall within our requested window.
                const filteredDatas = energyDatas.filter(d =>
                    d.timestamp.getTime() >= start.getTime() &&
                    d.timestamp.getTime() <= actualEnd.getTime()
                );

                const msg2 = `[Import] Processed EnergyData Rows: ${filteredDatas.length} (Filtered from ${energyDatas.length})`;
                console.log(msg2);

                await this.insertEnergyData(client, site, filteredDatas);

                await client.query('COMMIT');
                return energyDatas;
            } catch (e) {
                await client.query('ROLLBACK');
                throw e;
            } finally {
                client.release();
            }
        }
    }

    private async processHistory(client: PoolClient, site: SiteWithTariffs, history: EnergyHistoryEntry[], soeHistory: SoeHistoryEntry[], period: string = 'day'): Promise<EnergyDataRow[]> {
        const schedule = new Schedule(site.tariffs, site.timezone);
        const results: EnergyDataRow[] = [];
        const socByTimestamp = new Map<number, number>();
        const socTimestamps: number[] = [];

        for (const row of soeHistory) {
            const ts = new Date(row.timestamp).getTime();
            if (Number.isNaN(ts)) continue;
            socByTimestamp.set(ts, row.percentage_charged);
            socTimestamps.push(ts);
        }
        socTimestamps.sort((a, b) => a - b);

        for (let i = 0; i < history.length; i++) {
            const h = history[i];
            const ts = new Date(h.timestamp);

            let durationHours = 24;
            if (i < history.length - 1) {
                const nextTs = new Date(history[i + 1].timestamp).getTime();
                durationHours = (nextTs - ts.getTime()) / (3600 * 1000);
            } else if (i > 0) {
                const prevTs = new Date(history[i - 1].timestamp).getTime();
                durationHours = (ts.getTime() - prevTs) / (3600 * 1000);
            }

            const scale = (period === 'day' && durationHours > 20) ? 1000 : 1;

            // Map historical energy fields
            const hSolar = (h.total_solar_generation || h.solar_energy_exported) ?? 0;
            const hHome = h.total_home_usage ?? 0;

            const tp = this.getTariffPeriodOrFallback(site, schedule, ts);
            if (!tp) {
                continue;
            }

            const gridImported = h.grid_energy_imported ?? 0;
            const gridExported = h.total_grid_energy_exported ?? 0;
            let grid = gridImported;
            if (grid === 0) grid = -gridExported;

            const batteryCharge = h.total_battery_charge ?? 0;
            const batteryDischarge = h.total_battery_discharge ?? 0;
            let battery = batteryCharge;
            if (battery === 0) battery = -batteryDischarge;

            const tsMs = ts.getTime();
            const exactSoc = socByTimestamp.get(tsMs);
            const nearestSoc = exactSoc ?? this.findNearestSoeValue(tsMs, socTimestamps, socByTimestamp);

            results.push({
                site_id: site.id,
                tariff_id: Number(tp.tariff.id),
                timestamp: ts, // We'll format this for DB later
                load_power: hHome * scale,
                solar_power: hSolar * scale,
                grid_power: grid * scale,
                battery_power: battery * scale,
                battery_soc: nearestSoc
            });
        }
        return results;
    }

    private findNearestSoeValue(targetMs: number, sortedSoeTimestamps: number[], socByTimestamp: Map<number, number>): number | null {
        if (sortedSoeTimestamps.length === 0) return null;

        const maxDistanceMs = 5 * 60 * 1000;
        let lo = 0;
        let hi = sortedSoeTimestamps.length - 1;

        while (lo < hi) {
            const mid = Math.floor((lo + hi) / 2);
            if (sortedSoeTimestamps[mid] < targetMs) lo = mid + 1;
            else hi = mid;
        }

        const candidates: number[] = [];
        candidates.push(sortedSoeTimestamps[lo]);
        if (lo > 0) candidates.push(sortedSoeTimestamps[lo - 1]);
        if (lo + 1 < sortedSoeTimestamps.length) candidates.push(sortedSoeTimestamps[lo + 1]);

        let bestTimestamp: number | null = null;
        let bestDistance = Number.POSITIVE_INFINITY;
        for (const candidate of candidates) {
            const distance = Math.abs(candidate - targetMs);
            if (distance < bestDistance) {
                bestDistance = distance;
                bestTimestamp = candidate;
            }
        }

        if (bestTimestamp === null || bestDistance > maxDistanceMs) return null;
        return socByTimestamp.get(bestTimestamp) ?? null;
    }


    private getTariffPeriodOrFallback(site: SiteWithTariffs, schedule: Schedule, ts: Date) {
        const tp = schedule.getTariffPeriod(ts);
        if (tp) return tp;

        const fallbackTariff = site.tariffs[0];
        if (!fallbackTariff) return null;

        const season: TariffSeason = {
            id: -1,
            tariff_id: fallbackTariff.id,
            name: 'Fallback',
            from_month: 1,
            from_day: 1,
            to_month: 12,
            to_day: 31,
            buy_rate: fallbackTariff.seasons?.[0]?.buy_rate ?? 0,
            sell_rate: fallbackTariff.seasons?.[0]?.sell_rate ?? 0
        };

        const sched: TariffSchedule = {
            id: -1,
            season_id: season.id,
            name: 'Fallback',
            buy_rate: 0,
            sell_rate: 0,
            from_day_of_week: 0,
            to_day_of_week: 6,
            from_hour: 0,
            from_minute: 0,

            to_hour: 24,
            to_minute: 0,

        };

        return {
            start: ts,
            end: ts,
            tariff: fallbackTariff,
            season,
            schedule: sched
        };
    }



    private async insertEnergyData(client: PoolClient, site: SiteWithTariffs, data: EnergyDataRow[]) {
        const validRows: EnergyDataRow[] = [];

        // 1. Get current DB tariffs (Name -> ID) to handle rotation
        const tariffRes = await client.query('SELECT id, name FROM "Tariff" WHERE site_id = $1', [site.id]);
        const dbTariffMap = new Map<string, number>(); // Name -> New ID
        tariffRes.rows.forEach((r) => {
            if (r.name) dbTariffMap.set(r.name, r.id);
        });

        // 2. Map local/stale IDs to Names
        const localTariffMap = new Map<number, string>(); // Old ID -> Name
        site.tariffs.forEach(t => {
            if (t.name) localTariffMap.set(t.id, t.name);
        });

        const remappedIds = new Map<number, number>(); // Old ID -> New ID

        for (const row of data) {
            let finalTariffId = row.tariff_id;

            // Check if ID is valid (exists in DB ids)
            // We can check if it's in the values of dbTariffMap
            // Efficient check: build a set of valid IDs?
            // Actually, let's just resolve everything.

            // If we haven't resolved this ID yet
            if (!remappedIds.has(row.tariff_id)) {
                // Check if current ID exists in DB (direct match)
                // We need a helper for ID -> exists.
                // Or just try to find it.

                const isDirectMatch = Array.from(dbTariffMap.values()).includes(row.tariff_id);

                if (isDirectMatch) {
                    remappedIds.set(row.tariff_id, row.tariff_id);
                } else {
                    // Try to map by name
                    const name = localTariffMap.get(row.tariff_id);
                    if (name && dbTariffMap.has(name)) {
                        const newId = dbTariffMap.get(name)!;
                        console.log(`[Import] Remapping stale tariff ID ${row.tariff_id} ("${name}") -> ${newId}`);
                        remappedIds.set(row.tariff_id, newId);
                    } else {
                        // Cannot resolve
                        console.warn(`[Import] Cannot resolve tariff ID ${row.tariff_id} (Name: "${name}")`);
                        remappedIds.set(row.tariff_id, -1);
                    }
                }
            }

            finalTariffId = remappedIds.get(row.tariff_id)!;

            if (finalTariffId !== -1) {
                // Update the row's tariff_id in place or create copy? 
                // Creating a shallow clone is safer if we reuse data, but we don't here.
                // We can modify the row object if we push it to validRows.
                // Actually, let's just make a new object or modify if safe.
                row.tariff_id = finalTariffId;
                validRows.push(row);
            } else {
                // Count skips
            }
        }

        console.log(`[Import] Valid Rows to Insert: ${validRows.length} / ${data.length}`);

        if (validRows.length === 0) return;

        const chunks: EnergyDataRow[][] = [];
        const chunkSize = 1000; // Safe batch size
        for (let i = 0; i < validRows.length; i += chunkSize) {
            chunks.push(validRows.slice(i, i + chunkSize));
        }

        console.log(`[Import] Batching ${validRows.length} rows into ${chunks.length} chunks.`);

        for (const chunk of chunks) {
            const values: (string | number | Date | null)[] = [];
            const placeholders: string[] = [];
            let pIdx = 1;

            for (const row of chunk) {
                placeholders.push(`($${pIdx}, $${pIdx + 1}, $${pIdx + 2}, $${pIdx + 3}, $${pIdx + 4}, $${pIdx + 5}, $${pIdx + 6}, $${pIdx + 7})`);
                values.push(
                    row.site_id,
                    row.tariff_id,
                    row.timestamp,
                    row.load_power,
                    row.solar_power,
                    row.grid_power,
                    row.battery_power,
                    row.battery_soc
                );
                pIdx += 8;
            }

            const query = `
                INSERT INTO "EnergyData"(site_id, tariff_id, timestamp, load_power, solar_power, grid_power, battery_power, battery_soc) 
                VALUES ${placeholders.join(', ')}
                ON CONFLICT(timestamp, site_id, tariff_id) DO UPDATE SET
                    load_power=EXCLUDED.load_power,
                    solar_power=EXCLUDED.solar_power,
                    grid_power=EXCLUDED.grid_power,
                    battery_power=EXCLUDED.battery_power,
                    battery_soc=COALESCE(EXCLUDED.battery_soc, "EnergyData".battery_soc)
            `;

            await client.query(query, values);
        }
    }

    async auditRange(siteId: string, start: Date, end: Date) {
        const repo = new EnergyRepo();
        const site = await repo.getSite(siteId);
        if (!site) return { error: 'Site not found' };

        const rowsRes = await pool.query(`
            SELECT timestamp FROM "EnergyData" 
            WHERE site_id = $1 AND timestamp >= $2 AND timestamp < $3
            ORDER BY timestamp ASC
        `, [siteId, start.toISOString(), end.toISOString()]);

        const existingTimestamps = rowsRes.rows.map((r: { timestamp: string | Date }) => new Date(r.timestamp).getTime());
        const auditResults: Record<string, unknown>[] = [];

        let cursor = EnergyRepo.getSiteMidnight(start, site.timezone);
        const now = new Date();
        let tsIndex = 0;

        while (cursor.getTime() < end.getTime()) {
            const windowStart = cursor.getTime();
            const nextDay = EnergyRepo.getSiteMidnight(new Date(windowStart + 30 * 60 * 60 * 1000), site.timezone);
            const windowEnd = nextDay.getTime();
            const isToday = EnergyRepo.getSiteMidnight(now, site.timezone).getTime() === windowStart;

            while (tsIndex < existingTimestamps.length && existingTimestamps[tsIndex] < windowStart) {
                tsIndex++;
            }

            let firstInWindow: number | null = null;
            let lastInWindow: number | null = null;
            let countInWindow = 0;
            let tempIdx = tsIndex;
            while (tempIdx < existingTimestamps.length && existingTimestamps[tempIdx] < windowEnd) {
                if (firstInWindow === null) firstInWindow = existingTimestamps[tempIdx];
                lastInWindow = existingTimestamps[tempIdx];
                countInWindow++;
                tempIdx++;
            }

            const threshold = 30 * 60 * 1000;
            const missingStart = firstInWindow && (firstInWindow - windowStart > threshold);
            const effectiveWindowEnd = isToday ? now.getTime() : windowEnd;
            const missingEnd = lastInWindow && (effectiveWindowEnd - lastInWindow > threshold);

            auditResults.push({
                date: new Intl.DateTimeFormat('en-CA', { timeZone: site.timezone }).format(cursor),
                isToday,
                count: countInWindow,
                first: firstInWindow ? new Date(firstInWindow).toISOString() : null,
                last: lastInWindow ? new Date(lastInWindow).toISOString() : null,
                windowStart: new Date(windowStart).toISOString(),
                windowEnd: new Date(windowEnd).toISOString(),
                effectiveWindowEnd: new Date(effectiveWindowEnd).toISOString(),
                missingStart,
                missingEnd,
                gapMs: lastInWindow ? effectiveWindowEnd - lastInWindow : null
            });

            cursor = nextDay;
        }

        return auditResults;
    }
}
