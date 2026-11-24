import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { pool } from './db';
import { siteMembershipEnabled } from './site-membership-flag';

export const BILLING_READ_SCOPE = 'billing:read';
type IntegrationScope = typeof BILLING_READ_SCOPE;

export interface IntegrationCredential {
    id: string;
    name: string;
}

interface IntegrationAuthorization {
    id: string;
    siteId: string;
    allowed: boolean;
}

function tokenDigest(token: string): Buffer {
    return createHash('sha256').update(token).digest();
}

export async function authorizeIntegration(
    authorization: string | null, scope: IntegrationScope,
): Promise<IntegrationAuthorization | null> {
    const token = /^Bearer +(pwu_int_[A-Za-z0-9_-]{43})$/i.exec(authorization ?? '')?.[1];
    if (!token) return null;

    const siteAccess = siteMembershipEnabled()
        ? 'EXISTS (SELECT 1 FROM "SiteMember" m WHERE m.site_id = c.site_id AND m.user_id = c.user_id)'
        : 'EXISTS (SELECT 1 FROM "Site" s WHERE s.id = c.site_id AND s.user_id = c.user_id)';
    const { rows } = await pool.query<IntegrationAuthorization>(`
        SELECT c.id, c.site_id AS "siteId", EXISTS (
            SELECT 1 FROM "IntegrationGrant" g WHERE g.credential_id = c.id AND g.scope = $2
        ) AS allowed
        FROM "IntegrationCredential" c
        JOIN "User" u ON u.id = c.user_id
        WHERE c.token_hash = $1 AND u.is_active AND ${siteAccess}
    `, [tokenDigest(token), scope]);
    return rows[0] ?? null;
}

export async function listIntegrationCredentials(userId: string, siteId: string, scope: IntegrationScope) {
    const { rows } = await pool.query<IntegrationCredential>(`
        SELECT c.id, c.name
        FROM "IntegrationCredential" c
        JOIN "IntegrationGrant" g ON g.credential_id = c.id AND g.scope = $3
        WHERE c.user_id = $1 AND c.site_id = $2
        ORDER BY c.created_at DESC, c.id
    `, [userId, siteId, scope]);
    return rows;
}

export async function createIntegrationCredential(userId: string, siteId: string, name: string, scope: IntegrationScope) {
    const token = `pwu_int_${randomBytes(32).toString('base64url')}`;
    const { rows } = await pool.query<IntegrationCredential>(`
        WITH credential AS (
            INSERT INTO "IntegrationCredential" (id, user_id, site_id, name, token_hash)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id, name
        ), grant_scope AS (
            INSERT INTO "IntegrationGrant" (credential_id, scope)
            SELECT id, $6 FROM credential
            RETURNING credential_id
        )
        SELECT c.id, c.name FROM credential c JOIN grant_scope g ON g.credential_id = c.id
    `, [randomUUID(), userId, siteId, name, tokenDigest(token), scope]);
    return { credential: rows[0], token };
}

export async function revokeIntegrationCredential(userId: string, siteId: string, id: string, scope: IntegrationScope) {
    const { rowCount } = await pool.query(`
        DELETE FROM "IntegrationCredential" c USING "IntegrationGrant" g
        WHERE c.user_id = $1 AND c.site_id = $2 AND c.id = $3
            AND g.credential_id = c.id AND g.scope = $4
    `, [userId, siteId, id, scope]);
    return rowCount === 1;
}
