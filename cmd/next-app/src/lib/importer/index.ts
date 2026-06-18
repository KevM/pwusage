import { SiteWithTariffs, TariffSeason, TariffSchedule } from '../db';
import { Schedule } from '../schedule';
import { TeslaClient, EnergyHistoryEntry, EnergySiteInfo, SoeHistoryEntry } from '../tesla-client';
import { EnergyRepo } from '../energy-repo';
import { SiteRepo } from '../site-repo';
import { UserRepo } from '../user-repo';
import { TariffRepo } from '../tariff-repo';
import { parseTariffContent, buildDefaultTariff } from './tariff-parser';
import { transformEnergyPoints, type EnergyDataRow } from './energy-transformer';
import { planImport, splitAtUtcMidnight, auditDays } from './import-planner';
import { getSiteMidnight } from '../date-utils';
import { localDateKey } from '../battery-provenance/local-day';

function logSync(msg: string) {
    const ts = new Date().toISOString();
    console.log(`[${ts}] [Importer] ${msg}`);
}

/**
 * Tesla's calendar_history returns no time_series when end_date is the exact
 * next-midnight boundary for a full-day ('day'/'hour') request. Subtracting 1s
 * keeps the request safely inside the requested day's data window. Both the
 * within-retention (loadInterval) and pre-retention backfill (fetchRange) paths
 * must apply this or full days come back empty.
 */
export function clampDayBoundaryEnd(end: Date, period: string): Date {
    if (period === 'day' || period === 'hour') {
        return new Date(end.getTime() - 1000);
    }
    return end;
}

export type { EnergyDataRow } from './energy-transformer';




export interface ImporterOptions {
    /** Fetch Tesla SOE history alongside energy history (populates battery_soc).
     *  Defaults to true. Disable for high-volume backfill workflows to halve
     *  Tesla API calls and avoid 429s — SOE is optional for rollups. */
    fetchSoe?: boolean;
}

export class Importer {
    private client: TeslaClient;
    private repo: EnergyRepo;
    private siteRepo: SiteRepo;
    private userRepo: UserRepo;
    private tariffRepo: TariffRepo;
    private fetchSoe: boolean;


    // Prevent multiple simultaneous syncs (persist across HMR in dev)
    private static get pendingSyncs(): Set<string> {
        return (global as unknown as { importerPendingSyncs?: Set<string> }).importerPendingSyncs ??= new Set<string>();
    }

    private static get maintenanceCache(): Map<string, number> {
        return (global as unknown as { importerMaintenanceCache?: Map<string, number> }).importerMaintenanceCache ??= new Map<string, number>();
    }

    constructor(client: TeslaClient, options?: ImporterOptions) {
        this.client = client;
        this.repo = new EnergyRepo();
        this.siteRepo = new SiteRepo();
        this.userRepo = new UserRepo();
        this.tariffRepo = new TariffRepo();
        this.fetchSoe = options?.fetchSoe ?? true;
    }


    async getTodayData(siteId: string): Promise<EnergyDataRow[]> {
        const site = await this.siteRepo.getSite(siteId);
        if (!site) return [];

        const now = new Date();
        const start = EnergyRepo.getSiteMidnight(now, site.timezone);

        console.log(`[Importer] Fetching today's data: ${start.toISOString()} to ${now.toISOString()}`);

        // We fetch from Tesla. We don't write to DB yet.
        return this.fetchRange(site, start, now, 'day');
    }

    async persistHistory(siteId: string, rows: EnergyDataRow[], latestTimestamp: Date | null) {
        if (rows.length === 0) return;

        const site = await this.siteRepo.getSite(siteId);
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

        await this.repo.insertEnergyDataBatch(filteredRows.map(row => ({
            site_id: row.site_id,
            tariff_id: row.tariff_id,
            tariff_schedule_id: row.tariff_schedule_id ?? null,
            timestamp: row.timestamp,
            load_power: row.load_power,
            solar_power: row.solar_power,
            grid_power: row.grid_power,
            battery_power: row.battery_power,
            battery_soc: row.battery_soc,
            battery_charge_from_solar: row.battery_charge_from_solar,
            battery_charge_from_grid: row.battery_charge_from_grid,
        })));
        console.log(`[Importer] Background persistence complete for site ${siteId}`);
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
            const site = await this.siteRepo.getSite(siteId);
            if (!site) return { rows: [], latestTimestamp: null };

            const now = new Date();

            let fetchStart: Date;
            let latest: Date | null = null;

            if (latestKnown) {
                latest = latestKnown;
            } else {
                const latestRow = await this.repo.getLatestTimestamp(siteId);
                if (latestRow) {
                    latest = latestRow;
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
            if (onProgress) onProgress(`Checking data coverage...`);
            const site = await this.siteRepo.getSite(siteId);
            if (!site) throw new Error(`Site ${siteId} not found in database`);

            const auditStartTime = getSiteMidnight(start, site.timezone);
            const existingTimestamps = await this.repo.getExistingTimestamps(
                siteId,
                auditStartTime,
                end
            );

            const windows = planImport({
                requestedRange: { start: auditStartTime, end },
                existingTimestamps,
                timezone: site.timezone,
                installationDate: new Date(site.installed),
                forceRefetch: force,
            });

            const allRows: EnergyDataRow[] = [];
            for (const window of windows) {
                const dateStr = window.start.toISOString().split('T')[0];
                if (onProgress) onProgress(`Importing ${dateStr}...`);
                logSync(`Importing window: ${window.start.toISOString()} - ${window.end.toISOString()}`);
                const rows = await this.importRange(siteId, window.start, window.end, 'day');
                allRows.push(...rows);
            }

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

    async importRange(siteId: string, start: Date, end: Date, period: string = 'day', onProgress?: (date: Date) => void): Promise<EnergyDataRow[]> {
        const allRows: EnergyDataRow[] = [];
        const site = await this.siteRepo.getSite(siteId);
        if (!site) {
            console.error(`Site ${siteId} not found for importRange`);
            throw new Error(`Site ${siteId} not found in database`);
        }

        for (const chunk of splitAtUtcMidnight({ start, end })) {
            if (onProgress) onProgress(chunk.start);
            const rows = await this.loadInterval(site, chunk.start, chunk.end, period);
            allRows.push(...rows);
        }
        return allRows;
    }

    async fetchRange(site: SiteWithTariffs, start: Date, end: Date, period: string = "day"): Promise<EnergyDataRow[]> {
        const allRows: EnergyDataRow[] = [];
        let cursor = new Date(start);
        const chunkMs = 24 * 60 * 60 * 1000;

        while (cursor < end) {
            const next = new Date(Math.min(cursor.getTime() + chunkMs, end.getTime()));
            const fetchEnd = clampDayBoundaryEnd(next, period);

            const history = await this.client.getEnergyHistory(site.id, cursor, fetchEnd, period, site.timezone);
            let soeHistory: SoeHistoryEntry[] = [];
            if (this.fetchSoe) {
                try {
                    soeHistory = await this.client.getSoeHistory(site.id, cursor, fetchEnd, period, site.timezone);
                } catch (error) {
                    console.warn(`[Importer] SOE history fetch failed for ${site.id} (${cursor.toISOString()}-${fetchEnd.toISOString()})`, error);
                }
            }
            if (history && history.length > 0) {
                const rows = await this.processHistory(
                    site,
                    history,
                    soeHistory,
                    period,
                    (next.getTime() - cursor.getTime()) / (3600 * 1000)
                );
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
            const siteForUser = await this.siteRepo.getSite(siteId);
            if (siteForUser?.user_id) {
                await this.userRepo.updateLastChecked(siteForUser.user_id);
            }

            const existingJson = await this.siteRepo.getSiteJson(siteId);
            let tariffsChanged = true;

            if (existingJson) {
                try {
                    const existingInfo = existingJson as EnergySiteInfo;

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

            await this.siteRepo.upsertSite({
                id: siteId,
                name: info.site_name,
                utility: info.tariff_content_v2?.utility ?? null,
                installed: info.installation_date,
                timezone: info.installation_time_zone,
                json: info,
            });

            if (tariffsChanged) {
                console.log(`Tariff content changed for site ${siteId}, updating tariffs...`);
                const parsed = info.tariff_content_v2
                    ? parseTariffContent(info.tariff_content_v2, info.site_name ?? 'Utility Tariff')
                    : buildDefaultTariff('Default Rate');
                const detectionDate = localDateKey(new Date(), info.installation_time_zone);
                const installDate = localDateKey(new Date(info.installation_date), info.installation_time_zone);
                await this.tariffRepo.addTariffVersion(siteId, parsed, detectionDate, installDate);
            } else {
                console.log(`Tariff content unchanged for site ${siteId}, skipping tariff update.`);
            }

            // Invalidate cache to ensure subsequent fetches get the new/confirmed schema/json
            this.siteRepo.invalidateCache(siteId);

            return this.siteRepo.getSite(siteId);
        } catch (e: unknown) {
            const errorMsg = e instanceof Error ? e.message : String(e);
            if (errorMsg.includes('401') || errorMsg.includes('login_required')) {
                const siteForUser = await this.siteRepo.getSite(siteId);
                if (siteForUser?.user_id) {
                    console.warn(`[Import] Auth error in ensureSite for user ${siteForUser.user_id}, marking revoked`);
                    await this.userRepo.updateUserStatus(siteForUser.user_id, 'revoked', false);
                }
            }
            console.error(`Error ensuring site ${siteId}`, e);
            throw e;
        }
    }

    private async loadInterval(site: SiteWithTariffs, start: Date, end: Date, period: string): Promise<EnergyDataRow[]> {
        const actualEnd = clampDayBoundaryEnd(end, period);

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
                    this.siteRepo.invalidateCache(site.id);
                }
            }
            throw err;
        }
        let soeHistory: SoeHistoryEntry[] = [];
        if (this.fetchSoe) {
            try {
                soeHistory = await this.client.getSoeHistory(site.id, start, actualEnd, period, site.timezone);
            } catch (error) {
                console.warn(`[Importer] SOE history fetch failed for ${site.id} (${start.toISOString()}-${actualEnd.toISOString()})`, error);
            }
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
            const energyDatas = await this.processHistory(
                site,
                history,
                soeHistory,
                period,
                (actualEnd.getTime() - start.getTime()) / (3600 * 1000)
            );

            // Surgical Filter: Tesla often returns more data than requested (e.g., the whole day).
            // We only want to write the rows that fall within our requested window.
            const filteredDatas = energyDatas.filter(d =>
                d.timestamp.getTime() >= start.getTime() &&
                d.timestamp.getTime() <= actualEnd.getTime()
            );

            const msg2 = `[Import] Processed EnergyData Rows: ${filteredDatas.length} (Filtered from ${energyDatas.length})`;
            console.log(msg2);

            await this.repo.insertEnergyDataBatch(filteredDatas.map(row => ({
                site_id: row.site_id,
                tariff_id: row.tariff_id,
                tariff_schedule_id: row.tariff_schedule_id,
                timestamp: row.timestamp,
                load_power: row.load_power,
                solar_power: row.solar_power,
                grid_power: row.grid_power,
                battery_power: row.battery_power,
                battery_soc: row.battery_soc,
                battery_charge_from_solar: row.battery_charge_from_solar,
                battery_charge_from_grid: row.battery_charge_from_grid,
            })));
            return energyDatas;
        }
    }

    private async processHistory(
        site: SiteWithTariffs,
        history: EnergyHistoryEntry[],
        soeHistory: SoeHistoryEntry[],
        period: string = 'day',
        requestedDurationHours: number = 24
    ): Promise<EnergyDataRow[]> {
        const schedule = new Schedule(site.tariffs, site.timezone);
        return transformEnergyPoints(history, soeHistory, period, requestedDurationHours, {
            siteId: site.id,
            getTariffId: (ts: Date) => {
                const tp = this.getTariffPeriodOrFallback(site, schedule, ts);
                return tp ? Number(tp.tariff.id) : null;
            },
            getTariffScheduleId: (ts: Date) => {
                const tp = this.getTariffPeriodOrFallback(site, schedule, ts);
                // Only return schedule ID if it's not the synthetic fallback (id=-1)
                // Fallback periods should have NULL schedule ID to maintain FK integrity
                if (!tp) return null;
                const schedId = Number(tp.schedule.id);
                return schedId >= 0 ? schedId : null;
            },
        });
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





    async auditRange(siteId: string, start: Date, end: Date) {
        const site = await this.siteRepo.getSite(siteId);
        if (!site) return { error: 'Site not found' };

        const existingTimestamps = await this.repo.getExistingTimestamps(siteId, start, end);
        const now = new Date();

        const days = auditDays({
            requestedRange: { start, end },
            existingTimestamps,
            timezone: site.timezone,
            now,
        });

        return days.map(d => ({
            date: new Intl.DateTimeFormat('en-CA', { timeZone: site.timezone }).format(d.windowStart),
            isToday: d.isToday,
            count: d.count,
            first: d.firstInWindow ? new Date(d.firstInWindow).toISOString() : null,
            last: d.lastInWindow ? new Date(d.lastInWindow).toISOString() : null,
            windowStart: d.windowStart.toISOString(),
            windowEnd: d.windowEnd.toISOString(),
            effectiveWindowEnd: d.effectiveWindowEnd.toISOString(),
            missingStart: d.missingStart,
            missingEnd: d.missingEnd,
            gapMs: d.lastInWindow ? d.effectiveWindowEnd.getTime() - d.lastInWindow : null,
        }));
    }
}
