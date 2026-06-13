// roi-config-repo.ts
import { pool } from '../db';
import type { SiteRoiConfig } from '../db';

export class SiteRoiConfigRepo {
    async get(siteId: string): Promise<SiteRoiConfig | null> {
        const res = await pool.query(
            `SELECT site_id, solar_cost, solar_install_date::text AS solar_install_date,
                    battery_cost, battery_install_date::text AS battery_install_date,
                    fixed_buy_rate, fixed_sell_rate
             FROM "SiteRoiConfig" WHERE site_id = $1`,
            [siteId],
        );
        return (res.rows[0] as SiteRoiConfig) ?? null;
    }

    async upsert(c: SiteRoiConfig): Promise<void> {
        await pool.query(
            `INSERT INTO "SiteRoiConfig"
                (site_id, solar_cost, solar_install_date, battery_cost, battery_install_date, fixed_buy_rate, fixed_sell_rate)
             VALUES ($1,$2,$3,$4,$5,$6,$7)
             ON CONFLICT (site_id) DO UPDATE SET
                solar_cost = EXCLUDED.solar_cost,
                solar_install_date = EXCLUDED.solar_install_date,
                battery_cost = EXCLUDED.battery_cost,
                battery_install_date = EXCLUDED.battery_install_date,
                fixed_buy_rate = EXCLUDED.fixed_buy_rate,
                fixed_sell_rate = EXCLUDED.fixed_sell_rate,
                updated_at = now()`,
            [c.site_id, c.solar_cost, c.solar_install_date, c.battery_cost, c.battery_install_date, c.fixed_buy_rate, c.fixed_sell_rate],
        );
    }
}
