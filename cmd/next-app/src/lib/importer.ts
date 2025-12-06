import { db, EnergyData, EnergyUsage, Site, Tariff, TariffSeason, TariffSchedule } from './db';
import { Schedule } from './schedule';
import { TeslaClient, EnergyHistoryEntry, EnergySiteInfo, Season, SeasonPeriods } from './tesla-client';
import { EnergyRepo, SiteWithTariffs, UsageData } from './energy-repo';
import * as fs from 'fs';

function getTimeZoneOffsetMinutes(date: Date, timeZone: string): number | null {
    const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone,
        timeZoneName: 'shortOffset',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23'
    });
    const parts = fmt.formatToParts(date);
    const tzName = parts.find(p => p.type === 'timeZoneName')?.value ?? '';
    const match = tzName.match(/GMT([+-]\d{2})(?::?(\d{2}))?/i);
    if (!match) return null;
    const hours = Number(match[1]);
    const minutes = match[2] ? Number(match[2]) : 0;
    return hours * 60 + Math.sign(hours) * minutes;
}

function getStartOfDayInTimeZone(baseDate: Date, timeZone: string): Date {
    const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    });

    const parts = fmt.formatToParts(baseDate);
    const year = Number(parts.find(p => p.type === 'year')?.value);
    const month = Number(parts.find(p => p.type === 'month')?.value);
    const day = Number(parts.find(p => p.type === 'day')?.value);
    const offsetMinutes = getTimeZoneOffsetMinutes(baseDate, timeZone);

    if (Number.isNaN(year) || Number.isNaN(month) || Number.isNaN(day) || offsetMinutes === null) {
        // Fallback to local start of day if timezone parsing fails
        const fallback = new Date(baseDate);
        fallback.setHours(0, 0, 0, 0);
        return fallback;
    }

    const startUtcMs = Date.UTC(year, month - 1, day, 0, 0, 0) - offsetMinutes * 60 * 1000;
    return new Date(startUtcMs);
}

export class Importer {
    private client: TeslaClient;
    private repo: EnergyRepo;

    constructor(client: TeslaClient) {
        this.client = client;
        this.repo = new EnergyRepo();
    }

    async ensureDataForRange(siteId: string, start: Date, end: Date, onProgress?: (msg: string) => void): Promise<void> {
        // 1. Check coverage
        if (onProgress) onProgress(`Checking data coverage...`);
        const site = this.repo.getSite(siteId);
        if (!site) return;

        let cursor = new Date(start);
        cursor.setHours(0, 0, 0, 0);

        // Normalize end to cover the full last day if needed, or rely on caller?
        // Caller usually passes specific range. We will scan roughly from start to end.

        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

        // Optimize: Fetch ALL timestamps in the requested range in one go.
        // We use the same datetime logic as before to ensure consistency.
        const rangeStartStr = cursor.toISOString();
        const rangeEnd = new Date(end);
        // Add buffer to end to make sure we catch the last day's data if end is inclusive/exclusive boundary
        rangeEnd.setDate(rangeEnd.getDate() + 1);
        const rangeEndStr = rangeEnd.toISOString();

        // One query to rule them all
        const rows = db.prepare(`
            SELECT timestamp FROM EnergyData 
            WHERE site_id = ? 
            AND datetime(timestamp) >= datetime(?) 
            AND datetime(timestamp) < datetime(?)
            ORDER BY timestamp ASC
        `).all(siteId, rangeStartStr, rangeEndStr) as { timestamp: string }[];

        const existingTimestamps = rows.map(r => new Date(r.timestamp).getTime());
        let tsIndex = 0;

        // Check for gaps
        while (cursor <= end) {
            const nextDay = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);

            // Define the window for this day
            const windowStart = cursor.getTime();
            const windowEnd = nextDay.getTime();

            // Advance pointer to start of window
            while (tsIndex < existingTimestamps.length && existingTimestamps[tsIndex] < windowStart) {
                tsIndex++;
            }

            // Check if we have data in the window
            let hasData = false;
            if (tsIndex < existingTimestamps.length && existingTimestamps[tsIndex] < windowEnd) {
                hasData = true;
            }

            const isToday = cursor.getTime() === todayStart.getTime();
            let needsImport = false;

            if (!hasData) {
                // Totally missing day
                needsImport = true;
            } else if (isToday) {
                // It's today, check for staleness
                // We can find the *last* timestamp in this window (or overall last if sorted)
                let lastInWindow = existingTimestamps[tsIndex];
                let tempIdx = tsIndex;
                while (tempIdx < existingTimestamps.length && existingTimestamps[tempIdx] < windowEnd) {
                    lastInWindow = existingTimestamps[tempIdx];
                    tempIdx++;
                }

                if (lastInWindow) {
                    const diffMinutes = (now.getTime() - lastInWindow) / (60 * 1000);
                    if (diffMinutes > 15) {
                        needsImport = true;
                        if (onProgress) onProgress(`Refreshing stale data (${diffMinutes.toFixed(0)}m old)...`);
                        console.log(`[Importer] Data stale (${diffMinutes.toFixed(1)}m old), refreshing...`);
                    }
                } else {
                    // Should be covered by hasData, but safe fallback
                    needsImport = true;
                }
            }

            if (needsImport) {
                const dateStr = cursor.toLocaleDateString();
                if (onProgress) onProgress(`Importing ${dateStr}...`);
                console.log(`[Importer] Gap/Stale detected for ${dateStr}. Importing...`);

                let importEnd = nextDay;
                if (isToday) importEnd = now;

                await this.importRange(siteId, cursor, importEnd, 'day');
            }

            cursor = nextDay;
        }
    }

    /**
     * Automated partial import (e.g. for worker).
     * @deprecated Use ensureDataForRange instead.
     */
    async importSite(siteId: string, period: string = "day", maxDays: number = 7) {
        let site = this.repo.getSite(siteId);
        if (!site) {
            site = await this.ensureSite(siteId);
            if (!site) {
                console.error(`Site ${siteId} not found in DB and failed to create`);
                return;
            }
        }

        const retentionDays = process.env.DATA_RETENTION_DAYS ? parseInt(process.env.DATA_RETENTION_DAYS, 10) : 90;
        const now = new Date();
        const retentionDate = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);

        // Auto-import limit: Only look back 14 days maximum from now.
        // This prevents the worker from trying to backfill years of history on every run.
        const autoBackfillLimit = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

        // Determine start date from last stored timestamp
        const lastRow = db.prepare('SELECT timestamp FROM EnergyData WHERE site_id = ? ORDER BY timestamp DESC LIMIT 1').get(siteId) as { timestamp: string } | undefined;

        let startFromDb: Date;
        if (lastRow) {
            startFromDb = getStartOfDayInTimeZone(new Date(lastRow.timestamp), site.timezone);
        } else {
            // New site (or empty DB): Start from auto-backfill limit or install date, whichever is later
            const installDate = new Date(site.installed);
            startFromDb = installDate > autoBackfillLimit ? installDate : autoBackfillLimit;
        }

        const start = new Date(startFromDb.getTime() - 5 * 60 * 1000); // 5 min overlap

        // Ensure we don't go earlier than retention date or auto-backfill limit
        const earliestAllowed = new Date(Math.max(
            retentionDate.getTime(),
            autoBackfillLimit.getTime(),
            new Date(site.installed).getTime()
        ));

        const adjustedStart = start < earliestAllowed ? earliestAllowed : start;

        if (adjustedStart >= now) {
            console.log(`No new data to import for site ${siteId}`);
            return;
        }

        console.log(`[Importer] Auto-importing ${siteId} from ${adjustedStart.toISOString()} to ${now.toISOString()}`);
        await this.importRange(siteId, adjustedStart, now, period);

        // Prune old data after import
        await this.pruneOldData(siteId, retentionDays);
    }

    /**
     * Import data for a specific date range.
     * Can be used for initial setup (last 30 days) or filling gaps.
     */
    async importRange(siteId: string, start: Date, end: Date, period: string = "day", onProgress?: (date: Date) => void) {
        const site = this.repo.getSite(siteId);
        if (!site) {
            console.error(`Site ${siteId} not found for importRange`);
            return;
        }

        // Load in 1-day chunks to ensure API reliability.
        // We found that multi-day requests often return 0 rows for this site/config.
        // Also, requests ending exactly at midnight (00:00) fail. We must target end-of-day (23:59:59).
        let cursor = new Date(start);
        const chunkMs = 24 * 60 * 60 * 1000;

        while (cursor < end) {
            const next = new Date(Math.min(cursor.getTime() + chunkMs, end.getTime()));

            if (onProgress) onProgress(cursor);

            await this.loadInterval(site, cursor, next, period);
            cursor = next;
        }
    }

    async pruneOldData(siteId: string, retentionDays: number) {
        const pruneDate = new Date();
        pruneDate.setDate(pruneDate.getDate() - retentionDays);
        const pruneDateStr = pruneDate.toISOString();

        console.log(`[Importer] Pruning data older than ${pruneDateStr} for site ${siteId}`);

        const tx = db.transaction(() => {
            // Prune EnergyData
            const resData = db.prepare(`DELETE FROM EnergyData WHERE site_id = ? AND timestamp < ?`).run(siteId, pruneDateStr);
            if (resData.changes > 0) {
                console.log(`[Importer] Deleted ${resData.changes} rows from EnergyData`);
            }

            // Prune EnergyUsage (tariff-based)
            const resUsage = db.prepare(`
                DELETE FROM EnergyUsage 
                WHERE tariff_id IN (SELECT id FROM Tariff WHERE site_id = ?) 
                AND start < ?
            `).run(siteId, pruneDateStr);
            if (resUsage.changes > 0) {
                console.log(`[Importer] Deleted ${resUsage.changes} rows from EnergyUsage`);
            }
        });
        tx();
    }

    async ensureSite(siteId: string): Promise<SiteWithTariffs | undefined> {
        try {
            const info = await this.client.getEnergySiteInfo(siteId);

            // Check if tariff content has changed
            const existingSite = db.prepare('SELECT json FROM Site WHERE id = ?').get(siteId) as { json: string } | undefined;
            let tariffsChanged = true;

            if (existingSite && existingSite.json) {
                try {
                    const existingInfo = JSON.parse(existingSite.json) as EnergySiteInfo;
                    // Simple string comparison of the tariff content objects
                    if (JSON.stringify(existingInfo.tariff_content_v2) === JSON.stringify(info.tariff_content_v2)) {
                        tariffsChanged = false;
                    }
                } catch (e) {
                    // ignore parse error, force update
                }
            }

            db.prepare(`
                INSERT INTO Site(id, name, updated, installed, timezone, json)
                VALUES (?, ?, datetime('now'), ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET name=excluded.name, installed=excluded.installed, timezone=excluded.timezone, json=excluded.json
            `).run(siteId, info.site_name, info.installation_date, info.installation_time_zone, JSON.stringify(info));

            // Only update tariffs if content changed
            if (tariffsChanged) {
                console.log(`Tariff content changed for site ${siteId}, updating tariffs...`);
                // Clear existing tariffs for this site to avoid stale data/conflicts
                const tariffIds = db.prepare('SELECT id FROM Tariff WHERE site_id = ?').all(siteId) as { id: number }[];
                for (const t of tariffIds) {
                    db.prepare('DELETE FROM TariffSchedule WHERE season_id IN (SELECT id FROM TariffSeason WHERE tariff_id = ?)').run(t.id);
                    db.prepare('DELETE FROM TariffSeason WHERE tariff_id = ?').run(t.id);
                }
                db.prepare('DELETE FROM Tariff WHERE site_id = ?').run(siteId);

                this.updateTariffs(siteId, info);
            } else {
                console.log(`Tariff content unchanged for site ${siteId}, skipping tariff update.`);
            }

            return this.repo.getSite(siteId);
        } catch (e) {
            console.error(`Error ensuring site ${siteId}`, e);
            throw e;
        }
    }

    private updateTariffs(siteId: string, info: EnergySiteInfo) {
        if (!info.tariff_content_v2) {
            this.ensureDefaultTariff(siteId, 'Default Rate');
            return;
        }

        // Parse Tesla Tariff structure
        const tariffContent = info.tariff_content_v2;

        // Handle "Demand Charges" -> Usually separate, but we primarily need Energy Charges
        // We look for "Daily usage charges" or "Time of use columns"

        // Simplified Logic:
        // iterate seasons -> TOU periods -> rates

        for (const seasonName in tariffContent.seasons) {
            const seasonData = tariffContent.seasons[seasonName];

            // Create Tariff for the site (assuming one tariff plan active)
            // Ideally we map distinct Tariffs if multiple exist, but usually it's one active plan.
            // We use the utility as the name
            const tariffName = tariffContent.utility ?? info.site_name ?? 'Utility Tariff';

            db.prepare(`
                INSERT INTO Tariff(site_id, name, updated)
                VALUES (?, ?, datetime('now'))
                ON CONFLICT(site_id, name) DO UPDATE SET name=excluded.name
            `).run(siteId, tariffName);

            const tariffRow = db.prepare(`SELECT id FROM Tariff WHERE site_id = ? AND name = ?`).get(siteId, tariffName) as { id: number };

            // Insert Season
            const fromMonth = seasonData.fromMonth;
            const toMonth = seasonData.toMonth;
            const fromDay = seasonData.fromDay;
            const toDay = seasonData.toDay;

            // Insert Season
            // Using insert or replace to update definition
            db.prepare(`
                INSERT INTO TariffSeason(tariff_id, name, from_month, from_day, to_month, to_day, buy_rate, sell_rate)
                VALUES (?, ?, ?, ?, ?, ?, 0, 0)
            `).run(tariffRow.id, seasonName, fromMonth, fromDay, toMonth, toDay);

            const seasonRow = db.prepare(`SELECT id FROM TariffSeason WHERE tariff_id = ? AND name = ?`).get(tariffRow.id, seasonName) as { id: number };

            // TOU Periods
            // Rates are in tariffContent.energy_charges[seasonName].rates
            // Sell rates in tariffContent.sell_tariff.energy_charges[seasonName].rates

            const seasonBuyRates = tariffContent.energy_charges?.[seasonName]?.rates ?? {};
            const seasonSellRates = tariffContent.sell_tariff?.energy_charges?.[seasonName]?.rates ?? {};
            const defaultBuyRate = 0;
            const defaultSellRate = 0;

            for (const touName in seasonData.tou_periods) {
                const periodGroup = seasonData.tou_periods[touName];
                // periodGroup is { periods: [...] }

                // Find rates for this TOU period
                const touBuyRate = seasonBuyRates[touName] ?? defaultBuyRate;
                const touSellRate = seasonSellRates[touName] ?? defaultSellRate;

                if (!periodGroup.periods) continue;

                for (const p of periodGroup.periods) {
                    db.prepare(`
                        INSERT INTO TariffSchedule(season_id, name, buy_rate, sell_rate, from_day_of_week, to_day_of_week, from_hour, from_minute, to_hour, to_minute)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `).run(
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
                    );
                }
            }
        }
    }

    private ensureDefaultTariff(siteId: string, name: string) {
        db.prepare(`
            INSERT INTO Tariff(site_id, name, updated)
            VALUES (?, ?, datetime('now'))
            ON CONFLICT(site_id, name) DO UPDATE SET name=excluded.name
        `).run(siteId, name);
        const tariffRow = db.prepare(`SELECT id FROM Tariff WHERE site_id = ? AND name = ?`).get(siteId, name) as { id: number } | undefined;
        if (tariffRow) {
            // Refresh any existing seasons/schedules for consistency
            db.prepare(`DELETE FROM TariffSchedule WHERE season_id IN (SELECT id FROM TariffSeason WHERE tariff_id = ?)`).run(tariffRow.id);
            db.prepare(`DELETE FROM TariffSeason WHERE tariff_id = ?`).run(tariffRow.id);
            this.ensureDefaultSeasonAndSchedule(tariffRow.id, 0, 0);
        }
    }

    private ensureDefaultSeasonAndSchedule(tariffId: number, buyRate: number, sellRate: number) {
        db.prepare(`
            INSERT OR IGNORE INTO TariffSeason(tariff_id, name, from_month, from_day, to_month, to_day, buy_rate, sell_rate)
            VALUES (?, ?, 1, 1, 12, 31, ?, ?)
        `).run(tariffId, 'All Year', buyRate, sellRate);
        const seasonRow = db.prepare(`SELECT id FROM TariffSeason WHERE tariff_id = ? LIMIT 1`).get(tariffId) as { id: number } | undefined;
        if (seasonRow) {
            this.ensureDefaultSchedule(seasonRow.id, buyRate, sellRate, 'Default');
        }
    }

    private ensureDefaultSchedule(seasonId: number, buyRate: number, sellRate: number, name: string = 'Default') {
        const hasSchedule = db.prepare(`SELECT 1 FROM TariffSchedule WHERE season_id = ? LIMIT 1`).get(seasonId) as { 1: number } | undefined;
        if (!hasSchedule) {
            db.prepare(`
                INSERT INTO TariffSchedule(season_id, name, buy_rate, sell_rate, from_day_of_week, to_day_of_week, from_hour, to_hour)
                VALUES (?, ?, ?, ?, 0, 6, 0, 24)
            `).run(seasonId, name, buyRate, sellRate);
        }
    }

    private async loadInterval(site: SiteWithTariffs, start: Date, end: Date, period: string) {
        // Fix: Force end date to be 23:59:59 if it looks like a full day request
        // This avoids the API returning 0 rows for Midnight-to-Midnight queries.
        let actualEnd = new Date(end);
        const diffMs = end.getTime() - start.getTime();
        const oneDayMs = 24 * 60 * 60 * 1000;

        if (period === 'day' && diffMs <= oneDayMs && diffMs > (oneDayMs - 60000)) {
            // If requesting ~24h, reduce end by 1 second to stay within the day
            actualEnd = new Date(actualEnd.getTime() - 1000);
        }
        // Also handle cases where we might be requesting partial days ending at midnight? 
        // Safest is: if end is exactly midnight (00:00:00), subtract 1 second?
        if (period === 'day' && actualEnd.getHours() === 0 && actualEnd.getMinutes() === 0 && actualEnd.getSeconds() === 0) {
            actualEnd = new Date(actualEnd.getTime() - 1000);
        }

        fs.appendFileSync('import.log', `[Import] loadInterval ${start.toISOString()} - ${actualEnd.toISOString()} (${period})\n`);

        // Fetch history for the interval at the requested granularity
        const history = await this.client.getEnergyHistory(site.id, start, actualEnd, period, site.timezone); // Use actualEnd
        fs.appendFileSync('import.log', `[Import] History Rows Fetched: ${history?.length ?? 0}\n`);

        if (!history || history.length === 0) {
            // Fix for infinite backfill loop:
            // If we requested a specific day and got no data, it means there is no usage for that day (or it's in the future).
            // We MUST insert a record to "fill the gap" so the ensureDataForRange loop knows we checked this day.
            if (period === 'day') {
                const zeroDateStr = start.toISOString();
                const defaultTariff = site.tariffs[0]?.id || 0;

                console.log(`[Importer] No data from Tesla for ${zeroDateStr}. Inserting zero record to prevent infinite retry.`);
                fs.appendFileSync('import.log', `[Importer] No data for ${zeroDateStr}. Inserting zero record.\n`);

                db.prepare(`
                    INSERT INTO EnergyData(site_id, tariff_id, timestamp, load_power, solar_power, grid_power, battery_power, battery_soc, is_synthetic) 
                    VALUES (?, ?, ?, 0, 0, 0, 0, null, 1)
                    ON CONFLICT(timestamp, site_id, tariff_id) DO NOTHING
                `).run(site.id, defaultTariff, zeroDateStr);

                // Also insert zero usage for the day
                const usageDate = new Date(start);
                usageDate.setHours(0, 0, 0, 0);

                if (defaultTariff) {
                    db.prepare(`
                        INSERT INTO EnergyUsage(tariff_id, start, load_usage, solar_produced, grid_usage, battery_usage) 
                        VALUES (?, ?, 0, 0, 0, 0)
                        ON CONFLICT(tariff_id, start) DO NOTHING
                    `).run(defaultTariff, usageDate.toISOString());
                }
            }
            return;
        }

        const startStr = start.toISOString();
        const endStr = end.toISOString();

        // Wrap this interval in a single transaction so partial failures don't affect other days
        const tx = db.transaction(() => {
            const msg1 = `[Import] Insert Transaction Start. History Rows: ${history.length}\n`;
            fs.appendFileSync('import.log', msg1);
            console.log(msg1);

            db.prepare('DELETE FROM EnergyData WHERE site_id = ? AND timestamp >= ? AND timestamp < ?').run(site.id, startStr, endStr);
            const energyDatas = this.processHistory(site, history, new Map(), period); // Pass empty map for SOC

            const msg2 = `[Import] Processed EnergyData Rows: ${energyDatas.length}\n`;
            fs.appendFileSync('import.log', msg2);
            console.log(msg2);

            const usages = this.aggregateUsage(site, energyDatas);
            this.insertEnergyData(energyDatas, true);
            this.insertEnergyUsage(usages, true);
        });

        tx();
    }

    private processHistory(site: SiteWithTariffs, history: EnergyHistoryEntry[], soeByTimestamp: Map<number, number>, period: string = 'day'): any[] {
        const schedule = new Schedule(site.tariffs);
        const results: any[] = [];

        for (let i = 0; i < history.length; i++) {
            const h = history[i];
            const ts = new Date(h.timestamp);

            // Per-row adaptive scaling
            // Tesla API can return mixed granularity (e.g. Daily history + 5-min recent data) in one response.
            // We must detect if THIS row represents a Day (kWh -> x1000) or an Interval (Wh -> x1).
            let durationHours = 24; // Default fallback
            if (i < history.length - 1) {
                const nextTs = new Date(history[i + 1].timestamp).getTime();
                durationHours = (nextTs - ts.getTime()) / (3600 * 1000);
            } else if (i > 0) {
                const prevTs = new Date(history[i - 1].timestamp).getTime();
                durationHours = (ts.getTime() - prevTs) / (3600 * 1000);
            }

            // If period is 'day' AND this row covers a large chunk of time (>20h), treat as kWh -> Scale x1000.
            // Otherwise (short interval), treat as Wh -> Scale x1.
            const scale = (period === 'day' && durationHours > 20) ? 1000 : 1;

            const tp = this.getTariffPeriodOrFallback(site, schedule, ts);
            if (!tp) {
                console.warn(`No tariff period found for ${h.timestamp}; skipping row`);
                continue;
            }

            const gridImported = h.grid_energy_imported ?? 0;
            const gridExported = h.total_grid_energy_exported ?? 0;
            let grid = gridImported;
            if (grid === 0) {
                grid = -gridExported;
            }

            const batteryCharge = h.total_battery_charge ?? 0;
            const batteryDischarge = h.total_battery_discharge ?? 0;
            let battery = batteryCharge;
            if (battery === 0) {
                battery = -batteryDischarge;
            }

            results.push({
                site_id: site.id,
                tariff_id: Number(tp.tariff.id),
                timestamp: h.timestamp,
                load_power: (h.total_home_usage ?? 0) * scale,
                solar_power: (h.solar_energy_exported ?? 0) * scale,
                grid_power: grid * scale,
                battery_power: battery * scale,
                battery_soc: soeByTimestamp.get(ts.getTime()) ?? null
            });
        }
        return results;
    }

    private getTariffPeriodOrFallback(site: SiteWithTariffs, schedule: Schedule, ts: Date) {
        const tp = schedule.getTariffPeriod(ts);
        if (tp) return tp;

        // Fallback: assign to the first tariff with a synthetic all-day schedule
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
            sell_rate: fallbackTariff.seasons?.[0]?.sell_rate ?? 0,
            schedules: []
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
            to_minute: 0
        };

        return {
            start: new Date(ts),
            end: new Date(ts),
            tariff: fallbackTariff,
            season,
            schedule: sched
        };
    }

    private insertEnergyData(data: any[], inTransaction = false) {
        // Skip rows whose tariff is unknown rather than creating new tariffs during data import
        const validRows = data.filter(row => {
            const tariffExists = db.prepare('SELECT 1 FROM Tariff WHERE id = ?').get(row.tariff_id) as { 1: number } | undefined;
            if (!tariffExists) {
                const msg = `Skipping row for unknown tariff_id=${row.tariff_id}. DB has tariffs: ${JSON.stringify(db.prepare('SELECT id FROM Tariff').all())}\n`;
                fs.appendFileSync('import.log', msg);
                console.warn(msg);
                return false;
            }
            return true;
        });

        fs.appendFileSync('import.log', `[Import] Valid Rows to Insert: ${validRows.length} / ${data.length}\n`);
        console.log(`[Import] Valid Rows to Insert: ${validRows.length} / ${data.length}`);

        const stmt = db.prepare(`
            INSERT INTO EnergyData(site_id, tariff_id, timestamp, load_power, solar_power, grid_power, battery_power, battery_soc) 
            VALUES (@site_id, @tariff_id, @timestamp, @load_power, @solar_power, @grid_power, @battery_power, @battery_soc)
            ON CONFLICT(timestamp, site_id, tariff_id) DO UPDATE SET
                load_power=excluded.load_power,
                solar_power=excluded.solar_power,
                grid_power=excluded.grid_power,
                battery_power=excluded.battery_power,
                battery_soc=excluded.battery_soc
        `);

        const runner = (rows: any[]) => {
            for (const row of rows) stmt.run(row);
        };

        if (inTransaction) {
            runner(validRows);
        } else {
            db.transaction(runner)(validRows);
        }
    }

    private aggregateUsage(site: SiteWithTariffs, data: any[]): UsageData[] {
        // Determine min date for start of usage day
        if (data.length === 0) return [];

        // Assuming all data is for the same day roughly
        const first = new Date(data[0].timestamp);
        const usageDate = new Date(first.getFullYear(), first.getMonth(), first.getDate());

        const tariffMap = new Map<number, UsageData>();

        // Initialize for all tariffs
        for (const t of site.tariffs) {
            tariffMap.set(t.id, {
                start: usageDate,
                homeUsage: 0,
                gridUsage: 0,
                solarProduction: 0,
                batteryChange: 0,
                tariff: t
            });
        }

        for (const d of data) {
            let ud = tariffMap.get(d.tariff_id);
            if (!ud) {
                // Should have been initialized, but just in case
                const t = site.tariffs.find(t => t.id === d.tariff_id);
                if (!t) continue;
                ud = {
                    start: usageDate,
                    homeUsage: 0,
                    gridUsage: 0,
                    solarProduction: 0,
                    batteryChange: 0,
                    tariff: t
                };
                tariffMap.set(d.tariff_id, ud);
            }

            ud.homeUsage += d.load_power;
            ud.gridUsage += d.grid_power;
            ud.solarProduction += d.solar_power;
            ud.batteryChange += d.battery_power;
        }

        return Array.from(tariffMap.values());
    }

    private insertEnergyUsage(usages: UsageData[], inTransaction = false) {
        const stmt = db.prepare(`
            INSERT INTO EnergyUsage(tariff_id, start, load_usage, solar_produced, grid_usage, battery_usage) 
            VALUES (@tariff_id, @start, @load_usage, @solar_produced, @grid_usage, @battery_usage)
            ON CONFLICT(tariff_id, start) DO UPDATE SET 
                load_usage = excluded.load_usage, 
                solar_produced = excluded.solar_produced, 
                grid_usage = excluded.grid_usage, 
                battery_usage = excluded.battery_usage
        `);

        const runner = (rows: UsageData[]) => {
            for (const row of rows) {
                stmt.run({
                    tariff_id: row.tariff.id,
                    start: row.start.toISOString(), // SQLite string
                    load_usage: row.homeUsage,
                    solar_produced: row.solarProduction,
                    grid_usage: row.gridUsage,
                    battery_usage: row.batteryChange
                });
            }
        };

        if (inTransaction) {
            runner(usages);
        } else {
            db.transaction(runner)(usages);
        }
    }
}
