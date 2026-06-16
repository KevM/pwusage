import { pool } from '../db';
import { buildFixedComparisonInput } from './fixed-comparison';

export interface FixedComparisonInputRow {
    name: string;
    buyRate: number;
    sellRate: number;
    effectiveFrom: string | null; // 'YYYY-MM-DD'
}

export interface EditVersionInput {
    buyRate: number;
    sellRate: number;
    effectiveFrom: string | null; // 'YYYY-MM-DD'
}

export interface ComparisonVersion {
    version: number;
    is_current: boolean;
    effective_from: string | null;
    buy_rate: number;
    sell_rate: number;
}

export interface ComparisonPlan {
    name: string;
    versions: ComparisonVersion[]; // newest effective_from first
}

export class ComparisonTariffRepo {
    /** Edit one reporting-only Fixed comparison version's rates + effective_from.
     *  A Fixed plan carries its rate on BOTH the season and its schedule, so update
     *  both. Guarded `reporting_only` so a metered tariff is never touched; a non-match
     *  rolls back. */
    async editComparisonVersion(siteId: string, name: string, version: number, input: EditVersionInput): Promise<void> {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('SELECT 1 FROM "Site" WHERE id = $1 FOR UPDATE', [siteId]);

            const tRes = await client.query(
                `UPDATE "Tariff" SET effective_from = $4, updated = NOW()
                  WHERE site_id = $1 AND name = $2 AND version = $3 AND reporting_only
                  RETURNING id`,
                [siteId, name, version, input.effectiveFrom],
            );
            if (tRes.rowCount === 0) {
                await client.query('ROLLBACK');
                return;
            }
            const tariffId = tRes.rows[0].id;

            await client.query(
                `UPDATE "TariffSeason" SET buy_rate = $2, sell_rate = $3 WHERE tariff_id = $1`,
                [tariffId, input.buyRate, input.sellRate],
            );
            await client.query(
                `UPDATE "TariffSchedule" SET buy_rate = $2, sell_rate = $3
                  WHERE season_id IN (SELECT id FROM "TariffSeason" WHERE tariff_id = $1)`,
                [tariffId, input.buyRate, input.sellRate],
            );
            await client.query(
                `UPDATE "Tariff" SET is_current = false
                  WHERE site_id = $1 AND name = $2 AND reporting_only`,
                [siteId, name],
            );
            await client.query(
                `UPDATE "Tariff" SET is_current = true
                  WHERE id = (
                    SELECT id FROM "Tariff"
                     WHERE site_id = $1 AND name = $2 AND reporting_only
                     ORDER BY effective_from DESC NULLS LAST, version DESC
                     LIMIT 1)`,
                [siteId, name],
            );
            await client.query('COMMIT');
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
    }

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

    /** Append a reporting-only Fixed version for (site, name); demote the prior
     *  current version of that same name only. Mints a full-year flat season +
     *  all-day/all-week schedule. */
    async appendFixedComparison(siteId: string, input: FixedComparisonInputRow): Promise<void> {
        // Single source of the flat chain (incl. the 0..6 day-of-week gotcha), tested in fixed-comparison.test.ts.
        const chain = buildFixedComparisonInput({ name: input.name, buyRate: input.buyRate, sellRate: input.sellRate });
        const season = chain.seasons[0];
        const sched = season.schedules[0];
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('SELECT 1 FROM "Site" WHERE id = $1 FOR UPDATE', [siteId]);

            await client.query(
                `UPDATE "Tariff" SET is_current = false
                  WHERE site_id = $1 AND name = $2 AND reporting_only AND is_current`,
                [siteId, input.name],
            );

            const verRes = await client.query(
                `SELECT COALESCE(MAX(version), 0) + 1 AS next FROM "Tariff"
                  WHERE site_id = $1 AND name = $2`,
                [siteId, input.name],
            );
            const version = verRes.rows[0].next;

            const tRes = await client.query(
                `INSERT INTO "Tariff"(site_id, name, version, is_current, reporting_only, effective_from, updated)
                 VALUES ($1, $2, $3, true, true, $4, NOW()) RETURNING id`,
                [siteId, input.name, version, input.effectiveFrom],
            );
            const tariffId = tRes.rows[0].id;

            const sRes = await client.query(
                `INSERT INTO "TariffSeason"(tariff_id, name, from_month, from_day, to_month, to_day, buy_rate, sell_rate)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
                [tariffId, season.name, season.from_month, season.from_day, season.to_month, season.to_day, season.buy_rate, season.sell_rate],
            );
            const seasonId = sRes.rows[0].id;

            await client.query(
                `INSERT INTO "TariffSchedule"(season_id, name, buy_rate, sell_rate, from_day_of_week, to_day_of_week, from_hour, from_minute, to_hour, to_minute)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
                [seasonId, sched.name, sched.buy_rate, sched.sell_rate, sched.from_day_of_week, sched.to_day_of_week, sched.from_hour, sched.from_minute, sched.to_hour, sched.to_minute],
            );

            await client.query('COMMIT');
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
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

    /** All reporting-only Fixed plans for a site, grouped by name, newest first. */
    async listFixedComparisons(siteId: string): Promise<ComparisonPlan[]> {
        const res = await pool.query(
            `SELECT t.name, t.version, t.is_current, t.effective_from::text AS effective_from,
                    se.buy_rate, se.sell_rate
               FROM "Tariff" t
               JOIN "TariffSeason" se ON se.tariff_id = t.id
              WHERE t.site_id = $1 AND t.reporting_only
              ORDER BY t.name ASC, t.effective_from DESC NULLS LAST, t.version DESC`,
            [siteId],
        );
        const byName = new Map<string, ComparisonPlan>();
        for (const r of res.rows) {
            const name = r.name as string;
            if (!byName.has(name)) byName.set(name, { name, versions: [] });
            byName.get(name)!.versions.push({
                version: Number(r.version),
                is_current: r.is_current === true,
                effective_from: r.effective_from ?? null,
                buy_rate: Number(r.buy_rate),
                sell_rate: Number(r.sell_rate),
            });
        }
        return Array.from(byName.values());
    }
}
