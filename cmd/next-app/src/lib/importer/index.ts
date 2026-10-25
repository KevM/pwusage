import { SiteWithTariffs, TariffSeason, TariffSchedule } from '../db';
import { Schedule } from '../schedule';
import { TeslaClient, EnergyHistoryEntry, EnergySiteInfo, SoeHistoryEntry, isTeslaAuthError } from '../tesla-client';
import { EnergyRepo } from '../energy-repo';
import { compactDayWritesEnabled, createEnergyRepo } from '../energy-repo-factory';
import { SiteRepo } from '../site-repo';
import { UserRepo } from '../user-repo';
import { TariffRepo } from '../tariff-repo';
import { parseTariffContent, buildDefaultTariff } from './tariff-parser';
import { transformEnergyPoints, type EnergyDataRow } from './energy-transformer';
import { planImport, splitAtSiteMidnight, auditDays, type DateWindow, type PlannedWindow } from './import-planner';
import { addDaysInSiteTimezone, getSiteMidnight } from '../date-utils';
import { withImportLock } from '../import-lock';
import { archiveHealedDays } from '../healed-day-archive';
import { pool } from '../db';
import { CompactHistoryStore } from '../prototypes/compact-history-store';
import { fetchDayForWrite } from '../prototypes/compact-day-fetch';
import { isDayFetchFinal } from '../tesla-sample-timing';

function logSync(msg: string) {
    const ts = new Date().toISOString();
    console.log(`[${ts}] [Importer] ${msg}`);
}

export type { EnergyDataRow } from './energy-transformer';




/**
 * Audit stored coverage for [site midnight of `start`, `end`) and return the
 * day windows planImport says must be fetched. Needs no Tesla client, so a
 * caller can skip token and site loads when nothing is missing.
 */
export async function planMissingWindows(
    rawRepo: EnergyRepo,
    site: { id: string; timezone: string; installed: Date | string },
    start: Date,
    end: Date,
    force = false
): Promise<PlannedWindow[]> {
    const auditStartTime = getSiteMidnight(start, site.timezone);
    const existingCoverage = await createEnergyRepo(site.timezone, rawRepo).getDailyCoverage(
        site.id,
        auditStartTime,
        end,
        site.timezone
    );
    return planImport({
        requestedRange: { start: auditStartTime, end },
        existingCoverage,
        timezone: site.timezone,
        installationDate: new Date(site.installed),
        forceRefetch: force,
        refetchOpenDays: compactDayWritesEnabled(),
    });
}

/** Where the importer writes v2 day records when day writes are on. */
export type DayRecordStore = Pick<CompactHistoryStore, 'writeDay' | 'getDayRecordState'>;

export interface EnsureDataResult {
    complete: boolean;
    rows: EnergyDataRow[];
    processedWindows: number;
    totalWindows: number;
}

export class Importer {
    private client: TeslaClient;
    private repo: EnergyRepo;
    private siteRepo: SiteRepo;
    private userRepo: UserRepo;
    private tariffRepo: TariffRepo;
    private dayStore?: DayRecordStore;


    // Prevent multiple simultaneous syncs (persist across HMR in dev)
    private static get pendingSyncs(): Set<string> {
        return (global as unknown as { importerPendingSyncs?: Set<string> }).importerPendingSyncs ??= new Set<string>();
    }



    constructor(client: TeslaClient, dayStore?: DayRecordStore) {
        this.client = client;
        this.dayStore = dayStore;
        this.repo = new EnergyRepo();
        this.siteRepo = new SiteRepo();
        this.userRepo = new UserRepo();
        this.tariffRepo = new TariffRepo();
    }


    /**
     * Fetch today's rows (site-local midnight → now). When `latestTimestamp`
     * (the newest stored row) is before today's midnight, also fetch the rest of
     * yesterday: otherwise the last refresh before midnight (~22:50) leaves
     * 22:55–23:55 unimported forever, since the next refresh only asks for the
     * new day. Bounded to one extra day; older gaps are left to planImport.
     */
    async getTodayData(siteId: string, latestTimestamp?: Date | null): Promise<EnergyDataRow[]> {
        const site = await this.siteRepo.getSite(siteId);
        if (!site) return [];

        const now = new Date();
        const start = EnergyRepo.getSiteMidnight(now, site.timezone);
        const tailStart = this.previousDayTailStart(latestTimestamp, start, site.timezone);

        console.log(`[Importer] Fetching today's data: ${start.toISOString()} to ${now.toISOString()}`);

        // We fetch from Tesla. We don't write to DB yet.
        const [tail, today] = await Promise.all([
            tailStart ? this.fetchPreviousDayTail(site, tailStart, start) : Promise.resolve([]),
            this.fetchRange(site, start, now, 'day'),
        ]);
        return [...tail, ...today];
    }

    private previousDayTailStart(latestTimestamp: Date | null | undefined, todayMidnight: Date, timezone: string): Date | null {
        if (!latestTimestamp) return null;
        // The last 5-minute sample of a day is 23:55, so a row within 5 min of midnight means the tail is complete.
        if (latestTimestamp.getTime() + 5 * 60 * 1000 >= todayMidnight.getTime()) return null;
        const yesterdayMidnight = EnergyRepo.getSiteMidnight(new Date(todayMidnight.getTime() - 1), timezone);
        return latestTimestamp > yesterdayMidnight ? latestTimestamp : yesterdayMidnight;
    }

    private async fetchPreviousDayTail(site: SiteWithTariffs, start: Date, todayMidnight: Date): Promise<EnergyDataRow[]> {
        console.log(`[Importer] Fetching previous-day tail: ${start.toISOString()} to ${todayMidnight.toISOString()}`);
        // End 1s before midnight so Tesla stays within yesterday (see loadInterval), and
        // filter since Tesla returns the whole calendar day regardless of start.
        const rows = await this.fetchRange(site, start, new Date(todayMidnight.getTime() - 1000), 'day');
        return rows.filter(r => r.timestamp >= start && r.timestamp < todayMidnight);
    }

    /**
     * Day writes on: write today's open record from Tesla's whole day so far,
     * and yesterday's until Tesla's answer for it is final (complete, or fetched
     * after its last sample was published; remaining gaps are gap-heal's). With
     * no record for yesterday, only a missing stored tail fetches it, as in
     * getTodayData. `rowsPersisted` counts the samples of days actually written.
     */
    async refreshTodayRecords(siteId: string, latestTimestamp: Date | null): Promise<{ rows: EnergyDataRow[]; rowsPersisted: number }> {
        const site = await this.siteRepo.getSite(siteId);
        if (!site) return { rows: [], rowsPersisted: 0 };
        const today = EnergyRepo.getSiteMidnight(new Date(), site.timezone);
        const yesterday = addDaysInSiteTimezone(today, -1, site.timezone);
        const state = await this.getDayStore().getDayRecordState(siteId, yesterday);
        const fetchYesterday = state
            ? state.status !== 'complete' && !isDayFetchFinal(state.fetchedAt, today)
            : this.previousDayTailStart(latestTimestamp, today, site.timezone) !== null;
        const days = fetchYesterday ? [yesterday, today] : [today];
        // Fetch together; a failed day (SOE included) writes nothing, so every stored day stays as it was.
        const fetched = await Promise.all(days.map(start => this.fetchDay(site, start)));
        const rows: EnergyDataRow[] = [];
        let rowsPersisted = 0;
        // One write at a time: concurrent writes for a site would contend for its day-record claim.
        for (const [i, day] of fetched.entries()) {
            rows.push(...day.rows);
            if (await this.writeFetchedDay(site, days[i], day) === 'written') rowsPersisted += day.rows.length;
        }
        return { rows, rowsPersisted };
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

    async ensureDataForRange(
        siteId: string,
        start: Date,
        end: Date,
        onProgress?: (msg: string) => void,
        options?: {
            force?: boolean;
            maxTimeMs?: number;
            maxWindows?: number;
            /** Put re-imported days past the retention cutoff back into the archive. */
            archiveHealedDays?: boolean;
        }
    ): Promise<EnsureDataResult> {
        const force = options?.force ?? false;
        const maxWindows = options?.maxWindows;
        return this.withSiteSync(siteId, force, async site => {
            logSync(`Audit Start: ${siteId}, Range: ${start.toISOString()} to ${end.toISOString()}, force=${force}`);
            if (onProgress) onProgress(`Checking data coverage...`);

            const windows = await planMissingWindows(this.repo, site, start, end, force);

            // A window cap takes the newest days first (the most useful
            // to recent-history readers), open-record retries after every other
            // day (stable sort); the rest are re-planned next run.
            const toImport = maxWindows === undefined
                ? windows
                : [...windows].reverse().sort((a, b) => Number(a.openRetry === true) - Number(b.openRetry === true)).slice(0, maxWindows);

            // The archive pass shares the caller's budget; days it can't reach are left to the archive cron.
            const deadline = options?.maxTimeMs === undefined ? undefined : Date.now() + options.maxTimeMs;
            const imported: DateWindow[] = [];
            const result = await this.importWindows(siteId, toImport, windows.length, options?.maxTimeMs, onProgress, imported);
            // Day records need no archiving: they are the archive.
            if (options?.archiveHealedDays && imported.length > 0 && !compactDayWritesEnabled()) {
                await archiveHealedDays({ id: site.id, timezone: site.timezone }, imported, new Date(),
                    deadline === undefined ? {} : { deadline });
            }
            return result;
        });
    }

    /**
     * Re-import exactly these site-local day windows, even when stored
     * coverage says they are complete (e.g. a few missing samples or rows
     * attributed before a tariff existed). Same lock as ensureDataForRange,
     * never forced, so the app's own imports are not interrupted; the upsert
     * fills missing rows and corrects existing ones.
     */
    async refetchDays(
        siteId: string,
        days: DateWindow[],
        options: { maxTimeMs?: number; maxWindows?: number }
    ): Promise<EnsureDataResult> {
        const toImport = options.maxWindows === undefined ? days : days.slice(0, options.maxWindows);
        return this.withSiteSync(siteId, false, async () => {
            logSync(`Refetch Start: ${siteId}, ${toImport.length}/${days.length} days`);
            return this.importWindows(siteId, toImport, days.length, options.maxTimeMs);
        });
    }

    /**
     * Run `work` holding the per-process and DB import locks for the site.
     * A busy lock returns an empty 0/0 result instead of running.
     */
    private async withSiteSync(
        siteId: string,
        force: boolean,
        work: (site: SiteWithTariffs) => Promise<EnsureDataResult>
    ): Promise<EnsureDataResult> {
        if (Importer.pendingSyncs.has(siteId) && !force) {
            logSync(`Skip: Data for range already being synced for site ${siteId}`);
            return { complete: false, rows: [], processedWindows: 0, totalWindows: 0 };
        }

        let inMemoryAdded = false;
        if (!force) {
            Importer.pendingSyncs.add(siteId);
            inMemoryAdded = true;
        }

        try {
            const site = await this.siteRepo.getSite(siteId);
            if (!site) throw new Error(`Site ${siteId} not found in database`);

            const lockResult = await withImportLock(
                this.siteRepo,
                {
                    siteId,
                    lockDurationMs: 90000, // 90 seconds (resumable chunked requests)
                    force,
                    logLabel: 'Importer',
                },
                () => work(site)
            );

            if (lockResult.status === 'not-acquired') {
                logSync(`Skip: DB lock busy for site ${siteId}`);
                return { complete: false, rows: [], processedWindows: 0, totalWindows: 0 };
            }

            return lockResult.value;
        } finally {
            if (inMemoryAdded) {
                Importer.pendingSyncs.delete(siteId);
            }
        }
    }

    /** Import `toImport` one day window at a time within an optional time budget. */
    private async importWindows(
        siteId: string,
        toImport: DateWindow[],
        totalWindows: number,
        maxTimeMs?: number,
        onProgress?: (msg: string) => void,
        imported?: DateWindow[]
    ): Promise<EnsureDataResult> {
        const allRows: EnergyDataRow[] = [];
        let successCount = 0;
        let lastError: Error | null = null;
        let timeBudgetExceeded = false;
        const startTime = Date.now();

        for (let i = 0; i < toImport.length; i++) {
            if (maxTimeMs !== undefined && Date.now() - startTime >= maxTimeMs) {
                logSync(`Time budget reached (${maxTimeMs}ms) after processing ${successCount}/${totalWindows} windows`);
                timeBudgetExceeded = true;
                break;
            }

            const window = toImport[i];
            const dateStr = window.start.toISOString().split('T')[0];
            if (onProgress) onProgress(`Importing ${dateStr}...`);
            logSync(`Importing window: ${window.start.toISOString()} - ${window.end.toISOString()}`);
            try {
                const rows = compactDayWritesEnabled()
                    ? await this.importDayRecords(siteId, window.start, window.end)
                    : await this.importRange(siteId, window.start, window.end, 'day');
                allRows.push(...rows);
                successCount++;
                imported?.push(window);
            } catch (error) {
                console.error(`[Importer] Failed to import window ${window.start.toISOString()} - ${window.end.toISOString()}:`, error);
                if (onProgress) onProgress(`Error importing ${dateStr}: ${error instanceof Error ? error.message : String(error)}`);
                lastError = error instanceof Error ? error : new Error(String(error));
            }
        }

        if (toImport.length > 0 && successCount === 0 && !timeBudgetExceeded) {
            throw lastError || new Error(`All ${toImport.length} import windows failed`);
        }

        // Complete only when every planned window imported. Failed
        // windows stay missing in the DB, so the next audit re-plans
        // them; reporting complete on partial success made the sync
        // client stop early and silently leave gaps. (totalWindows
        // === 0 is complete: 0 === 0 with no time budget spent.)
        const isComplete = !timeBudgetExceeded && successCount === totalWindows;

        return {
            complete: isComplete,
            rows: allRows,
            processedWindows: successCount,
            totalWindows
        };
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

    /**
     * Day writes on: one `writeDay` per site-local day the window touches, from
     * one Tesla fetch of the whole day (SOE required). The record replaces the
     * day, raw rows included, so a partial window still writes its whole day.
     */
    private async importDayRecords(siteId: string, start: Date, end: Date): Promise<EnergyDataRow[]> {
        const site = await this.siteRepo.getSite(siteId);
        if (!site) throw new Error(`Site ${siteId} not found in database`);
        const rows: EnergyDataRow[] = [];
        for (const chunk of splitAtSiteMidnight({ start, end }, site.timezone)) {
            const dayStart = getSiteMidnight(chunk.start, site.timezone);
            const day = await this.fetchDay(site, dayStart);
            await this.writeFetchedDay(site, dayStart, day);
            rows.push(...day.rows);
        }
        return rows;
    }

    private async fetchDay(site: SiteWithTariffs, start: Date) {
        try {
            const day = await fetchDayForWrite(this, site, start);
            if (day.rows.length > 0 && site.user_id) await this.userRepo.updateLastChecked(site.user_id);
            return day;
        } catch (err: unknown) {
            await this.revokeOnAuthError(site, err);
            throw err;
        }
    }

    private async writeFetchedDay(site: SiteWithTariffs, start: Date, day: { rows: EnergyDataRow[]; fetchedAt: Date }) {
        const result = await this.getDayStore().writeDay(site.id, start, day.rows, day.fetchedAt, new Date(), { replaceRaw: true });
        if (result.status === 'busy') throw new Error(`Day record write busy for ${start.toISOString()}`);
        logSync(`Day record ${start.toISOString()}: ${result.status} (${day.rows.length} samples${result.dayStatus ? `, ${result.dayStatus}` : ''})`);
        return result.status;
    }

    private getDayStore(): DayRecordStore {
        return this.dayStore ??= new CompactHistoryStore(pool);
    }

    private async revokeOnAuthError(site: SiteWithTariffs, err: unknown): Promise<void> {
        if (!isTeslaAuthError(err)) return;
        console.warn(`[Import] Auth error for user ${site.user_id}, marking as revoked`);
        if (site.user_id) {
            await this.userRepo.updateUserStatus(site.user_id, 'revoked', false);
            this.siteRepo.invalidateCache(site.id);
        }
    }

    /**
     * `requireSoe`: fail instead of returning rows without SOC when the SOE request
     * fails. Set it when the rows will replace a stored day wholesale (compact
     * backfill), since nothing else would preserve the SOC already stored.
     */
    async fetchRange(site: SiteWithTariffs, start: Date, end: Date, period: string = "day", options: { requireSoe?: boolean } = {}): Promise<EnergyDataRow[]> {
        const allRows: EnergyDataRow[] = [];

        // One request per site-local day: Tesla returns the whole calendar day for
        // any request inside it, so fixed 24h chunks fetched the 25-hour DST
        // fall-back day twice and produced duplicate timestamps in one batch.
        for (const { start: chunkStart, end: chunkEnd } of splitAtSiteMidnight({ start, end }, site.timezone)) {
            const [history, soeHistory] = await Promise.all([
                this.client.getEnergyHistory(site.id, chunkStart, chunkEnd, period, site.timezone),
                this.client.getSoeHistory(site.id, chunkStart, chunkEnd, period, site.timezone)
                    .catch(error => {
                        if (options.requireSoe) throw error;
                        console.warn(`[Importer] SOE history fetch failed for ${site.id} (${chunkStart.toISOString()}-${chunkEnd.toISOString()})`, error);
                        return [] as SoeHistoryEntry[];
                    })
            ]);

            if (history && history.length > 0) {
                const rows = await this.processHistory(site, history, soeHistory);
                allRows.push(...rows);
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
            await this.revokeOnAuthError(site, err);
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

        const existingCoverage = await createEnergyRepo(site.timezone,this.repo).getDailyCoverage(siteId, start, end, site.timezone);
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
