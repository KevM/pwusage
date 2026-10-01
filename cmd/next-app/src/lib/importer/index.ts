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
import { withImportLock } from '../import-lock';
import { resolveHistoryRetention, retainedHistoryRange, type ValidHistoryRetentionPolicy } from '../history-retention';

function logSync(msg: string) {
    const ts = new Date().toISOString();
    console.log(`[${ts}] [Importer] ${msg}`);
}

export type { EnergyDataRow } from './energy-transformer';




export interface EnsureDataResult {
    complete: boolean;
    rows: EnergyDataRow[];
    processedWindows: number;
    totalWindows: number;
    historyAvailability?: { status: 'available' | 'partial' | 'unavailable'; availableFrom: string; effectiveDays: 90 | 365 };
}

export class Importer {
    private client: TeslaClient;
    private repo: EnergyRepo;
    private siteRepo: SiteRepo;
    private userRepo: UserRepo;
    private tariffRepo: TariffRepo;
    // Configured policy only, scoped to this importer/request. Grace is evaluated afresh.
    private retentionPolicies = new Map<string, Promise<ValidHistoryRetentionPolicy>>();

    private async retainedRange(site: SiteWithTariffs, start: Date, end: Date) {
        if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end) throw new Error('Invalid history range');
        if (!site.user_id) throw new Error('History retention requires site ownership');
        let policy = this.retentionPolicies.get(site.user_id);
        if (!policy) {
            policy = this.userRepo.getHistoryRetention(site.user_id);
            this.retentionPolicies.set(site.user_id, policy);
        }
        return retainedHistoryRange(await policy, site.timezone, start, end, new Date());
    }


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
        if (!site.user_id) throw new Error('History retention requires site ownership');
        const policy = await this.userRepo.getHistoryRetention(site.user_id);
        const { cutoff } = resolveHistoryRetention(policy, site.timezone, new Date());
        let filteredRows = rows.filter(row => row.site_id === siteId && row.timestamp >= cutoff);
        if (latestTimestamp) {
            const threshold = latestTimestamp.getTime() - 10 * 60 * 1000;
            filteredRows = filteredRows.filter(r => r.timestamp.getTime() >= threshold);
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

    async ensureDataForRange(
        siteId: string,
        start: Date,
        end: Date,
        onProgress?: (msg: string) => void,
        options?: { force?: boolean; maxTimeMs?: number }
    ): Promise<EnsureDataResult> {
        const force = options?.force ?? false;
        const maxTimeMs = options?.maxTimeMs;

        const site = await this.siteRepo.getSite(siteId);
        if (!site) throw new Error(`Site ${siteId} not found in database`);
        const retained = await this.retainedRange(site, start, end);
        if (retained.historyAvailability.status === 'unavailable') {
            return { complete: true, rows: [], processedWindows: 0, totalWindows: 0, historyAvailability: retained.historyAvailability };
        }
        start = retained.start;

        if (Importer.pendingSyncs.has(siteId) && !force) {
            logSync(`Skip: Data for range already being synced for site ${siteId}`);
            return { complete: false, rows: [], processedWindows: 0, totalWindows: 0, historyAvailability: retained.historyAvailability };
        }

        let inMemoryAdded = false;
        if (!force) {
            Importer.pendingSyncs.add(siteId);
            inMemoryAdded = true;
        }

        try {
            if (onProgress) onProgress(`Checking data coverage...`);
            const lockResult = await withImportLock(
                this.siteRepo,
                {
                    siteId,
                    lockDurationMs: 90000, // 90 seconds (resumable chunked requests)
                    force,
                    logLabel: 'Importer',
                },
                async () => {
                    logSync(`Audit Start: ${siteId}, Range: ${start.toISOString()} to ${end.toISOString()}, force=${force}`);

                    const auditStartTime = getSiteMidnight(start, site.timezone);
                    const existingCoverage = await this.repo.getDailyCoverage(
                        siteId,
                        auditStartTime,
                        end,
                        site.timezone
                    );

                    const windows = planImport({
                        requestedRange: { start: auditStartTime, end },
                        existingCoverage,
                        timezone: site.timezone,
                        installationDate: new Date(site.installed),
                        forceRefetch: force,
                    });

                    const allRows: EnergyDataRow[] = [];
                    let successCount = 0;
                    let lastError: Error | null = null;
                    let timeBudgetExceeded = false;
                    const startTime = Date.now();

                    for (let i = 0; i < windows.length; i++) {
                        if (maxTimeMs !== undefined && Date.now() - startTime >= maxTimeMs) {
                            logSync(`Time budget reached (${maxTimeMs}ms) after processing ${successCount}/${windows.length} windows`);
                            timeBudgetExceeded = true;
                            break;
                        }

                        const window = windows[i];
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

                    if (windows.length > 0 && successCount === 0 && !timeBudgetExceeded) {
                        throw lastError || new Error(`All ${windows.length} import windows failed`);
                    }

                    // Complete only when every planned window imported. Failed
                    // windows stay missing in the DB, so the next audit re-plans
                    // them; reporting complete on partial success made the sync
                    // client stop early and silently leave gaps. (windows.length
                    // === 0 is complete: 0 === 0 with no time budget spent.)
                    const isComplete = !timeBudgetExceeded && successCount === windows.length;

                    return {
                        complete: isComplete,
                        rows: allRows,
                        processedWindows: successCount,
                        totalWindows: windows.length,
                        historyAvailability: retained.historyAvailability,
                    };
                }
            );

            if (lockResult.status === 'not-acquired') {
                logSync(`Skip: DB lock busy for site ${siteId}`);
                return { complete: false, rows: [], processedWindows: 0, totalWindows: 0, historyAvailability: retained.historyAvailability };
            }

            return lockResult.value;
        } finally {
            if (inMemoryAdded) {
                Importer.pendingSyncs.delete(siteId);
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

        const retained = await this.retainedRange(site, start, end);
        if (retained.historyAvailability.status === 'unavailable') return [];
        for (const chunk of splitAtSiteMidnight({ start: retained.start, end }, site.timezone)) {
            if (onProgress) onProgress(chunk.start);
            const rows = await this.loadInterval(site, chunk.start, chunk.end, period);
            allRows.push(...rows);
        }
        return allRows;
    }

    async fetchRange(site: SiteWithTariffs, start: Date, end: Date, period: string = "day"): Promise<EnergyDataRow[]> {
        const allRows: EnergyDataRow[] = [];
        const retained = await this.retainedRange(site, start, end);
        if (retained.historyAvailability.status === 'unavailable') return [];
        for (const chunk of splitAtSiteMidnight({ start: retained.start, end }, site.timezone)) {
            const current = await this.retainedRange(site, chunk.start, chunk.end);
            if (current.historyAvailability.status === 'unavailable') continue;
            const cursor = current.start;
            const next = chunk.end;
            const [history, soeHistory] = await Promise.all([
                this.client.getEnergyHistory(site.id, cursor, next, period, site.timezone),
                this.client.getSoeHistory(site.id, cursor, next, period, site.timezone)
                    .catch(error => {
                        console.warn(`[Importer] SOE history fetch failed for ${site.id} (${cursor.toISOString()}-${next.toISOString()})`, error);
                        return [] as SoeHistoryEntry[];
                    })
            ]);

            if (history && history.length > 0) {
                const rows = await this.processHistory(site, history, soeHistory);
                const afterFetch = await this.retainedRange(site, cursor, next);
                allRows.push(...rows.filter(row => row.timestamp >= afterFetch.start && row.timestamp < next));
            }
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
        const allowed = await this.retainedRange(site, start, end);
        if (allowed.historyAvailability.status === 'unavailable') return [];
        start = allowed.start;
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
            const energyDatas = await this.processHistory(site, history, soeHistory);

            // Surgical Filter: Tesla often returns more data than requested (e.g., the whole day).
            // We only want to write the rows that fall within our requested window.
            const retained = await this.retainedRange(site, start, end);
            const filteredDatas = energyDatas.filter(d =>
                d.timestamp.getTime() >= retained.start.getTime() &&
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
            return filteredDatas;
        }
    }

    private async processHistory(
        site: SiteWithTariffs,
        history: EnergyHistoryEntry[],
        soeHistory: SoeHistoryEntry[]
    ): Promise<EnergyDataRow[]> {
        const schedule = new Schedule(site.tariffs, site.timezone);
        return transformEnergyPoints(history, soeHistory, {
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

        const retained = await this.retainedRange(site, start, end);
        if (retained.historyAvailability.status === 'unavailable') return [];
        start = retained.start;
        const existingCoverage = await this.repo.getDailyCoverage(siteId, start, end, site.timezone);
        const now = new Date();

        const days = auditDays({
            requestedRange: { start, end },
            existingCoverage,
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
