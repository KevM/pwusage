import { createHash } from 'node:crypto';
import { pool } from './db';
import { logEvent } from './observability';
import type { EnergySiteInfo } from './tesla-client';

export interface HardwareMember {
    site_id: string;
    user_id: string;
    tesla_energy_site_id: string;
    is_active: boolean;
    refresh_token: string | null;
    auth_status: string | null;
    tesla_refresh_state: string | null;
}

export type MembershipDecision =
    | { kind: 'mapped' | 'reinvite' | 'joined' | 'fresh'; siteId: string }
    | { kind: 'retry' };

const memberKey = (member: HardwareMember) => `${member.site_id}\0${member.user_id}\0${member.tesla_energy_site_id}`;

export class SiteMembershipJoinRepo {
    async membersForHardware(hardwareId: string): Promise<HardwareMember[]> {
        const { rows } = await pool.query<HardwareMember>(`
            SELECT m.site_id, m.user_id, m.tesla_energy_site_id,
                   u.is_active, u.refresh_token, u.auth_status, u.tesla_refresh_state
            FROM "Site" s JOIN "SiteMember" m ON m.site_id = s.id
            JOIN "User" u ON u.id = m.user_id
            WHERE s.tesla_hardware_id = $1
            ORDER BY m.last_seen_in_tesla_at DESC, m.joined_at, m.user_id
        `, [hardwareId]);
        return rows;
    }

    async membersForUser(userId: string): Promise<{ site_id: string; tesla_energy_site_id: string }[]> {
        const { rows } = await pool.query<{ site_id: string; tesla_energy_site_id: string }>(
            'SELECT site_id, tesla_energy_site_id FROM "SiteMember" WHERE user_id = $1', [userId]);
        return rows;
    }

    async markChecked(userId: string, fetchedAt: Date): Promise<void> {
        await pool.query(`UPDATE "User" SET memberships_checked_at = GREATEST(
            COALESCE(memberships_checked_at, '-infinity'::timestamptz), $2::timestamptz)
            WHERE id = $1`, [userId, fetchedAt]);
    }

    /** All Tesla calls precede this transaction. The hardware lock serializes writes, while
     * the snapshot comparison invalidates a join decision made before another login committed. */
    async commitDecision(params: {
        userId: string; teslaId: string; info: EnergySiteInfo; hardwareId: string | null;
        observedMembers: HardwareMember[]; verifiedSiteId: string | null; fetchedAt: Date;
    }): Promise<MembershipDecision> {
        const { userId, teslaId, info, hardwareId, observedMembers, verifiedSiteId, fetchedAt } = params;
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [hardwareId ?? `site:${teslaId}`]);
            const mapped = await client.query<{ site_id: string }>(`
                SELECT site_id FROM "SiteMember" WHERE user_id = $1 AND tesla_energy_site_id = $2`, [userId, teslaId]);
            if (mapped.rows[0]) {
                await client.query(`UPDATE "SiteMember" SET last_seen_in_tesla_at = GREATEST(last_seen_in_tesla_at, $3)
                    WHERE site_id = $1 AND user_id = $2`, [mapped.rows[0].site_id, userId, fetchedAt]);
                await client.query('COMMIT');
                return { kind: 'mapped', siteId: mapped.rows[0].site_id };
            }

            if (hardwareId) {
                const own = await client.query<{ site_id: string }>(`
                    SELECT m.site_id FROM "SiteMember" m JOIN "Site" s ON s.id = m.site_id
                    WHERE m.user_id = $1 AND s.tesla_hardware_id = $2 ORDER BY m.joined_at LIMIT 1`,
                [userId, hardwareId]);
                if (own.rows[0]) {
                    // An older product list must not put back an ID that a newer re-invite replaced:
                    // GREATEST would keep the newer timestamp but not its mapping.
                    await client.query(`UPDATE "SiteMember" SET
                        tesla_energy_site_id = CASE WHEN last_seen_in_tesla_at <= $4 THEN $3 ELSE tesla_energy_site_id END,
                        last_seen_in_tesla_at = GREATEST(last_seen_in_tesla_at, $4)
                        WHERE site_id = $1 AND user_id = $2`, [own.rows[0].site_id, userId, teslaId, fetchedAt]);
                    await client.query('COMMIT');
                    return { kind: 'reinvite', siteId: own.rows[0].site_id };
                }
                const current = await client.query<HardwareMember>(`
                    SELECT m.site_id, m.user_id, m.tesla_energy_site_id,
                           u.is_active, u.refresh_token, u.auth_status, u.tesla_refresh_state
                    FROM "Site" s JOIN "SiteMember" m ON m.site_id = s.id
                    JOIN "User" u ON u.id = m.user_id WHERE s.tesla_hardware_id = $1`, [hardwareId]);
                const before = observedMembers.map(memberKey).sort();
                const after = current.rows.map(memberKey).sort();
                if (JSON.stringify(before) !== JSON.stringify(after)) {
                    await client.query('ROLLBACK');
                    return { kind: 'retry' };
                }
            }

            if (verifiedSiteId) {
                const present = observedMembers.some(member => member.site_id === verifiedSiteId);
                if (!present) throw new Error('Verified member disappeared before join');
                await client.query(`INSERT INTO "SiteMember"
                    (site_id, user_id, tesla_energy_site_id, last_seen_in_tesla_at)
                    VALUES ($1, $2, $3, $4)`, [verifiedSiteId, userId, teslaId, fetchedAt]);
                await client.query('UPDATE "Site" SET orphaned_at = NULL WHERE id = $1', [verifiedSiteId]);
                await client.query('COMMIT');
                logEvent('info', 'site.member.joined', { siteId: verifiedSiteId,
                    accountId: createHash('sha256').update(userId).digest('hex').slice(0, 16) });
                return { kind: 'joined', siteId: verifiedSiteId };
            }

            // Removing a site's last member keeps the Site row. When that Tesla ID comes back there is
            // no membership to match, so reattach the retained row instead of colliding on its key.
            const retained = await client.query<{ tesla_hardware_id: string | null }>(
                'SELECT tesla_hardware_id FROM "Site" WHERE id = $1 FOR UPDATE', [teslaId]);
            if (retained.rows[0]) {
                const known = retained.rows[0].tesla_hardware_id;
                if (known && hardwareId && known !== hardwareId) {
                    throw new Error('Retained site belongs to a different Powerwall');
                }
                const members = await client.query('SELECT 1 FROM "SiteMember" WHERE site_id = $1 LIMIT 1', [teslaId]);
                if (members.rowCount) {
                    await client.query('ROLLBACK');
                    return { kind: 'retry' };
                }
                await client.query(`INSERT INTO "SiteMember"
                    (site_id, user_id, tesla_energy_site_id, last_seen_in_tesla_at)
                    VALUES ($1, $2, $1, $3)`, [teslaId, userId, fetchedAt]);
                await client.query(`UPDATE "Site" SET user_id = $2, tesla_connection_user_id = $2,
                    tesla_hardware_id = COALESCE(tesla_hardware_id, $3),
                    orphaned_at = NULL WHERE id = $1`, [teslaId, userId, hardwareId]);
                await client.query('COMMIT');
                logEvent('info', 'site.member.rejoined-retained', { siteId: teslaId,
                    accountId: createHash('sha256').update(userId).digest('hex').slice(0, 16) });
                return { kind: 'joined', siteId: teslaId };
            }

            const inserted = await client.query(`INSERT INTO "Site"
                (id, name, installed, timezone, json, tesla_hardware_id)
                VALUES ($1, $2, $3, $4, '{}'::jsonb, $5) ON CONFLICT (id) DO NOTHING`,
            [teslaId, info.site_name || 'Unnamed Site', info.installation_date || new Date(),
                info.installation_time_zone || 'UTC', hardwareId]);
            if (inserted.rowCount !== 1) {
                await client.query('ROLLBACK');
                return { kind: 'retry' };
            }
            await client.query(`INSERT INTO "SiteMember"
                (site_id, user_id, tesla_energy_site_id, last_seen_in_tesla_at)
                VALUES ($1, $2, $1, $3)`, [teslaId, userId, fetchedAt]);
            await client.query(`UPDATE "Site" SET user_id = $2, tesla_connection_user_id = $2 WHERE id = $1`,
                [teslaId, userId]);
            if (hardwareId) {
                // A transferred Powerwall must never reattach to the previous owner's memberless row.
                await client.query(`UPDATE "Site" s
                    SET tesla_hardware_id = NULL,
                        orphaned_at = COALESCE(s.orphaned_at, now())
                    WHERE s.tesla_hardware_id = $1
                      AND s.id <> $2
                      AND NOT EXISTS (SELECT 1 FROM "SiteMember" m WHERE m.site_id = s.id)`,
                [hardwareId, teslaId]);
            }
            await client.query('COMMIT');
            return { kind: 'fresh', siteId: teslaId };
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }
}
