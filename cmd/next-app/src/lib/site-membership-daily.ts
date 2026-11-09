import { createHash } from 'node:crypto';
import { pool } from './db';
import { Importer } from './importer';
import { logEvent } from './observability';
import { siteMembershipEnabled } from './site-membership-flag';
import { SiteMembershipService } from './site-membership-service';
import { createTeslaClientForUser } from './tesla-client-factory';

/** Check each account's own Tesla list, independently of import's last_checked_at. */
export async function reconcileDueMemberships(deadlineMs: number): Promise<{ checked: number; failed: number }> {
    if (!siteMembershipEnabled()) return { checked: 0, failed: 0 };
    const { rows } = await pool.query<{ id: string }>(`
        SELECT id FROM "User"
        WHERE is_active = true
          AND (memberships_checked_at IS NULL OR memberships_checked_at < now() - interval '24 hours')
        ORDER BY memberships_checked_at NULLS FIRST, id LIMIT 50`);
    let checked = 0;
    let failed = 0;
    for (const row of rows) {
        if (Date.now() >= deadlineMs - 5_000) break;
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
    return { checked, failed };
}
