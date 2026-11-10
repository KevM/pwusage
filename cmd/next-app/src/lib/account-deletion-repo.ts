import { pool } from './db';

/**
 * A Battery Saver session (or in-flight start claim) is active on a site that has no
 * other usable member, so deleting now would strand the Powerwall at a raised reserve.
 */
export class ActiveBatterySaverError extends Error {
    constructor() {
        super('Battery Saver is active on a site with no other usable member');
        this.name = 'ActiveBatterySaverError';
    }
}

export interface SiteDeletionOverview {
    id: string;
    name: string;
    shared: boolean;
    hasOtherUsableMember: boolean;
    activeHoldOriginalReserve: number | null;
}

export interface AccountDeletionCommitResult {
    deletedSiteIds: string[];
    survivingSiteIds: string[];
}

const OTHER_USABLE_MEMBER_EXISTS = `
    EXISTS (
        SELECT 1 FROM "SiteMember" m
        JOIN "User" u ON u.id = m.user_id
        WHERE m.site_id = s.id AND m.user_id <> $1
          AND u.is_active = true AND NULLIF(u.refresh_token, '') IS NOT NULL
          AND u.auth_status IS DISTINCT FROM 'revoked'
          AND u.tesla_refresh_state IS DISTINCT FROM 'uncertain'
          AND u.tesla_refresh_state IS DISTINCT FROM 'reconnect_required'
    )`;

export class AccountDeletionRepo {
    /**
     * Lists the sites the user belongs to, whether another member shares each site,
     * whether another usable member could restore Battery Saver, and the active
     * Battery Saver original reserve if any.
     */
    async getSitesForDeletion(userId: string): Promise<SiteDeletionOverview[]> {
        const { rows } = await pool.query<{
            id: string;
            name: string;
            shared: boolean;
            has_other_usable_member: boolean;
            original_reserve: number | null;
        }>(`
            SELECT s.id, s.name,
                EXISTS (SELECT 1 FROM "SiteMember" m WHERE m.site_id = s.id AND m.user_id <> $1) AS shared,
                ${OTHER_USABLE_MEMBER_EXISTS} AS has_other_usable_member,
                h.original_reserve
            FROM "Site" s
            LEFT JOIN LATERAL (
                SELECT original_reserve FROM "BatteryHold"
                WHERE site_id = s.id AND status = 'active'
                ORDER BY created_at DESC LIMIT 1
            ) h ON true
            WHERE s.id IN (
                SELECT site_id FROM "SiteMember" WHERE user_id = $1
                UNION
                SELECT id FROM "Site" WHERE user_id = $1
            )
            ORDER BY s.id
        `, [userId]);

        return rows.map(row => ({
            id: row.id,
            name: row.name,
            shared: row.shared,
            hasOtherUsableMember: row.has_other_usable_member,
            activeHoldOriginalReserve: row.original_reserve === null ? null : Number(row.original_reserve),
        }));
    }

    /**
     * Removes the account, its memberships, its TRMNL installations, and any site
     * where this user was the last member.
     *
     * Locking User and Site rows in deterministic id order serializes concurrent
     * member deletions and blocks new holds or memberships until commit.
     */
    async deleteAccount(userId: string): Promise<AccountDeletionCommitResult> {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const userRes = await client.query('SELECT id FROM "User" WHERE id = $1 FOR UPDATE', [userId]);
            if (userRes.rowCount === 0) {
                await client.query('COMMIT');
                return { deletedSiteIds: [], survivingSiteIds: [] };
            }

            const sites = await client.query<{
                id: string;
                claim_key: string;
                has_other_member: boolean;
                has_other_usable_member: boolean;
            }>(`
                SELECT s.id,
                    COALESCE(s.tesla_hardware_id, 'site:' || s.id) AS claim_key,
                    EXISTS (SELECT 1 FROM "SiteMember" m WHERE m.site_id = s.id AND m.user_id <> $1) AS has_other_member,
                    ${OTHER_USABLE_MEMBER_EXISTS} AS has_other_usable_member
                FROM "Site" s
                WHERE s.id IN (
                    SELECT site_id FROM "SiteMember" WHERE user_id = $1
                    UNION
                    SELECT id FROM "Site" WHERE user_id = $1
                )
                ORDER BY s.id
                FOR UPDATE
            `, [userId]);

            const allSiteIds = sites.rows.map(row => row.id);
            const sitesNeedingRestore = sites.rows.filter(row => !row.has_other_usable_member).map(row => row.id);
            const soleSiteClaimKeys = sites.rows.filter(row => !row.has_other_member).map(row => row.claim_key);

            if (sitesNeedingRestore.length > 0) {
                const activeHolds = await client.query(
                    `SELECT 1 FROM "BatteryHold" WHERE site_id = ANY($1::text[]) AND status = 'active' LIMIT 1`,
                    [sitesNeedingRestore],
                );
                if (activeHolds.rows.length > 0) throw new ActiveBatterySaverError();
            }

            if (soleSiteClaimKeys.length > 0) {
                const activeClaims = await client.query(
                    `SELECT 1 FROM "BatteryHoldStartClaim" WHERE claim_key = ANY($1::text[]) AND expires_at > clock_timestamp() LIMIT 1`,
                    [soleSiteClaimKeys],
                );
                if (activeClaims.rows.length > 0) throw new ActiveBatterySaverError();
            }

            await client.query('DELETE FROM "MobileLoginHandoff" WHERE user_id = $1', [userId]);
            if (allSiteIds.length > 0) {
                await client.query(
                    'DELETE FROM "TrmnlInstallation" WHERE installed_by_user_id = $1 AND site_id = ANY($2::text[])',
                    [userId, allSiteIds],
                );
            }
            await client.query('DELETE FROM "SiteMember" WHERE user_id = $1', [userId]);

            const goneRes = await client.query<{ id: string }>(`
                SELECT s.id FROM "Site" s
                WHERE s.id = ANY($1::text[])
                  AND NOT EXISTS (SELECT 1 FROM "SiteMember" m WHERE m.site_id = s.id)
                ORDER BY s.id
            `, [allSiteIds]);
            const deletedSiteIds = goneRes.rows.map(row => row.id);
            const deletedSet = new Set(deletedSiteIds);
            const survivingSiteIds = allSiteIds.filter(id => !deletedSet.has(id));

            if (deletedSiteIds.length > 0) {
                // EnergyDaySummary has NO ACTION keys to Tariff and TariffSchedule. Removing
                // archives first removes the summaries, so the Site cascade cannot fail on
                // them whichever order its triggers fire in.
                await client.query('DELETE FROM "EnergyDayArchive" WHERE site_id = ANY($1::text[])', [deletedSiteIds]);
                await client.query('DELETE FROM "Site" WHERE id = ANY($1::text[])', [deletedSiteIds]);
            }

            await client.query('DELETE FROM "User" WHERE id = $1', [userId]);
            await client.query('COMMIT');
            return { deletedSiteIds, survivingSiteIds };
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }
}
