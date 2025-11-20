import { db, EnergyUsage, Tariff, Site } from './db';

export interface UsageData {
    start: Date;
    homeUsage: number;
    gridUsage: number;
    solarProduction: number;
    batteryChange: number;
    tariff: Tariff;
}

export interface SiteWithTariffs extends Site {
    tariffs: Tariff[];
}

export class EnergyRepo {
    getEnergyUsage(siteId: string, start: Date, end: Date): UsageData[] {
        // Get tariffs for the site first to map them
        const tariffs = db.prepare('SELECT * FROM Tariff WHERE site_id = ?').all(siteId) as Tariff[];
        const tariffMap = new Map<number, Tariff>();
        tariffs.forEach(t => tariffMap.set(t.id, t));

        // Query EnergyUsage
        // SQLite stores dates as strings usually, but depends on how they were inserted.
        // The Go code uses "2006-01-02 15:04:05" format.
        const startStr = start.toISOString().replace('T', ' ').split('.')[0];
        const endStr = end.toISOString().replace('T', ' ').split('.')[0];

        const rows = db.prepare(`
        SELECT tariff_id, start, load_usage, solar_produced, grid_usage, battery_usage 
        FROM EnergyUsage
        WHERE start >= ? AND start < ?
    `).all(startStr, endStr) as EnergyUsage[];

        const results: UsageData[] = [];

        for (const row of rows) {
            const tariff = tariffMap.get(row.tariff_id);
            if (!tariff) continue; // Skip if tariff not found for this site (shouldn't happen if logic is correct)

            results.push({
                start: new Date(row.start),
                homeUsage: row.load_usage,
                gridUsage: row.grid_usage,
                solarProduction: row.solar_produced,
                batteryChange: row.battery_usage,
                tariff: tariff
            });
        }

        return results;
    }

    getSite(siteId: string): SiteWithTariffs | undefined {
        const site = db.prepare('SELECT * FROM Site WHERE id = ?').get(siteId) as Site | undefined;
        if (!site) return undefined;

        const tariffs = db.prepare('SELECT * FROM Tariff WHERE site_id = ?').all(siteId) as Tariff[];

        for (const tariff of tariffs) {
            const seasons = db.prepare('SELECT * FROM TariffSeason WHERE tariff_id = ?').all(tariff.id) as any[]; // Type cast later
            tariff.seasons = seasons;

            for (const season of seasons) {
                const schedules = db.prepare('SELECT * FROM TariffSchedule WHERE season_id = ?').all(season.id) as any[];
                season.schedules = schedules;
            }
        }

        return {
            ...site,
            tariffs
        };
    }

    getHourlyEnergyData(siteId: string, date: Date): Array<{
        hour: number;
        homeUsage: number;
        solarProduction: number;
        gridUsage: number;
        batteryUsage: number;
        batterySoc: number | null;
    }> {
        // SQLite stores timestamps as strings with timezone info
        // We need to extract just the date part for comparison
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const dateStr = `${year}-${month}-${day}`;

        const rows = db.prepare(`
            SELECT 
                CAST(strftime('%H', datetime(timestamp, 'localtime')) AS INTEGER) as hour,
                SUM(load_power) as home_usage,
                SUM(solar_power) as solar_production,
                SUM(grid_power) as grid_usage,
                SUM(battery_power) as battery_usage,
                AVG(battery_soc) as battery_soc
            FROM EnergyData
            WHERE site_id = ? AND date(datetime(timestamp, 'localtime')) = ?
            GROUP BY hour
            ORDER BY hour
        `).all(siteId, dateStr) as any[];

        return rows.map(row => ({
            hour: row.hour,
            homeUsage: row.home_usage / 1000, // Convert to kWh
            solarProduction: row.solar_production / 1000,
            gridUsage: row.grid_usage / 1000,
            batteryUsage: row.battery_usage / 1000,
            batterySoc: row.battery_soc, // Already a percentage
        }));
    }
}
