import { pool, Tariff } from './db';
import { ParsedTariff } from './importer/tariff-parser';

export class TariffRepo {
    // === Queries ===
    async getTariffsForSite(siteId: string): Promise<Tariff[]> {
        const res = await pool.query('SELECT id, site_id, name, updated FROM "Tariff" WHERE site_id = $1', [siteId]);
        return res.rows;
    }

    // === Commands ===
    async replaceTariffsForSite(siteId: string, parsed: ParsedTariff): Promise<void> {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // 1. Delete existing tariff structures for this site (Schedules -> Seasons -> Tariff)
            const tariffIdsRes = await client.query('SELECT id FROM "Tariff" WHERE site_id = $1', [siteId]);
            const tariffIds = tariffIdsRes.rows.map(r => r.id);

            for (const tid of tariffIds) {
                await client.query('DELETE FROM "TariffSchedule" WHERE season_id IN (SELECT id FROM "TariffSeason" WHERE tariff_id = $1)', [tid]);
                await client.query('DELETE FROM "TariffSeason" WHERE tariff_id = $1', [tid]);
            }
            await client.query('DELETE FROM "Tariff" WHERE site_id = $1', [siteId]);

            // 2. Insert new tariff
            const tariffRes = await client.query(
                `INSERT INTO "Tariff"(site_id, name, updated)
                 VALUES ($1, $2, NOW())
                 RETURNING id`,
                [siteId, parsed.name]
            );
            const tariffId = tariffRes.rows[0].id;

            // 3. Insert seasons
            for (const season of parsed.seasons) {
                const seasonRes = await client.query(
                    `INSERT INTO "TariffSeason"(tariff_id, name, from_month, from_day, to_month, to_day, buy_rate, sell_rate)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                     RETURNING id`,
                    [tariffId, season.name, season.from_month, season.from_day, season.to_month, season.to_day, season.buy_rate, season.sell_rate]
                );
                const seasonId = seasonRes.rows[0].id;

                // 4. Insert schedules
                for (const schedule of season.schedules) {
                    await client.query(
                        `INSERT INTO "TariffSchedule"(season_id, name, buy_rate, sell_rate, from_day_of_week, to_day_of_week, from_hour, from_minute, to_hour, to_minute)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
                        [
                            seasonId, schedule.name, schedule.buy_rate, schedule.sell_rate,
                            schedule.from_day_of_week, schedule.to_day_of_week,
                            schedule.from_hour, schedule.from_minute, schedule.to_hour, schedule.to_minute,
                        ]
                    );
                }
            }

            await client.query('COMMIT');
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
    }
}
