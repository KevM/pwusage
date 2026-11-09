import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool } from './db';
import { BatteryHoldRepo } from './battery-hold-repo';

/**
 * Merge a duplicate `Site` row into the real one for the same Powerwall.
 *
 * Deliberately narrow (design spec section 10): the duplicate must hold no history of its own, so
 * nothing needs copying. Anything with archived days, summaries, TRMNL devices, tags or an active
 * hold is refused and left for a fuller tool. The secondary's members move to the primary keeping
 * their own Tesla ID, then the secondary is deleted.
 */
export interface MergeEmptyDuplicateOptions {
    primaryId: string;
    secondaryId: string;
    /** Dry run unless true. */
    apply: boolean;
}

export interface MergeEmptyDuplicateResult {
    applied: boolean;
    blockers: string[];
    movedMembers: { userId: string; teslaEnergySiteId: string }[];
}

type Queryable = Pick<PoolClient, 'query'>;

interface SiteFacts {
    id: string;
    timezone: string;
    hardware: string | null;
}

async function evaluate(db: Queryable, primaryId: string, secondaryId: string, lock: boolean): Promise<MergeEmptyDuplicateResult> {
    if (primaryId === secondaryId) return { applied: false, blockers: ['same-site'], movedMembers: [] };

    // Fixed id order so concurrent merges can't deadlock.
    const { rows } = await db.query<{ id: string; timezone: string; tesla_hardware_id: string | null }>(
        `SELECT id, timezone, tesla_hardware_id FROM "Site" WHERE id = ANY($1) ORDER BY id${lock ? ' FOR UPDATE' : ''}`,
        [[primaryId, secondaryId]]);
    const facts = new Map<string, SiteFacts>(rows.map(r => [r.id, { id: r.id, timezone: r.timezone, hardware: r.tesla_hardware_id }]));
    const primary = facts.get(primaryId);
    const secondary = facts.get(secondaryId);
    const missing: string[] = [];
    if (!primary) missing.push('primary-not-found');
    if (!secondary) missing.push('secondary-not-found');
    if (!primary || !secondary) return { applied: false, blockers: missing, movedMembers: [] };

    const blockers: string[] = [];
    // A missing hardware ID can't prove the rows are one home, so it refuses too.
    if (!primary.hardware || primary.hardware !== secondary.hardware) blockers.push('hardware-differs');
    if (primary.timezone !== secondary.timezone) blockers.push('timezones-differ');

    const count = async (sql: string, params: unknown[]) => Number((await db.query(sql, params)).rows[0].n);
    if (await count(`SELECT count(*) AS n FROM "EnergyDayArchive" WHERE site_id = $1`, [secondaryId])) blockers.push('secondary-has-archived-days');
    if (await count(`SELECT count(*) AS n FROM "EnergyDaySummary" WHERE site_id = $1`, [secondaryId])) blockers.push('secondary-has-summaries');
    if (await count(`SELECT count(*) AS n FROM "TrmnlInstallation" WHERE site_id = $1`, [secondaryId])) blockers.push('secondary-has-trmnl-installations');
    if (await count(`SELECT count(*) AS n FROM "LoadTag" WHERE site_id = $1`, [secondaryId])) blockers.push('secondary-has-tags');
    if (await count(`SELECT count(*) AS n FROM "BatteryHold" WHERE site_id = ANY($1) AND status = 'active'`, [[primaryId, secondaryId]])) blockers.push('active-hold');
    if (primary.hardware && await count(`SELECT count(*) AS n FROM "BatteryHoldStartClaim"
        WHERE claim_key = $1 AND expires_at > clock_timestamp()`, [primary.hardware])) blockers.push('start-claim-held');

    const moving = await db.query<{ user_id: string; tesla_energy_site_id: string; on_primary: boolean }>(
        `SELECT m.user_id, m.tesla_energy_site_id,
            EXISTS (SELECT 1 FROM "SiteMember" p WHERE p.site_id = $1 AND p.user_id = m.user_id) AS on_primary
         FROM "SiteMember" m WHERE m.site_id = $2 ORDER BY m.user_id`, [primaryId, secondaryId]);
    if (moving.rows.some(r => r.on_primary)) blockers.push('member-already-on-primary');

    return {
        applied: false,
        blockers,
        movedMembers: moving.rows.map(r => ({ userId: r.user_id, teslaEnergySiteId: r.tesla_energy_site_id })),
    };
}

export async function mergeEmptyDuplicateSite(options: MergeEmptyDuplicateOptions): Promise<MergeEmptyDuplicateResult> {
    const { primaryId, secondaryId, apply } = options;
    const preview = await evaluate(pool, primaryId, secondaryId, false);
    if (!apply || preview.blockers.length > 0) return preview;

    // A Battery Saver start sends its command before creating its hold, so without the claim a start
    // in progress could be using the row we are about to delete.
    const holds = new BatteryHoldRepo();
    const claimKey = await holds.getStartClaimKey(primaryId);
    const owner = randomUUID();
    if (!(await holds.claimStart(claimKey, owner))) {
        return { applied: false, blockers: ['start-claim-held'], movedMembers: preview.movedMembers };
    }
    try {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            // Recheck under row locks and the claim: crons may have added days since the preview.
            const checked = await evaluate(client, primaryId, secondaryId, true);
            // Our own claim shows up as held, so it isn't a blocker here.
            const blockers = checked.blockers.filter(b => b !== 'start-claim-held');
            if (blockers.length > 0) {
                await client.query('ROLLBACK');
                return { applied: false, blockers, movedMembers: checked.movedMembers };
            }
            // The composite connection key points at the member row being moved.
            await client.query(`UPDATE "Site" SET tesla_connection_user_id = NULL WHERE id = $1`, [secondaryId]);
            await client.query(`UPDATE "SiteMember" SET site_id = $1 WHERE site_id = $2`, [primaryId, secondaryId]);
            await client.query(`DELETE FROM "Site" WHERE id = $1`, [secondaryId]);
            await client.query('COMMIT');
            return { applied: true, blockers: [], movedMembers: checked.movedMembers };
        } catch (error) {
            await client.query('ROLLBACK').catch(() => undefined);
            throw error;
        } finally {
            client.release();
        }
    } finally {
        await holds.releaseStart(claimKey, owner);
    }
}
