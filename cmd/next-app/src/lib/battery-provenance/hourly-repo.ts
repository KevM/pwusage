import { pool } from '../db';
import type { HourlyBucket } from './hourly-profile';
import type { EnergyHourlyRow } from '../db';

export class HourlyRepo {
    async upsertHourly(rows: HourlyBucket[]): Promise<void> {
        if (rows.length === 0) return;
        const cols = 13; // must equal the number of values pushed per row below
        const placeholders: string[] = [];
        const params: unknown[] = [];
        let p = 1;
        for (const r of rows) {
            const ph: string[] = [];
            for (let k = 0; k < cols; k++) ph.push(`$${p++}`);
            placeholders.push(`(${ph.join(', ')})`);
            params.push(
                r.siteId, r.localDate, r.hour,
                r.loadWh, r.solarToHomeWh, r.solarToBatteryWh, r.solarToGridWh,
                r.gridToHomeWh, r.gridToBatteryWh, r.batteryToHomeWh, r.batteryToGridWh,
                r.solarOnlyImportWh, r.solarOnlyExportWh,
            );
        }
        await pool.query(`
            INSERT INTO "EnergyHourly"(
                site_id, local_date, hour,
                load_wh, solar_to_home_wh, solar_to_battery_wh, solar_to_grid_wh,
                grid_to_home_wh, grid_to_battery_wh, battery_to_home_wh, battery_to_grid_wh,
                solar_only_import_wh, solar_only_export_wh
            ) VALUES ${placeholders.join(', ')}
            ON CONFLICT(site_id, local_date, hour) DO UPDATE SET
                load_wh = EXCLUDED.load_wh,
                solar_to_home_wh = EXCLUDED.solar_to_home_wh,
                solar_to_battery_wh = EXCLUDED.solar_to_battery_wh,
                solar_to_grid_wh = EXCLUDED.solar_to_grid_wh,
                grid_to_home_wh = EXCLUDED.grid_to_home_wh,
                grid_to_battery_wh = EXCLUDED.grid_to_battery_wh,
                battery_to_home_wh = EXCLUDED.battery_to_home_wh,
                battery_to_grid_wh = EXCLUDED.battery_to_grid_wh,
                solar_only_import_wh = EXCLUDED.solar_only_import_wh,
                solar_only_export_wh = EXCLUDED.solar_only_export_wh,
                updated_at = now()
        `, params);
    }

    async getAllForSite(siteId: string): Promise<EnergyHourlyRow[]> {
        const res = await pool.query(
            `SELECT site_id, local_date::text AS local_date, hour,
                    load_wh, solar_to_home_wh, solar_to_battery_wh, solar_to_grid_wh,
                    grid_to_home_wh, grid_to_battery_wh, battery_to_home_wh, battery_to_grid_wh,
                    solar_only_import_wh, solar_only_export_wh
             FROM "EnergyHourly" WHERE site_id = $1
             ORDER BY local_date ASC, hour ASC`,
            [siteId],
        );
        return res.rows as EnergyHourlyRow[];
    }
}
