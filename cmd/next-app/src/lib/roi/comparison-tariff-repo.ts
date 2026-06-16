import { pool, Tariff, TariffSeason } from '../db';
import type { ParsedSeason, ParsedTariff } from '../importer/tariff-parser';
import { canonicalizeSeasons } from './tou-coverage';

export interface ComparisonVersion {
    version: number;
    is_current: boolean;
    effective_from: string | null;
    buy_rate: number;
    sell_rate: number;
    kind: 'fixed' | 'tou';
}

export interface ComparisonPlan {
    name: string;
    versions: ComparisonVersion[]; // newest effective_from first
}

export class ComparisonTariffRepo {


    /** Delete one reporting-only comparison version (cascade drops its season/schedule).
     *  If it was the current version, promote the latest remaining version of the same
     *  name to current. Guarded `reporting_only` so EnergyData's metered tariff can never
     *  be cascade-deleted. A non-match rolls back. */
    async deleteComparisonVersion(siteId: string, name: string, version: number): Promise<void> {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('SELECT 1 FROM "Site" WHERE id = $1 FOR UPDATE', [siteId]);

            const del = await client.query(
                `DELETE FROM "Tariff"
                  WHERE site_id = $1 AND name = $2 AND version = $3 AND reporting_only
                  RETURNING is_current`,
                [siteId, name, version],
            );
            if (del.rowCount === 0) {
                await client.query('ROLLBACK');
                return;
            }

            if (del.rows[0].is_current === true) {
                await client.query(
                    `UPDATE "Tariff" SET is_current = true
                      WHERE id = (
                        SELECT id FROM "Tariff"
                         WHERE site_id = $1 AND name = $2 AND reporting_only
                         ORDER BY effective_from DESC NULLS LAST, version DESC
                         LIMIT 1)`,
                    [siteId, name],
                );
            }
            await client.query('COMMIT');
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
    }

    /** Delete an entire reporting-only comparison plan (all versions; cascade drops
     *  their seasons/schedules). Guarded `reporting_only`. */
    async deleteComparisonPlan(siteId: string, name: string): Promise<void> {
        await pool.query(
            `DELETE FROM "Tariff" WHERE site_id = $1 AND name = $2 AND reporting_only`,
            [siteId, name],
        );
    }

    /** True when a *current comparison* plan already uses this name, so "add new plan"
     *  doesn't silently append a version to an existing plan (use "+ add version" for that). */
    async comparisonNameInUse(siteId: string, name: string): Promise<boolean> {
        const res = await pool.query(
            `SELECT EXISTS(
                SELECT 1 FROM "Tariff"
                 WHERE site_id = $1 AND name = $2 AND reporting_only AND is_current
             ) AS exists`,
            [siteId, name],
        );
        return res.rows[0]?.exists === true;
    }

    /** Rename every reporting-only version of a comparison plan. Guarded reporting_only so a
     *  metered tariff is never relabeled. Callers run the collision guards first. */
    async renameComparisonPlan(siteId: string, oldName: string, newName: string): Promise<void> {
        await pool.query(
            `UPDATE "Tariff" SET name = $3, updated = NOW()
              WHERE site_id = $1 AND name = $2 AND reporting_only`,
            [siteId, oldName, newName],
        );
    }




    /** True when a *metered* current tariff already uses this name (would collide
     *  with the (site_id, name) WHERE is_current unique index). */
    async nameInUseByMetered(siteId: string, name: string): Promise<boolean> {
        const res = await pool.query(
            `SELECT EXISTS(
                SELECT 1 FROM "Tariff"
                 WHERE site_id = $1 AND name = $2 AND is_current AND NOT reporting_only
             ) AS exists`,
            [siteId, name],
        );
        return res.rows[0]?.exists === true;
    }

    /** All reporting-only plans for a site, grouped by name, newest first. Each version
     *  carries a rate-based `kind` (fixed iff its windows share one buy rate). */
    async listFixedComparisons(siteId: string): Promise<ComparisonPlan[]> {
        const res = await pool.query(
            `SELECT t.name, t.version, t.is_current, t.effective_from::text AS effective_from,
                    se.buy_rate, se.sell_rate,
                    COUNT(DISTINCT sc.buy_rate) AS distinct_buy_rates,
                    MIN(sc.buy_rate) AS window_buy_rate, MIN(sc.sell_rate) AS window_sell_rate
               FROM "Tariff" t
               JOIN "TariffSeason" se ON se.tariff_id = t.id
               LEFT JOIN "TariffSchedule" sc ON sc.season_id = se.id
              WHERE t.site_id = $1 AND t.reporting_only
              GROUP BY t.name, t.version, t.is_current, t.effective_from, se.buy_rate, se.sell_rate
              ORDER BY t.name ASC, t.effective_from DESC NULLS LAST, t.version DESC`,
            [siteId],
        );
        const byName = new Map<string, ComparisonPlan>();
        for (const r of res.rows) {
            const name = r.name as string;
            if (!byName.has(name)) byName.set(name, { name, versions: [] });
            const distinct = Number(r.distinct_buy_rates);
            const kind: 'fixed' | 'tou' = distinct > 1 ? 'tou' : 'fixed';
            // Fixed plans carry the rate on the window (or the season for legacy flat rows).
            const buy = r.window_buy_rate != null ? Number(r.window_buy_rate) : Number(r.buy_rate);
            const sell = r.window_sell_rate != null ? Number(r.window_sell_rate) : Number(r.sell_rate);
            byName.get(name)!.versions.push({
                version: Number(r.version),
                is_current: r.is_current === true,
                effective_from: r.effective_from ?? null,
                buy_rate: buy, sell_rate: sell, kind,
            });
        }
        return Array.from(byName.values());
    }

    /** Full parsed structure for one tariff version (metered or comparison). Reads need no
     *  reporting_only guard — the metered plan is a valid clone seed. Null when absent. */
    async getPlanStructure(siteId: string, name: string, version: number): Promise<ParsedTariff | null> {
        const res = await pool.query(
            `SELECT t.name AS tariff_name,
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
              WHERE t.site_id = $1 AND t.name = $2 AND t.version = $3
              ORDER BY se.id, sc.id`,
            [siteId, name, version],
        );
        if (res.rows.length === 0) return null;
        const bySeason = new Map<number, ParsedSeason>();
        for (const r of res.rows) {
            const sid = Number(r.season_id);
            if (!bySeason.has(sid)) {
                bySeason.set(sid, {
                    name: r.season_name ?? '',
                    from_month: Number(r.from_month), from_day: Number(r.from_day),
                    to_month: Number(r.to_month), to_day: Number(r.to_day),
                    buy_rate: Number(r.season_buy_rate), sell_rate: Number(r.season_sell_rate),
                    schedules: [],
                });
            }
            if (r.schedule_id != null) {
                bySeason.get(sid)!.schedules.push({
                    name: r.schedule_name ?? '',
                    buy_rate: r.schedule_buy_rate != null ? Number(r.schedule_buy_rate) : Number(r.season_buy_rate),
                    sell_rate: r.schedule_sell_rate != null ? Number(r.schedule_sell_rate) : Number(r.season_sell_rate),
                    from_day_of_week: Number(r.from_day_of_week), to_day_of_week: Number(r.to_day_of_week),
                    from_hour: Number(r.from_hour), from_minute: Number(r.from_minute),
                    to_hour: Number(r.to_hour), to_minute: Number(r.to_minute),
                });
            }
        }
        return { name: res.rows[0].tariff_name as string, seasons: Array.from(bySeason.values()) };
    }

    /** Persist a full parsed schedule as a reporting-only chain. Same-rate seasons are
     *  canonicalized to one 24/7 window first (decision 9). intent:
     *   - 'create'        : new plan/version 1 (or next version of an existing name)
     *   - 'append-version': append the next effective-dated version, demoting the prior current
     *   - 'replace'       : replace the structure of an existing version in place (requires `version`)
     *  All writes are reporting_only-guarded. */
    async saveComparisonStructure(
        siteId: string, name: string, effectiveFrom: string | null,
        seasons: ParsedSeason[], intent: 'create' | 'append-version' | 'replace', version?: number,
    ): Promise<void> {
        const canon = canonicalizeSeasons(seasons);
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('SELECT 1 FROM "Site" WHERE id = $1 FOR UPDATE', [siteId]);

            let tariffId: number;
            if (intent === 'replace') {
                const tRes = await client.query(
                    `UPDATE "Tariff" SET effective_from = $4, updated = NOW()
                      WHERE site_id = $1 AND name = $2 AND version = $3 AND reporting_only
                      RETURNING id`,
                    [siteId, name, version, effectiveFrom],
                );
                if (tRes.rowCount === 0) { await client.query('ROLLBACK'); return; }
                tariffId = tRes.rows[0].id;
                await client.query(
                    `DELETE FROM "TariffSeason"
                      WHERE tariff_id IN (
                        SELECT id FROM "Tariff" WHERE site_id = $1 AND name = $2 AND version = $3 AND reporting_only)`,
                    [siteId, name, version],
                );
            } else {
                await client.query(
                    `UPDATE "Tariff" SET is_current = false
                      WHERE site_id = $1 AND name = $2 AND reporting_only AND is_current`,
                    [siteId, name],
                );
                const verRes = await client.query(
                    `SELECT COALESCE(MAX(version), 0) + 1 AS next FROM "Tariff" WHERE site_id = $1 AND name = $2`,
                    [siteId, name],
                );
                const tRes = await client.query(
                    `INSERT INTO "Tariff"(site_id, name, version, is_current, reporting_only, effective_from, updated)
                     VALUES ($1, $2, $3, true, true, $4, NOW()) RETURNING id`,
                    [siteId, name, verRes.rows[0].next, effectiveFrom],
                );
                tariffId = tRes.rows[0].id;
            }

            for (const se of canon) {
                const sRes = await client.query(
                    `INSERT INTO "TariffSeason"(tariff_id, name, from_month, from_day, to_month, to_day, buy_rate, sell_rate)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
                    [tariffId, se.name, se.from_month, se.from_day, se.to_month, se.to_day, se.buy_rate, se.sell_rate],
                );
                const seasonId = sRes.rows[0].id;
                for (const w of se.schedules) {
                    await client.query(
                        `INSERT INTO "TariffSchedule"(season_id, name, buy_rate, sell_rate, from_day_of_week, to_day_of_week, from_hour, from_minute, to_hour, to_minute)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
                        [seasonId, w.name, w.buy_rate, w.sell_rate, w.from_day_of_week, w.to_day_of_week, w.from_hour, w.from_minute, w.to_hour, w.to_minute],
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

    /** All reporting-only plans for a site as full Tariff→Season→Schedule structures, grouped
     *  by name (newest effective_from first). Powers date-resolved grid column pricing. */
    async listComparisonStructures(siteId: string): Promise<{ name: string; tariffs: Tariff[] }[]> {
        const res = await pool.query(
            `SELECT t.id AS tariff_id, t.name AS tariff_name, t.updated AS tariff_updated,
                    t.site_id AS tariff_site_id, t.reporting_only AS tariff_reporting_only,
                    t.effective_from::text AS tariff_effective_from,
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
              WHERE t.site_id = $1 AND t.reporting_only
              ORDER BY t.name ASC, t.effective_from DESC NULLS LAST, t.version DESC, se.id, sc.id`,
            [siteId],
        );
        const tariffMap = new Map<number, Tariff>();
        const seasonMap = new Map<number, TariffSeason>();
        const order: { name: string; tariffs: Tariff[] }[] = [];
        const groupByName = new Map<string, { name: string; tariffs: Tariff[] }>();
        for (const r of res.rows) {
            const tid = Number(r.tariff_id);
            if (!tariffMap.has(tid)) {
                const tariff: Tariff = {
                    id: tid, site_id: r.tariff_site_id as string, updated: new Date(r.tariff_updated as string | Date),
                    name: (r.tariff_name as string | null) ?? null, reporting_only: r.tariff_reporting_only === true,
                    effective_from: (r.tariff_effective_from as string | null) ?? null, seasons: [],
                };
                tariffMap.set(tid, tariff);
                const name = tariff.name ?? '';
                if (!groupByName.has(name)) { const g = { name, tariffs: [] as Tariff[] }; groupByName.set(name, g); order.push(g); }
                groupByName.get(name)!.tariffs.push(tariff);
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
                });
            }
        }
        return order;
    }
}
