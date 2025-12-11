import { pool, SiteWithTariffs, TariffSeason, TariffSchedule } from './db';
import { Schedule } from './schedule';
import { TeslaClient, EnergyHistoryEntry, EnergySiteInfo } from './tesla-client';
import { EnergyRepo, UsageData } from './energy-repo';

import { PoolClient } from 'pg';

interface EnergyDataRow {
    site_id: string;
    tariff_id: number;
    timestamp: string;
    load_power: number;
    solar_power: number;
    grid_power: number;
    battery_power: number;
    battery_soc: number | null;
}



export class Importer {
    private client: TeslaClient;
    private repo: EnergyRepo;

    constructor(client: TeslaClient) {
        this.client = client;
        this.repo = new EnergyRepo();
    }

    async ensureDataForRange(siteId: string, start: Date, end: Date, onProgress?: (msg: string) => void): Promise<void> {
        if (onProgress) onProgress(`Checking data coverage...`);
        const site = await this.repo.getSite(siteId);
        if (!site) throw new Error(`Site ${siteId} not found in database`);

        let cursor = new Date(start);
        cursor.setHours(0, 0, 0, 0);

        // Determine "Today" in Site Timezone to prevent future lookups
        const getSiteMidnight = (d: Date, tz: string) => {
            const fmt = new Intl.DateTimeFormat('en-CA', {
                timeZone: tz,
                year: 'numeric',
                month: '2-digit',
                day: '2-digit'
            });
            const parts = fmt.format(d); // YYYY-MM-DD
            const [y, m, day] = parts.split('-').map(Number);
            return new Date(y, m - 1, day);
        };

        const now = new Date();
        // todayStart represents 00:00 of the current day in the SITE'S timezone
        // This is the limit of what we can import.
        const todayStart = getSiteMidnight(now, site.timezone);

        const rangeStartStr = cursor.toISOString();
        const rangeEnd = new Date(end);
        rangeEnd.setDate(rangeEnd.getDate() + 1);
        const rangeEndStr = rangeEnd.toISOString();

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

        while (cursor <= end) {
            const nextDay = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
            const windowStart = cursor.getTime();
            const windowEnd = nextDay.getTime();

            while (tsIndex < existingTimestamps.length && existingTimestamps[tsIndex] < windowStart) {
                tsIndex++;
            }

            let hasData = false;
            if (tsIndex < existingTimestamps.length && existingTimestamps[tsIndex] < windowEnd) {
                hasData = true;
            }

            const isToday = cursor.getTime() === todayStart.getTime();
            let needsImport = false;

            if (!hasData) {
                needsImport = true;
            } else if (isToday) {
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
                    needsImport = true;
                }
            }

            if (needsImport) {
                const dateStr = cursor.toISOString().split('T')[0];
                if (onProgress) onProgress(`Importing ${dateStr}...`);
                console.log(`[Importer] Gap/Stale detected for ${dateStr}. Importing...`);

                let importEnd = nextDay;
                if (isToday) importEnd = now;

                await this.importRange(siteId, cursor, importEnd, 'day');
            }

            cursor = nextDay;
        }
    }

    async importRange(siteId: string, start: Date, end: Date, period: string = "day", onProgress?: (date: Date) => void) {
        const site = await this.repo.getSite(siteId);
        if (!site) {
            console.error(`Site ${siteId} not found for importRange`);
            throw new Error(`Site ${siteId} not found in database`);
        }

        let cursor = new Date(start);
        const chunkMs = 24 * 60 * 60 * 1000;

        while (cursor < end) {
            const next = new Date(Math.min(cursor.getTime() + chunkMs, end.getTime()));

            if (onProgress) onProgress(cursor);

            await this.loadInterval(site, cursor, next, period);
            cursor = next;
        }
    }

    async ensureSite(siteId: string): Promise<SiteWithTariffs | undefined> {
        try {
            const info = await this.client.getEnergySiteInfo(siteId);

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
        } catch (e) {
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

    private async loadInterval(site: SiteWithTariffs, start: Date, end: Date, period: string) {
        let actualEnd = new Date(end);
        const diffMs = end.getTime() - start.getTime();
        const oneDayMs = 24 * 60 * 60 * 1000;

        if (period === 'day' && diffMs <= oneDayMs && diffMs > (oneDayMs - 60000)) {
            actualEnd = new Date(actualEnd.getTime() - 1000);
        }
        if (period === 'day' && actualEnd.getHours() === 0 && actualEnd.getMinutes() === 0 && actualEnd.getSeconds() === 0) {
            actualEnd = new Date(actualEnd.getTime() - 1000);
        }

        console.log(`[Import] loadInterval ${start.toISOString()} - ${actualEnd.toISOString()} (${period})`);
        const history = await this.client.getEnergyHistory(site.id, start, actualEnd, period, site.timezone);
        console.log(`[Import] History Rows Fetched: ${history?.length ?? 0}`);

        if (!history || history.length === 0) {
            if (period === 'day') {
                const zeroDateStr = start.toISOString();
                const defaultTariff = site.tariffs[0]?.id || 0;
                console.log(`[Importer] No data from Tesla for ${zeroDateStr}. Inserting zero record.`);

                // DB operations
                const client = await pool.connect();
                try {
                    await client.query('BEGIN');
                    await client.query(`
                        INSERT INTO "EnergyData"(site_id, tariff_id, timestamp, load_power, solar_power, grid_power, battery_power, battery_soc, is_synthetic) 
                        VALUES ($1, $2, $3, 0, 0, 0, 0, null, 1)
                        ON CONFLICT(timestamp, site_id, tariff_id) DO NOTHING
                    `, [site.id, defaultTariff, start]); // passed as Date

                    const usageDate = new Date(start);
                    usageDate.setHours(0, 0, 0, 0);

                    if (defaultTariff) {
                        await client.query(`
                            INSERT INTO "EnergyUsage"(tariff_id, start, load_usage, solar_produced, grid_usage, battery_usage) 
                            VALUES ($1, $2, 0, 0, 0, 0)
                            ON CONFLICT(tariff_id, start) DO NOTHING
                        `, [defaultTariff, usageDate]);
                    }
                    await client.query('COMMIT');
                } catch (e) {
                    await client.query('ROLLBACK');
                    throw e;
                } finally {
                    client.release();
                }
            }
            return;
        }

        const client = await pool.connect();
        try {
            const msg1 = `[Import] Insert Transaction Start. History Rows: ${history.length}`;
            console.log(msg1);

            await client.query('BEGIN');
            await client.query('DELETE FROM "EnergyData" WHERE site_id = $1 AND timestamp >= $2 AND timestamp < $3', [site.id, start, end]);

            const energyDatas = await this.processHistory(client, site, history, new Map(), period);

            const msg2 = `[Import] Processed EnergyData Rows: ${energyDatas.length}`;
            console.log(msg2);

            const usages = this.aggregateUsage(site, energyDatas);
            await this.insertEnergyData(client, site, energyDatas);
            await this.insertEnergyUsage(client, usages);

            await client.query('COMMIT');
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
    }

    private async processHistory(client: PoolClient, site: SiteWithTariffs, history: EnergyHistoryEntry[], soeByTimestamp: Map<number, number>, period: string = 'day'): Promise<EnergyDataRow[]> {
        const schedule = new Schedule(site.tariffs, site.timezone);
        const results: EnergyDataRow[] = [];

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

            const tp = this.getTariffPeriodOrFallback(site, schedule, ts);
            if (!tp) continue;

            const gridImported = h.grid_energy_imported ?? 0;
            const gridExported = h.total_grid_energy_exported ?? 0;
            let grid = gridImported;
            if (grid === 0) grid = -gridExported;

            const batteryCharge = h.total_battery_charge ?? 0;
            const batteryDischarge = h.total_battery_discharge ?? 0;
            let battery = batteryCharge;
            if (battery === 0) battery = -batteryDischarge;

            results.push({
                site_id: site.id,
                tariff_id: Number(tp.tariff.id),
                timestamp: h.timestamp, // string from API
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
            const values: (string | number | null)[] = [];
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
                    battery_soc=EXCLUDED.battery_soc
            `;

            await client.query(query, values);
        }
    }

    private aggregateUsage(site: SiteWithTariffs, data: EnergyDataRow[]): UsageData[] {
        if (data.length === 0) return [];

        const first = new Date(data[0].timestamp);
        const usageDate = new Date(first.getFullYear(), first.getMonth(), first.getDate());

        const tariffMap = new Map<number, UsageData>();

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

    private async insertEnergyUsage(client: PoolClient, usages: UsageData[]) {
        if (usages.length === 0) return;

        const values: (string | number | Date)[] = [];
        const placeholders: string[] = [];
        let pIdx = 1;

        for (const row of usages) {
            placeholders.push(`($${pIdx}, $${pIdx + 1}, $${pIdx + 2}, $${pIdx + 3}, $${pIdx + 4}, $${pIdx + 5})`);
            values.push(
                row.tariff.id,
                row.start,
                row.homeUsage,
                row.solarProduction,
                row.gridUsage,
                row.batteryChange
            );
            pIdx += 6;
        }

        const query = `
            INSERT INTO "EnergyUsage"(tariff_id, start, load_usage, solar_produced, grid_usage, battery_usage) 
            VALUES ${placeholders.join(', ')}
            ON CONFLICT(tariff_id, start) DO UPDATE SET 
                load_usage = EXCLUDED.load_usage, 
                solar_produced = EXCLUDED.solar_produced, 
                grid_usage = EXCLUDED.grid_usage, 
                battery_usage = EXCLUDED.battery_usage
        `;

        await client.query(query, values);
    }
}
