import { TeslaClient, EnergyHistoryEntry } from './tesla-client';
import { EnergyRepo, SiteWithTariffs, UsageData } from './energy-repo';
import { Schedule } from './schedule';
import { db, EnergyUsage, Tariff } from './db';

export class Importer {
    private client: TeslaClient;
    private repo: EnergyRepo;

    constructor(token: string) {
        this.client = new TeslaClient(token);
        this.repo = new EnergyRepo();
    }

    async importSite(siteId: string) {
        const site = this.repo.getSite(siteId);
        if (!site) {
            console.error(`Site ${siteId} not found in DB`);
            return;
        }

        // Determine start date
        // Get last timestamp from EnergyData
        const lastRow = db.prepare('SELECT timestamp FROM EnergyData WHERE site_id = ? ORDER BY timestamp DESC LIMIT 1').get(siteId) as { timestamp: string } | undefined;

        let start: Date;
        if (lastRow) {
            start = new Date(lastRow.timestamp);
        } else {
            start = new Date(site.installed);
        }

        // Normalize start to beginning of day if it's the installed date, 
        // or keep it if it's the last sync (though usually we might want to overlap slightly or start from next interval)
        // The Go code replaces start with last timestamp if found.
        // And then iterates day by day.

        const now = new Date();
        // Loop day by day
        let current = new Date(start);
        current.setHours(0, 0, 0, 0);

        while (current < now) {
            const nextDay = new Date(current);
            nextDay.setDate(nextDay.getDate() + 1);

            // End of this day (or now if it's today)
            let end = nextDay;
            if (end > now) end = now;

            console.log(`Importing ${site.name} for ${current.toISOString()}`);
            await this.loadDay(site, current, end);

            current = nextDay;
        }
    }

    private async loadDay(site: SiteWithTariffs, start: Date, end: Date) {
        // Delete existing data for this day to avoid duplicates/conflicts if re-importing
        // But we need to be careful not to delete future data if we are doing partial day.
        // The Go code deletes the whole day.

        const startStr = start.toISOString();
        const nextDay = new Date(start);
        nextDay.setDate(nextDay.getDate() + 1);
        const nextDayStr = nextDay.toISOString();

        db.prepare('DELETE FROM EnergyData WHERE site_id = ? AND timestamp >= ? AND timestamp < ?').run(site.id, startStr, nextDayStr);

        // Fetch live status to get current SOC
        let currentSOC: number | null = null;
        try {
            const liveStatus = await this.client.getLiveStatus(site.id);
            currentSOC = liveStatus.percentage_charged;
        } catch (error) {
            console.warn('Failed to fetch live status, SOC will be null:', error);
        }

        // Fetch from Tesla
        // API requires timezone. Site has timezone string.
        const history = await this.client.getEnergyHistory(site.id, start, nextDay, "day", site.timezone);

        if (!history || history.length === 0) return;

        // Insert EnergyData
        const energyDatas = this.processHistory(site, history, currentSOC);
        this.insertEnergyData(energyDatas);

        // Aggregate and Insert EnergyUsage
        const usages = this.aggregateUsage(site, energyDatas);
        this.insertEnergyUsage(usages);
    }

    private processHistory(site: SiteWithTariffs, history: EnergyHistoryEntry[], currentSOC: number | null): any[] {
        const schedule = new Schedule(site.tariffs);
        const results: any[] = [];

        for (const h of history) {
            const ts = new Date(h.timestamp);
            const tp = schedule.getTariffPeriod(ts);
            if (!tp) {
                console.warn(`No tariff period found for ${h.timestamp}`);
                continue;
            }

            let grid = h.grid_energy_imported;
            if (grid === 0) {
                grid = -h.total_grid_energy_exported; // Go logic: if imported > 0 use it, else -exported
                // Wait, Go logic:
                // if h.GridEnergyImported > 0 { grid = h.GridEnergyImported } else { grid = 0 - h.TotalGridEnergyExported }
                // Note: API might return both? Usually one is non-zero per interval or net.
                // Let's stick to Go logic.
            }

            let battery = h.total_battery_charge;
            if (battery === 0) {
                battery = -h.total_battery_discharge;
            }

            results.push({
                site_id: site.id,
                tariff_id: tp.tariff.id,
                timestamp: h.timestamp,
                load_power: h.total_home_usage,
                solar_power: h.solar_energy_exported, // Wait, Go uses SolarEnergyExported? 
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
                battery_soc: currentSOC // Use current SOC for all records in this batch
            });
        }
        return results;
    }

    private insertEnergyData(data: any[]) {
        const stmt = db.prepare(`
            INSERT INTO EnergyData(site_id, tariff_id, timestamp, load_power, solar_power, grid_power, battery_power, battery_soc) 
            VALUES (@site_id, @tariff_id, @timestamp, @load_power, @solar_power, @grid_power, @battery_power, @battery_soc)
        `);

        const insertMany = db.transaction((rows: any[]) => {
            for (const row of rows) stmt.run(row);
        });

        insertMany(data);
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

    private insertEnergyUsage(usages: UsageData[]) {
        const stmt = db.prepare(`
            INSERT INTO EnergyUsage(tariff_id, start, load_usage, solar_produced, grid_usage, battery_usage) 
            VALUES (@tariff_id, @start, @load_usage, @solar_produced, @grid_usage, @battery_usage)
            ON CONFLICT(tariff_id, start) DO UPDATE SET 
                load_usage = excluded.load_usage, 
                solar_produced = excluded.solar_produced, 
                grid_usage = excluded.grid_usage, 
                battery_usage = excluded.battery_usage
        `);

        const insertMany = db.transaction((rows: UsageData[]) => {
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
        });

        insertMany(usages);
    }
}
