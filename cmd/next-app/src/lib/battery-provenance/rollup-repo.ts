import { pool } from '../db';
import type { PeriodRollup } from './replay';
import type { Tank } from './tank';

export class RollupRepo {
    async upsertRollups(rows: PeriodRollup[]): Promise<void> {
        if (rows.length === 0) return;
        const cols = 19;
        const placeholders: string[] = [];
        const params: unknown[] = [];
        let p = 1;
        for (const r of rows) {
            const ph: string[] = [];
            for (let k = 0; k < cols; k++) ph.push(`$${p++}`);
            placeholders.push(`(${ph.join(', ')})`);
            params.push(
                r.siteId, r.localDate, r.tariffScheduleId,
                r.loadWh, r.solarToHomeWh, r.solarToBatteryWh, r.solarToGridWh,
                r.gridToHomeWh, r.gridToBatteryWh, r.batteryToHomeWh, r.batteryToGridWh,
                r.tank.solarWh, r.tank.gridWh, r.tank.solarCost, r.tank.gridCost, r.tankAsOf,
                r.buyRate, r.sellRate, r.batterySoc,
            );
        }
        await pool.query(`
            INSERT INTO "EnergyRollup"(
                site_id, local_date, tariff_schedule_id,
                load_wh, solar_to_home_wh, solar_to_battery_wh, solar_to_grid_wh,
                grid_to_home_wh, grid_to_battery_wh, battery_to_home_wh, battery_to_grid_wh,
                tank_solar_wh, tank_grid_wh, tank_solar_cost, tank_grid_cost, tank_as_of,
                buy_rate, sell_rate, battery_soc
            ) VALUES ${placeholders.join(', ')}
            ON CONFLICT(site_id, local_date, tariff_schedule_id) DO UPDATE SET
                load_wh = EXCLUDED.load_wh,
                solar_to_home_wh = EXCLUDED.solar_to_home_wh,
                solar_to_battery_wh = EXCLUDED.solar_to_battery_wh,
                solar_to_grid_wh = EXCLUDED.solar_to_grid_wh,
                grid_to_home_wh = EXCLUDED.grid_to_home_wh,
                grid_to_battery_wh = EXCLUDED.grid_to_battery_wh,
                battery_to_home_wh = EXCLUDED.battery_to_home_wh,
                battery_to_grid_wh = EXCLUDED.battery_to_grid_wh,
                tank_solar_wh = EXCLUDED.tank_solar_wh,
                tank_grid_wh = EXCLUDED.tank_grid_wh,
                tank_solar_cost = EXCLUDED.tank_solar_cost,
                tank_grid_cost = EXCLUDED.tank_grid_cost,
                tank_as_of = EXCLUDED.tank_as_of,
                buy_rate = EXCLUDED.buy_rate,
                sell_rate = EXCLUDED.sell_rate,
                battery_soc = EXCLUDED.battery_soc,
                updated_at = now()
        `, params);
    }

    /** Carry-forward seed: the row with the greatest tank_as_of strictly before `beforeTs`. */
    async getSeedTank(siteId: string, beforeTs: Date): Promise<{ tank: Tank; tankAsOf: Date } | null> {
        const res = await pool.query(
            `SELECT tank_solar_wh, tank_grid_wh, tank_solar_cost, tank_grid_cost, tank_as_of
             FROM "EnergyRollup"
             WHERE site_id = $1 AND tank_as_of < $2
             ORDER BY tank_as_of DESC LIMIT 1`,
            [siteId, beforeTs],
        );
        if (res.rows.length === 0) return null;
        const row = res.rows[0];
        return {
            tank: {
                solarWh: Number(row.tank_solar_wh), gridWh: Number(row.tank_grid_wh),
                solarCost: Number(row.tank_solar_cost), gridCost: Number(row.tank_grid_cost),
            },
            tankAsOf: row.tank_as_of,
        };
    }

    async hasAnyRollup(siteId: string): Promise<boolean> {
        const res = await pool.query(`SELECT 1 FROM "EnergyRollup" WHERE site_id = $1 LIMIT 1`, [siteId]);
        return res.rows.length > 0;
    }
}
