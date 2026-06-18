import { pool, Tariff, TariffSchedule, TariffSeason } from './db';
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

    /** All metered (non-reporting) versions for a site as full Tariff→Season→Schedule
     *  structures, newest effective_from first. Feeds the date-resolved metered timeline
     *  (site.tariffs is current-only, so the savings timeline needs this instead). */
    async listMeteredVersions(siteId: string): Promise<Tariff[]> {
        const res = await pool.query(
            `SELECT t.id AS tariff_id, t.name AS tariff_name, t.updated AS tariff_updated,
                    t.site_id AS tariff_site_id, t.reporting_only AS tariff_reporting_only,
                    t.effective_from::text AS tariff_effective_from, t.version AS tariff_version,
                    se.id AS season_id, se.name AS season_name,
                    se.from_month, se.from_day, se.to_month, se.to_day,
                    se.buy_rate AS season_buy_rate, se.sell_rate AS season_sell_rate,
                    sc.id AS schedule_id, sc.name AS schedule_name,
                    sc.buy_rate AS schedule_buy_rate, sc.sell_rate AS schedule_sell_rate,
                    sc.from_day_of_week, sc.from_hour, sc.from_minute,
                    sc.to_day_of_week, sc.to_hour, sc.to_minute
               FROM "Tariff" t
               JOIN "TariffSeason" se ON se.tariff_id = t.id
               LEFT JOIN "TariffSchedule" sc ON sc.season_id = se.id
              WHERE t.site_id = $1 AND NOT t.reporting_only
              ORDER BY t.effective_from DESC NULLS LAST, t.version DESC, se.id, sc.id`,
            [siteId],
        );
        const tariffMap = new Map<number, Tariff>();
        const seasonMap = new Map<number, TariffSeason>();
        const order: Tariff[] = [];
        for (const r of res.rows) {
            const tid = Number(r.tariff_id);
            if (!tariffMap.has(tid)) {
                const tariff: Tariff = {
                    id: tid, site_id: r.tariff_site_id as string, updated: new Date(r.tariff_updated as string | Date),
                    name: (r.tariff_name as string | null) ?? null, reporting_only: r.tariff_reporting_only === true,
                    effective_from: (r.tariff_effective_from as string | null) ?? null,
                    version: r.tariff_version != null ? Number(r.tariff_version) : undefined,
                    seasons: [],
                };
                tariffMap.set(tid, tariff);
                order.push(tariff);
            }
            const tariff = tariffMap.get(tid)!;
            const sid = Number(r.season_id);
            if (!seasonMap.has(sid)) {
                const season: TariffSeason = {
                    id: sid, tariff_id: tid, name: (r.season_name as string | null) ?? null,
                    from_month: Number(r.from_month), from_day: Number(r.from_day),
                    to_month: Number(r.to_month), to_day: Number(r.to_day),
                    buy_rate: Number(r.season_buy_rate), sell_rate: Number(r.season_sell_rate), schedules: [],
                };
                seasonMap.set(sid, season);
                tariff.seasons!.push(season);
            }
            if (r.schedule_id != null) {
                seasonMap.get(sid)!.schedules!.push({
                    id: Number(r.schedule_id), season_id: sid, name: (r.schedule_name as string | null) ?? null,
                    buy_rate: r.schedule_buy_rate != null ? Number(r.schedule_buy_rate) : null,
                    sell_rate: r.schedule_sell_rate != null ? Number(r.schedule_sell_rate) : null,
                    from_day_of_week: r.from_day_of_week as number | null, from_hour: r.from_hour as number | null,
                    from_minute: r.from_minute as number | null, to_day_of_week: r.to_day_of_week as number | null,
                    to_hour: r.to_hour as number | null, to_minute: r.to_minute as number | null,
                } as TariffSchedule);
            }
        }
        return order;
    }

    // === Commands ===
    /**
     * Append a new tariff version (Tariff + seasons + schedules) and demote the
     * previous current version. Never deletes — so EnergyData referencing older
     * versions survives and the importer's snapshot can never go stale.
     * No-op when the current version already has identical content.
     */
    async addTariffVersion(siteId: string, parsed: ParsedTariff, detectionDate: string): Promise<void> {
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

            // First version carries backward (null); later versions are dated to detection (the
            // honest upper bound — Tesla's payload has no real effective date; user can correct it).
            const effectiveFrom = version === 1 ? null : detectionDate;

            // Insert the new version.
            const tariffRes = await client.query(
                `INSERT INTO "Tariff"(site_id, name, version, is_current, content_hash, effective_from, updated)
                 VALUES ($1, $2, $3, true, $4, $5, NOW())
                 RETURNING id`,
                [siteId, parsed.name, version, newHash, effectiveFrom]
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
