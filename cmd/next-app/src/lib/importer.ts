import { TeslaClient, EnergyHistoryEntry, EnergySiteInfo, Season, SeasonPeriods } from './tesla-client';
import { EnergyRepo, SiteWithTariffs, UsageData } from './energy-repo';
import { Schedule } from './schedule';
import { db, EnergyUsage, Tariff, TariffSeason, TariffSchedule } from './db';

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

    constructor(token: string) {
        this.client = new TeslaClient(token);
        this.repo = new EnergyRepo();
    }

    async importSite(siteId: string, period: string = "day") {
        let site = this.repo.getSite(siteId);
        if (!site) {
            site = await this.ensureSite(siteId);
            if (!site) {
                console.error(`Site ${siteId} not found in DB and failed to create`);
                return;
            }
        }

        // Determine start date from last stored timestamp or installation date
        const lastRow = db.prepare('SELECT timestamp FROM EnergyData WHERE site_id = ? ORDER BY timestamp DESC LIMIT 1').get(siteId) as { timestamp: string } | undefined;
        const now = new Date();

        // Start from the beginning of the day that contains the last stored record (site TZ) to refill any gaps,
        // or the install date if none. Step back one interval for overlap.
        const startFromDb = lastRow ? getStartOfDayInTimeZone(new Date(lastRow.timestamp), site.timezone) : new Date(site.installed);
        const start = new Date(startFromDb.getTime() - 5 * 60 * 1000);
        const adjustedStart = start < new Date(site.installed) ? new Date(site.installed) : start;

        if (adjustedStart >= now) {
            console.log(`No new data to import for site ${siteId}`);
            return;
        }

        // Load in day-sized chunks to avoid API limits and cover gaps
        let cursor = adjustedStart;
        const oneDayMs = 24 * 60 * 60 * 1000;
        while (cursor < now) {
            const next = new Date(Math.min(cursor.getTime() + oneDayMs, now.getTime()));
            await this.loadInterval(site, cursor, next, period);
            cursor = next;
        }
    }

    async ensureSite(siteId: string): Promise<SiteWithTariffs | undefined> {
        try {
            const info = await this.client.getEnergySiteInfo(siteId);

            // Upsert Site
            db.prepare(`
                INSERT INTO Site(id, name, updated, installed, timezone, json)
                VALUES (?, ?, datetime('now'), ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET name=excluded.name, installed=excluded.installed, timezone=excluded.timezone, json=excluded.json
            `).run(
                siteId,
                info.site_name,
                info.installation_date,
                info.installation_time_zone,
                JSON.stringify(info)
            );

            this.upsertTariffsFromSiteInfo(siteId, info);
            return this.repo.getSite(siteId);
        } catch (err) {
            console.error(`Failed to ensure site ${siteId}:`, err);
            return undefined;
        }
    }

    private upsertTariffsFromSiteInfo(siteId: string, info: EnergySiteInfo) {

        // Do NOT delete Tariff rows (EnergyData FK). We'll upsert tariffs and refresh seasons/schedules per tariff.

        const pickNumber = (obj: any, keys: string[], fallback: number | null = null) => {
            for (const k of keys) {
                const v = obj?.[k];
                if (typeof v === 'number') return v;
            }
            return fallback;
        };

        const tariffContent = info.tariff_content_v2;
        if (!tariffContent) {
            this.ensureDefaultTariff(siteId, 'Default');
            return;
        }

        const buyCharges = tariffContent.energy_charges || {};
        const sellCharges = tariffContent.sell_tariff?.energy_charges || {};
        const seasonsMap: Record<string, Season> = tariffContent.seasons || {};

        const tariffNames = Object.keys(buyCharges);
        if (tariffNames.length === 0) {
            this.ensureDefaultTariff(siteId, 'Default');
            return;
        }

        for (const tariffName of tariffNames) {
            const buyRates = buyCharges[tariffName]?.rates || {};
            const sellRates = sellCharges[tariffName]?.rates || {};
            const buyRate = Object.values(buyRates).length > 0 ? Number(Object.values(buyRates)[0]) : 0;
            const sellRate = Object.values(sellRates).length > 0 ? Number(Object.values(sellRates)[0]) : 0;

            db.prepare(`
                INSERT INTO Tariff(site_id, name, updated)
                VALUES (?, ?, datetime('now'))
                ON CONFLICT(site_id, name) DO UPDATE SET name=excluded.name
            `).run(siteId, tariffName);

            const tariffRow = db.prepare(`SELECT id FROM Tariff WHERE site_id = ? AND name = ?`).get(siteId, tariffName) as { id: number } | undefined;
            if (!tariffRow) continue;

            // Refresh seasons/schedules for this tariff
            db.prepare(`DELETE FROM TariffSchedule WHERE season_id IN (SELECT id FROM TariffSeason WHERE tariff_id = ?)`).run(tariffRow.id);
            db.prepare(`DELETE FROM TariffSeason WHERE tariff_id = ?`).run(tariffRow.id);

            const seasonEntries = Object.entries(seasonsMap) as [string, Season][];
            if (seasonEntries.length === 0) {
                this.ensureDefaultSeasonAndSchedule(tariffRow.id, buyRate, sellRate);
                continue;
            }

            for (const [seasonName, season] of seasonEntries) {
                const fromMonth = pickNumber(season, ['fromMonth', 'from_month'], 1) ?? 1;
                const fromDay = pickNumber(season, ['fromDay', 'from_day'], 1) ?? 1;
                const toMonth = pickNumber(season, ['toMonth', 'to_month'], 12) ?? 12;
                const toDay = pickNumber(season, ['toDay', 'to_day'], 31) ?? 31;

                db.prepare(`
                    INSERT INTO TariffSeason(tariff_id, name, from_month, from_day, to_month, to_day, buy_rate, sell_rate)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                `).run(
                    tariffRow.id,
                    seasonName,
                    fromMonth,
                    fromDay,
                    toMonth,
                    toDay,
                    0, // buy_rate (moved to schedule)
                    0  // sell_rate (moved to schedule)
                );
                const seasonRow = db.prepare(`SELECT id FROM TariffSeason WHERE tariff_id = ? AND name = ?`).get(tariffRow.id, seasonName) as { id: number } | undefined;
                if (!seasonRow) continue;

                const touPeriods = season.tou_periods || {};
                const touPeriodEntries = Object.entries(touPeriods);

                if (touPeriodEntries.length === 0) {
                    this.ensureDefaultSchedule(seasonRow.id, 0, 0); // Default rates for default schedule
                    continue;
                }

                for (const [touName, periodGroup] of touPeriodEntries) {
                    const periods = (periodGroup as SeasonPeriods).periods || [];

                    // Find rates for this TOU period
                    const touBuyRate = buyRates[touName] ?? 0;
                    const touSellRate = sellRates[touName] ?? 0;

                    if (periods.length === 0) {
                        this.ensureDefaultSchedule(seasonRow.id, touBuyRate, touSellRate, touName);
                        continue;
                    }

                    for (const p of periods) {
                        db.prepare(`
                            INSERT INTO TariffSchedule(season_id, name, buy_rate, sell_rate, from_day_of_week, to_day_of_week, from_hour, from_minute, to_hour, to_minute)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        `).run(
                            seasonRow.id,
                            touName,
                            touBuyRate,
                            touSellRate,
                            pickNumber(p, ['fromDayOfWeek', 'from_day_of_week']),
                            pickNumber(p, ['toDayOfWeek', 'to_day_of_week']),
                            pickNumber(p, ['fromHour', 'from_hour']),
                            pickNumber(p, ['fromMinute', 'from_minute']),
                            pickNumber(p, ['toHour', 'to_hour']),
                            pickNumber(p, ['toMinute', 'to_minute'])
                        );
                    }
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
        // Fetch history for the interval at the requested granularity
        const [history, soeHistory] = await Promise.all([
            this.client.getEnergyHistory(site.id, start, end, period, site.timezone),
            this.client.getSoeHistory(site.id, start, end, period, site.timezone).catch(err => {
                console.warn('Failed to fetch SOC history, SOC will be null:', err);
                return [];
            })
        ]);
        if (!history || history.length === 0) return;

        const soeByTimestamp = new Map<number, number>();
        for (const s of soeHistory) {
            if (s.percentage_charged !== undefined && s.timestamp) {
                const tsKey = new Date(s.timestamp).getTime();
                if (!Number.isNaN(tsKey)) {
                    soeByTimestamp.set(tsKey, s.percentage_charged);
                }
            }
        }

        const energyDatas = this.processHistory(site, history, soeByTimestamp);
        const usages = this.aggregateUsage(site, energyDatas);

        const startStr = start.toISOString();
        const endStr = end.toISOString();

        // Wrap this interval in a single transaction so partial failures don't affect other days
        const tx = db.transaction(() => {
            db.prepare('DELETE FROM EnergyData WHERE site_id = ? AND timestamp >= ? AND timestamp < ?').run(site.id, startStr, endStr);
            this.insertEnergyData(energyDatas, true);
            this.insertEnergyUsage(usages, true);
        });

        tx();
    }

    private processHistory(site: SiteWithTariffs, history: EnergyHistoryEntry[], soeByTimestamp: Map<number, number>): any[] {
        const schedule = new Schedule(site.tariffs);
        const results: any[] = [];

        for (const h of history) {
            const ts = new Date(h.timestamp);
            const tp = this.getTariffPeriodOrFallback(site, schedule, ts);
            if (!tp) {
                console.warn(`No tariff period found for ${h.timestamp}; skipping row`);
                continue;
            }

            const gridImported = h.grid_energy_imported ?? 0;
            const gridExported = h.total_grid_energy_exported ?? 0;
            let grid = gridImported;
            if (grid === 0) {
                grid = -gridExported; // Go logic: if imported > 0 use it, else -exported
                // Wait, Go logic:
                // if h.GridEnergyImported > 0 { grid = h.GridEnergyImported } else { grid = 0 - h.TotalGridEnergyExported }
                // Note: API might return both? Usually one is non-zero per interval or net.
                // Let's stick to Go logic.
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
                load_power: h.total_home_usage ?? 0,
                solar_power: h.solar_energy_exported ?? 0, // Wait, Go uses SolarEnergyExported? 
                // Go: SolarPower: h.SolarEnergyExported. 
                // Is this correct? Usually Solar Generation is total_solar_generation.
                // Let's check Go code again.
                // Go: SolarPower:   h.SolarEnergyExported,
                // But in EnergyHistoryEntry struct: SolarEnergyExported float64 `json:"solar_energy_exported,omitempty"`
                // And TotalSolarGeneration float64 `json:"total_solar_generation,omitempty"`
                // If the Go code uses SolarEnergyExported, I should probably use it too to match.
                // But "Solar Power" usually implies generation.
                // Let's assume Go code is correct for now.
                grid_power: grid,
                battery_power: battery,
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
                console.warn(`Skipping row for unknown tariff_id=${row.tariff_id}`);
                return false;
            }
            return true;
        });

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
