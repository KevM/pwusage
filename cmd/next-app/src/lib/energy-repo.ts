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

        return {
            ...site,
            tariffs
        };
    }
}
