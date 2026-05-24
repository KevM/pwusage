import { pool, Tariff, TariffSchedule } from './db';
import { ParsedTariff, tariffContentHash } from './importer/tariff-parser';

export class TariffRepo {
    // === Queries ===
    // No is_current filter on purpose: returns ALL versions, used by the billing
    // name-resolution map so historical EnergyData rows (which keep an older
    // version's tariff_id) still resolve to a tariff name.
    async getTariffsForSite(siteId: string): Promise<Tariff[]> {
        const res = await pool.query('SELECT id, site_id, name, updated FROM "Tariff" WHERE site_id = $1', [siteId]);
        return res.rows;
    }

    async getSchedulesForSite(siteId: string): Promise<TariffSchedule[]> {
        const res = await pool.query(
            `SELECT ts.*
             FROM "TariffSchedule" ts
             JOIN "TariffSeason" s ON ts.season_id = s.id
             JOIN "Tariff" t ON s.tariff_id = t.id
             WHERE t.site_id = $1`,
            [siteId]
        );
        return res.rows.map(row => ({
            id: Number(row.id),
            season_id: Number(row.season_id),
            name: row.name,
            buy_rate: row.buy_rate === null ? null : Number(row.buy_rate),
            sell_rate: row.sell_rate === null ? null : Number(row.sell_rate),
            from_day_of_week: row.from_day_of_week === null ? null : Number(row.from_day_of_week),
            from_hour: row.from_hour === null ? null : Number(row.from_hour),
            from_minute: row.from_minute === null ? null : Number(row.from_minute),
            to_day_of_week: row.to_day_of_week === null ? null : Number(row.to_day_of_week),
            to_hour: row.to_hour === null ? null : Number(row.to_hour),
            to_minute: row.to_minute === null ? null : Number(row.to_minute),
        }));
    }

    // === Commands ===
    /**
     * Append a new tariff version (Tariff + seasons + schedules) and demote the
     * previous current version. Never deletes — so EnergyData referencing older
     * versions survives and the importer's snapshot can never go stale.
     * No-op when the current version already has identical content.
     */
    async addTariffVersion(siteId: string, parsed: ParsedTariff): Promise<void> {
        const newHash = tariffContentHash(parsed);
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // Acquire write lock on the parent Site row to serialize concurrent tariff updates for this site.
            await client.query('SELECT 1 FROM "Site" WHERE id = $1 FOR UPDATE', [siteId]);

            // Idempotency guard: skip if current version already has this content.
            const currentRes = await client.query(
                'SELECT content_hash FROM "Tariff" WHERE site_id = $1 AND is_current LIMIT 1',
                [siteId]
            );
            if (currentRes.rows[0]?.content_hash === newHash) {
                await client.query('COMMIT');
                return;
            }

            // Demote the current version (no delete).
            await client.query(
                'UPDATE "Tariff" SET is_current = false WHERE site_id = $1 AND is_current',
                [siteId]
            );

            // Next version number for this site.
            const verRes = await client.query(
                'SELECT COALESCE(MAX(version), 0) + 1 AS next FROM "Tariff" WHERE site_id = $1',
                [siteId]
            );
            const version = verRes.rows[0].next;

            // Insert the new version.
            const tariffRes = await client.query(
                `INSERT INTO "Tariff"(site_id, name, version, is_current, content_hash, updated)
                 VALUES ($1, $2, $3, true, $4, NOW())
                 RETURNING id`,
                [siteId, parsed.name, version, newHash]
            );
            const tariffId = tariffRes.rows[0].id;

            for (const season of parsed.seasons) {
                const seasonRes = await client.query(
                    `INSERT INTO "TariffSeason"(tariff_id, name, from_month, from_day, to_month, to_day, buy_rate, sell_rate)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                     RETURNING id`,
                    [tariffId, season.name, season.from_month, season.from_day, season.to_month, season.to_day, season.buy_rate, season.sell_rate]
                );
                const seasonId = seasonRes.rows[0].id;

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
