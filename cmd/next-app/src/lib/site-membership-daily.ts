import { createHash } from 'node:crypto';
import { pool } from './db';
import { Importer } from './importer';
import { logEvent } from './observability';
import { siteMembershipEnabled } from './site-membership-flag';
import { SiteMembershipService } from './site-membership-service';
import { createTeslaClientForUser } from './tesla-client-factory';
import { SiteRepo } from './site-repo';

/** Check each account's own Tesla list, independently of import's last_checked_at. */
export async function reconcileDueMemberships(deadlineMs: number): Promise<{ checked: number; failed: number; deadRemoved: number }> {
    if (!siteMembershipEnabled()) return { checked: 0, failed: 0, deadRemoved: 0 };
    const { rows } = await pool.query<{ id: string }>(`
        SELECT id FROM "User"
        WHERE is_active = true
          AND NULLIF(refresh_token, '') IS NOT NULL
          AND auth_status IS DISTINCT FROM 'revoked'
          AND tesla_refresh_state IS DISTINCT FROM 'uncertain'
          AND tesla_refresh_state IS DISTINCT FROM 'reconnect_required'
          AND (memberships_checked_at IS NULL OR memberships_checked_at < now() - interval '24 hours')
        ORDER BY memberships_attempted_at NULLS FIRST, memberships_checked_at NULLS FIRST, id LIMIT 50`);
    let checked = 0;
    let failed = 0;
    let deadRemoved = 0;
    for (const row of rows) {
        if (Date.now() >= deadlineMs - 5_000) break;
        // Stamp every attempt, so accounts that keep failing rotate behind the rest of the queue.
        await pool.query('UPDATE "User" SET memberships_attempted_at = now() WHERE id = $1', [row.id]);
        try {
            const client = await createTeslaClientForUser(row.id);
            if (!client) continue;
            const fetchedAt = new Date();
            const products = await client.getProducts();
            await new SiteMembershipService(client, new Importer(client)).syncLogin(row.id, products, fetchedAt);
            checked++;
        } catch (error) {
            failed++;
            logEvent('warn', 'site.member.reconcile-failed', {
                accountId: createHash('sha256').update(row.id).digest('hex').slice(0, 16), error,
            });
        }
    }
    if (Date.now() < deadlineMs - 5_000) {
        const stale = await pool.query<{ site_id: string; user_id: string; tesla_energy_site_id: string }>(`
            SELECT m.site_id, m.user_id, m.tesla_energy_site_id
            FROM "SiteMember" m JOIN "User" u ON u.id = m.user_id
            WHERE m.last_seen_in_tesla_at < now() - interval '14 days'
              AND u.auth_lost_at < now() - interval '14 days'
              AND (u.is_active IS NOT TRUE OR NULLIF(u.refresh_token, '') IS NULL
                   OR u.auth_status = 'revoked'
                   OR u.tesla_refresh_state IN ('uncertain', 'reconnect_required'))
            ORDER BY m.last_seen_in_tesla_at LIMIT 50`);
        const sites = new SiteRepo();
        for (const member of stale.rows) {
            if (Date.now() >= deadlineMs - 5_000) break;
            try {
                if (await sites.removeDeadMember(member.site_id, member.user_id, member.tesla_energy_site_id)) deadRemoved++;
            } catch (error) {
                failed++;
                logEvent('warn', 'site.member.dead-cleanup-failed', {
                    siteId: member.site_id,
                    accountId: createHash('sha256').update(member.user_id).digest('hex').slice(0, 16), error,
                });
            }
        }
    }
    return { checked, failed, deadRemoved };
}
