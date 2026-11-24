import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { pool } from './db';
import { siteMembershipEnabled } from './site-membership-flag';

export interface BillingIntegrationCredential {
    id: string;
    name: string;
}

function tokenDigest(token: string): Buffer {
    return createHash('sha256').update(token).digest();
}

export async function authenticateBillingIntegration(authorization: string | null): Promise<{ id: string; siteId: string } | null> {
    const token = /^Bearer +(pwu_bill_[A-Za-z0-9_-]{43})$/i.exec(authorization ?? '')?.[1];
    if (!token) return null;

    const siteAccess = siteMembershipEnabled()
        ? 'EXISTS (SELECT 1 FROM "SiteMember" m WHERE m.site_id = c.site_id AND m.user_id = c.user_id)'
        : 'EXISTS (SELECT 1 FROM "Site" s WHERE s.id = c.site_id AND s.user_id = c.user_id)';
    const { rows } = await pool.query<{ id: string; siteId: string }>(`
        SELECT c.id, c.site_id AS "siteId"
        FROM "BillingIntegrationCredential" c
        JOIN "User" u ON u.id = c.user_id
        WHERE c.token_hash = $1 AND u.is_active AND ${siteAccess}
    `, [tokenDigest(token)]);
    return rows[0] ?? null;
}

export async function listBillingIntegrationCredentials(userId: string, siteId: string) {
    const { rows } = await pool.query<BillingIntegrationCredential>(`
        SELECT id, name
        FROM "BillingIntegrationCredential"
        WHERE user_id = $1 AND site_id = $2
        ORDER BY created_at DESC, id
    `, [userId, siteId]);
    return rows;
}

export async function createBillingIntegrationCredential(userId: string, siteId: string, name: string) {
    const token = `pwu_bill_${randomBytes(32).toString('base64url')}`;
    const { rows } = await pool.query<BillingIntegrationCredential>(`
        INSERT INTO "BillingIntegrationCredential" (id, user_id, site_id, name, token_hash)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, name
    `, [randomUUID(), userId, siteId, name, tokenDigest(token)]);
    return { credential: rows[0], token };
}

export async function revokeBillingIntegrationCredential(userId: string, siteId: string, id: string): Promise<boolean> {
    const { rowCount } = await pool.query(`
        DELETE FROM "BillingIntegrationCredential" WHERE user_id = $1 AND site_id = $2 AND id = $3
    `, [userId, siteId, id]);
    return rowCount === 1;
}
