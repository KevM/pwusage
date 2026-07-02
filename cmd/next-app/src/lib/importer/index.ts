import { SiteWithTariffs, TariffSeason, TariffSchedule } from '../db';
import { Schedule } from '../schedule';
import { TeslaClient, EnergyHistoryEntry, EnergySiteInfo, SoeHistoryEntry, isTeslaAuthError } from '../tesla-client';
import { EnergyRepo } from '../energy-repo';
import { SiteRepo } from '../site-repo';
import { UserRepo } from '../user-repo';
import { TariffRepo } from '../tariff-repo';
import { parseTariffContent, buildDefaultTariff } from './tariff-parser';
import { transformEnergyPoints, type EnergyDataRow } from './energy-transformer';
import { planImport, splitAtSiteMidnight, auditDays } from './import-planner';
import { getSiteMidnight } from '../date-utils';

function logSync(msg: string) {
    const ts = new Date().toISOString();
    console.log(`[${ts}] [Importer] ${msg}`);
}

export type { EnergyDataRow } from './energy-transformer';




export class Importer {
    private client: TeslaClient;
    private repo: EnergyRepo;
    private siteRepo: SiteRepo;
    private userRepo: UserRepo;
    private tariffRepo: TariffRepo;


    // Prevent multiple simultaneous syncs (persist across HMR in dev)
    private static get pendingSyncs(): Set<string> {
        return (global as unknown as { importerPendingSyncs?: Set<string> }).importerPendingSyncs ??= new Set<string>();
    }



    constructor(client: TeslaClient) {
        this.client = client;
        this.repo = new EnergyRepo();
        this.siteRepo = new SiteRepo();
        this.userRepo = new UserRepo();
        this.tariffRepo = new TariffRepo();
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

    async persistHistory(siteId: string, rows: EnergyDataRow[], latestTimestamp: Date | null): Promise<number> {
        if (rows.length === 0) return 0;

        const site = await this.siteRepo.getSite(siteId);
        if (!site) return 0;

        // Surgical Filter: only insert rows around or newer than what we have.
        // We allow a 10-minute overlap to catch any points that might have changed or were synthetic.
        let filteredRows = rows;
        if (latestTimestamp) {
            const threshold = latestTimestamp.getTime() - 10 * 60 * 1000;
            filteredRows = rows.filter(r => r.timestamp.getTime() >= threshold);
        }

        if (filteredRows.length === 0) {
            console.log(`[Importer] No new or updated rows to persist for site ${siteId}`);
            return 0;
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
        })));
        console.log(`[Importer] Background persistence complete for site ${siteId}`);
        return filteredRows.length;
    }

    async ensureDataForRange(siteId: string, start: Date, end: Date, onProgress?: (msg: string) => void, options?: { force?: boolean }): Promise<EnergyDataRow[]> {
        const force = options?.force ?? false;
        if (Importer.pendingSyncs.has(siteId) && !force) {
            logSync(`Skip: Data for range already being synced for site ${siteId}`);
            return [];
        }

        let inMemoryAdded = false;
        if (!force) {
            Importer.pendingSyncs.add(siteId);
            inMemoryAdded = true;
        }

        const lockId = crypto.randomUUID();
        let dbLockAcquired = false;

        try {
            if (onProgress) onProgress(`Checking data coverage...`);
            const site = await this.siteRepo.getSite(siteId);
            if (!site) throw new Error(`Site ${siteId} not found in database`);

            const acquired = await this.siteRepo.acquireImportLock({
                siteId,
                lockId,
                lockDurationMs: 300000, // 5 minutes for full range sync
                force
            });

            if (!acquired) {
                logSync(`Skip: DB lock busy for site ${siteId}`);
                return [];
            }
            dbLockAcquired = true;

            logSync(`Audit Start: ${siteId}, Range: ${start.toISOString()} to ${end.toISOString()}, force=${force}`);

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
            let successCount = 0;
            let lastError: Error | null = null;

            for (const window of windows) {
                const dateStr = window.start.toISOString().split('T')[0];
                if (onProgress) onProgress(`Importing ${dateStr}...`);
                logSync(`Importing window: ${window.start.toISOString()} - ${window.end.toISOString()}`);
                try {
                    const rows = await this.importRange(siteId, window.start, window.end, 'day');
                    allRows.push(...rows);
                    successCount++;
                } catch (error) {
                    console.error(`[Importer] Failed to import window ${window.start.toISOString()} - ${window.end.toISOString()}:`, error);
                    if (onProgress) onProgress(`Error importing ${dateStr}: ${error instanceof Error ? error.message : String(error)}`);
                    lastError = error instanceof Error ? error : new Error(String(error));
                }
            }

            if (windows.length > 0 && successCount === 0) {
                throw lastError || new Error(`All ${windows.length} import windows failed`);
            }

            return allRows;
        } finally {
            if (inMemoryAdded) {
                Importer.pendingSyncs.delete(siteId);
            }
            if (dbLockAcquired) {
                try {
                    await this.siteRepo.releaseImportLock(siteId, lockId);
                } catch (err) {
                    console.error(`[Importer] Failed to release DB import lock for site ${siteId}:`, err);
                }
            }
        }
    }

    async importRange(siteId: string, start: Date, end: Date, period: string = 'day', onProgress?: (date: Date) => void): Promise<EnergyDataRow[]> {
        const allRows: EnergyDataRow[] = [];
        const site = await this.siteRepo.getSite(siteId);
        if (!site) {
            console.error(`Site ${siteId} not found for importRange`);
            throw new Error(`Site ${siteId} not found in database`);
        }

        for (const chunk of splitAtSiteMidnight({ start, end }, site.timezone)) {
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

            const [history, soeHistory] = await Promise.all([
                this.client.getEnergyHistory(site.id, cursor, next, period, site.timezone),
                this.client.getSoeHistory(site.id, cursor, next, period, site.timezone)
                    .catch(error => {
                        console.warn(`[Importer] SOE history fetch failed for ${site.id} (${cursor.toISOString()}-${next.toISOString()})`, error);
                        return [] as SoeHistoryEntry[];
                    })
            ]);

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
                await this.tariffRepo.addTariffVersion(siteId, parsed);
            } else {
                console.log(`Tariff content unchanged for site ${siteId}, skipping tariff update.`);
            }

            // Invalidate cache to ensure subsequent fetches get the new/confirmed schema/json
            this.siteRepo.invalidateCache(siteId);

            return this.siteRepo.getSite(siteId);
        } catch (e: unknown) {
            if (isTeslaAuthError(e)) {
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
        let actualEnd = new Date(end);

        if (period === 'day' || period === 'hour') {
            // Tesla API can be finicky about exact midnight boundaries for full days.
            // Subtracting 1s ensures we are safely within the previous day's data availability window.
            actualEnd = new Date(actualEnd.getTime() - 1000);
        }

        console.log(`[Import] loadInterval ${start.toISOString()} - ${actualEnd.toISOString()} (${period})`);
        let history: EnergyHistoryEntry[] = [];
        let soeHistory: SoeHistoryEntry[] = [];

        try {
            const [historyRes, soeRes] = await Promise.all([
                this.client.getEnergyHistory(site.id, start, actualEnd, period, site.timezone),
                this.client.getSoeHistory(site.id, start, actualEnd, period, site.timezone)
                    .catch(error => {
                        console.warn(`[Importer] SOE history fetch failed for ${site.id} (${start.toISOString()}-${actualEnd.toISOString()})`, error);
                        return [] as SoeHistoryEntry[];
                    })
            ]);
            history = historyRes;
            soeHistory = soeRes;
        } catch (err: unknown) {
            if (isTeslaAuthError(err)) {
                console.warn(`[Import] Auth error for user ${site.user_id}, marking as revoked`);
                if (site.user_id) {
                    await this.userRepo.updateUserStatus(site.user_id, 'revoked', false);
                    this.siteRepo.invalidateCache(site.id);
                }
            }
            throw err;
        }

        // Update last_checked_at if we successfully called the API
        if (history && history.length > 0 && site.user_id) {
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
