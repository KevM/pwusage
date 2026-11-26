import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool } from '../db';
import { siteMembershipEnabled } from '../site-membership-flag';
import {
    ACCESS_TOKEN_PREFIX,
    INTEGRATION_CLIENT_ID,
    INTEGRATION_RESOURCE,
    INTEGRATION_TOKEN_PREFIX,
    ACCESS_TOKEN_TTL_SECONDS,
    AUTH_CODE_TTL_SECONDS,
    DCR_CLIENT_ID_PREFIX,
    GRANT_MAX_TTL_SECONDS,
    REFRESH_TOKEN_PREFIX,
    REFRESH_TOKEN_TTL_SECONDS,
    type GrantKind,
    type OAuthAccessContext,
    type OAuthClientMetadata,
    type OAuthScope,
} from './types';
import { verifyPkceS256 } from './validation';

export interface CreateAuthCodeInput {
    clientId: string;
    clientName: string;
    clientUri: string | null;
    userId: string;
    redirectUri: string;
    codeChallenge: string;
    resource: string;
    scopes: OAuthScope[];
    siteIds: string[];
    /** The session_version the approving session was validated at. */
    sessionVersion: number;
}

export type TokenExchangeResult =
    | {
          ok: true;
          accessToken: string;
          refreshToken: string;
          expiresIn: number;
          scope: string;
          grantId: string;
          clientId: string;
      }
    | {
          ok: false;
          error: 'invalid_grant' | 'invalid_request';
          errorDescription: string;
      };

export interface UserOAuthGrantSummary {
    id: string;
    kind: GrantKind;
    clientId: string;
    clientName: string;
    clientUri: string | null;
    scopes: OAuthScope[];
    createdAt: string;
    lastUsedAt: string | null;
    /** Null when the grant never expires on its own (integration tokens). */
    maxExpiresAt: string | null;
    siteCount: number;
    /** Host serving the app's CIMD document; null for a self-registered (DCR) app, whose name is unverified. */
    publisherHost: string | null;
}

export interface OAuthCleanupCounts {
    deletedClients: number;
    deletedAuthCodes: number;
    deletedTokens: number;
    deletedGrants: number;
}

interface AuthCodeRow {
    client_id: string;
    client_name: string;
    client_uri: string | null;
    user_id: string;
    redirect_uri: string;
    code_challenge: string;
    resource: string;
    scopes: OAuthScope[];
    site_ids: string[];
    session_version: number;
}

interface GrantRow {
    id: string;
    user_id: string;
    client_id: string;
    resource: string;
    scopes: OAuthScope[];
    max_expires_at: Date;
    revoked_at: Date | null;
    session_version: number;
}

/** Unused self-registrations allowed per day (16 KB bodies: at most ~8 MB of rows). */
const MAX_PENDING_DCR_CLIENTS = 500;

function cimdHost(clientId: string): string | null {
    if (!clientId.startsWith('https://')) return null;
    try {
        return new URL(clientId).hostname || null;
    } catch {
        return null;
    }
}

function sha256Buffer(value: string): Buffer {
    return createHash('sha256').update(value).digest();
}

function generateOpaqueToken(prefix = ''): string {
    return `${prefix}${randomBytes(32).toString('base64url')}`;
}

async function revokeGrantAndTokens(client: PoolClient, grantId: string): Promise<void> {
    await client.query(
        `UPDATE "OAuthGrant" SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1`,
        [grantId],
    );
    await client.query(
        `UPDATE "OAuthToken" SET revoked_at = COALESCE(revoked_at, now()) WHERE grant_id = $1`,
        [grantId],
    );
}

async function issueTokenPair(
    client: PoolClient,
    grantId: string,
    maxExpiresAt: Date,
): Promise<{ accessToken: string; refreshToken: string }> {
    const accessToken = generateOpaqueToken(ACCESS_TOKEN_PREFIX);
    const refreshToken = generateOpaqueToken(REFRESH_TOKEN_PREFIX);
    const nowMs = Date.now();
    const accessExpiresAt = new Date(nowMs + ACCESS_TOKEN_TTL_SECONDS * 1000);
    const refreshExpiresAt = new Date(
        Math.min(nowMs + REFRESH_TOKEN_TTL_SECONDS * 1000, maxExpiresAt.getTime()),
    );

    await client.query(
        `INSERT INTO "OAuthToken" (token_hash, grant_id, kind, expires_at)
         VALUES ($1, $2, 'access', $3)`,
        [sha256Buffer(accessToken), grantId, accessExpiresAt],
    );
    await client.query(
        `INSERT INTO "OAuthToken" (token_hash, grant_id, kind, expires_at)
         VALUES ($1, $2, 'refresh', $3)`,
        [sha256Buffer(refreshToken), grantId, refreshExpiresAt],
    );

    return { accessToken, refreshToken };
}

export async function registerDcrClient(input: {
    clientName: string;
    redirectUris: string[];
    clientUri: string | null;
}): Promise<OAuthClientMetadata | null> {
    const clientId = `${DCR_CLIENT_ID_PREFIX}${randomUUID()}`;
    // Registration is unauthenticated: cap registrations nobody has used yet so
    // abandoned ones (cleaned up daily) cannot eat the shared database quota.
    const res = await pool.query(
        `INSERT INTO "OAuthClient" (client_id, client_name, redirect_uris, client_uri)
         SELECT $1, $2, $3::text[], $4
         WHERE (
             SELECT count(*) FROM "OAuthClient"
             WHERE last_used_at IS NULL AND created_at > now() - interval '24 hours'
         ) < $5`,
        [clientId, input.clientName, input.redirectUris, input.clientUri, MAX_PENDING_DCR_CLIENTS],
    );
    if (res.rowCount !== 1) return null;
    return {
        clientId,
        clientName: input.clientName,
        redirectUris: input.redirectUris,
        clientUri: input.clientUri,
        kind: 'dcr',
    };
}

export async function getDcrClient(clientId: string): Promise<OAuthClientMetadata | null> {
    if (!clientId.startsWith(DCR_CLIENT_ID_PREFIX)) return null;
    const res = await pool.query<{
        client_id: string;
        client_name: string;
        redirect_uris: string[];
        client_uri: string | null;
    }>(
        `SELECT client_id, client_name, redirect_uris, client_uri
         FROM "OAuthClient"
         WHERE client_id = $1`,
        [clientId],
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
        clientId: row.client_id,
        clientName: row.client_name,
        redirectUris: row.redirect_uris,
        clientUri: row.client_uri,
        kind: 'dcr',
    };
}

export async function createAuthCode(
    input: CreateAuthCodeInput,
): Promise<{ code: string; expiresAt: Date } | null> {
    const code = generateOpaqueToken();
    const expiresAt = new Date(Date.now() + AUTH_CODE_TTL_SECONDS * 1000);
    // Stamp the approving session's session_version and insert only while it is
    // still the user's (and the user is active), in one statement: a "Sign out
    // everywhere" that lands after the decision's session check refuses the code
    // instead of it inheriting the new version.
    const res = await pool.query(
        `INSERT INTO "OAuthAuthCode" (
            code_hash, client_id, client_name, client_uri, user_id,
            redirect_uri, code_challenge, resource, scopes, site_ids, expires_at, session_version
         )
         SELECT $1::bytea, $2, $3, $4, u.id, $6, $7, $8, $9::text[], $10::text[], $11::timestamptz, u.session_version
         FROM "User" u
         WHERE u.id = $5 AND u.is_active = true AND u.session_version = $12`,
        [
            sha256Buffer(code),
            input.clientId,
            input.clientName,
            input.clientUri,
            input.userId,
            input.redirectUri,
            input.codeChallenge,
            input.resource,
            input.scopes,
            input.siteIds,
            expiresAt,
            input.sessionVersion,
        ],
    );
    // Null: the user is inactive or missing, or the approving session was signed out everywhere.
    if (res.rowCount !== 1) return null;
    return { code, expiresAt };
}

export async function exchangeAuthCode(input: {
    code: string;
    clientId: string;
    redirectUri: string;
    codeVerifier: string;
    resource: string;
}): Promise<TokenExchangeResult> {
    if (!input.code) {
        return { ok: false, error: 'invalid_grant', errorDescription: 'Authorization code is invalid or expired' };
    }
    const codeHash = sha256Buffer(input.code);
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const consumeRes = await client.query<AuthCodeRow>(
            // Redeemable only while the user is active and has not signed out
            // everywhere since consent (session_version unchanged).
            `UPDATE "OAuthAuthCode" c
             SET consumed_at = now()
             FROM "User" u
             WHERE c.code_hash = $1
               AND c.consumed_at IS NULL
               AND c.expires_at > now()
               AND u.id = c.user_id
               AND u.is_active = true
               AND u.session_version = c.session_version
             RETURNING c.client_id, c.client_name, c.client_uri, c.user_id, c.redirect_uri,
                       c.code_challenge, c.resource, c.scopes, c.site_ids, c.session_version`,
            [codeHash],
        );

        const row = consumeRes.rows[0];
        if (!row) {
            const existing = await client.query<{ consumed_at: Date | null; grant_id: string | null }>(
                `SELECT consumed_at, grant_id FROM "OAuthAuthCode" WHERE code_hash = $1`,
                [codeHash],
            );
            const prev = existing.rows[0];
            if (prev?.consumed_at && prev.grant_id) {
                await revokeGrantAndTokens(client, prev.grant_id);
                await client.query('COMMIT');
            } else {
                await client.query('ROLLBACK');
            }
            return { ok: false, error: 'invalid_grant', errorDescription: 'Authorization code is invalid or expired' };
        }

        const bindingValid =
            row.client_id === input.clientId
            && row.redirect_uri === input.redirectUri
            && row.resource === input.resource
            && verifyPkceS256(input.codeVerifier, row.code_challenge);

        if (!bindingValid) {
            await client.query('COMMIT');
            return { ok: false, error: 'invalid_grant', errorDescription: 'Authorization code verification failed' };
        }

        const grantId = randomUUID();
        const maxExpiresAt = new Date(Date.now() + GRANT_MAX_TTL_SECONDS * 1000);

        await client.query(
            // Stamped with the consent's session_version: if a sign-out everywhere
            // races this exchange and misses the uncommitted grant, its tokens
            // still fail the version check on every use.
            `INSERT INTO "OAuthGrant" (id, user_id, client_id, client_name, client_uri, resource, scopes, max_expires_at, session_version)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [grantId, row.user_id, row.client_id, row.client_name, row.client_uri, row.resource, row.scopes, maxExpiresAt, row.session_version],
        );

        await client.query(
            `INSERT INTO "OAuthGrantSite" (grant_id, site_id)
             SELECT $1, unnest($2::text[])
             ON CONFLICT DO NOTHING`,
            [grantId, row.site_ids],
        );

        const { accessToken, refreshToken } = await issueTokenPair(client, grantId, maxExpiresAt);

        await client.query(
            `UPDATE "OAuthAuthCode" SET grant_id = $1 WHERE code_hash = $2`,
            [grantId, codeHash],
        );
        await client.query(
            `UPDATE "OAuthClient" SET last_used_at = now() WHERE client_id = $1`,
            [row.client_id],
        );

        await client.query('COMMIT');
        return {
            ok: true,
            accessToken,
            refreshToken,
            expiresIn: ACCESS_TOKEN_TTL_SECONDS,
            scope: row.scopes.join(' '),
            grantId,
            clientId: row.client_id,
        };
    } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
    } finally {
        client.release();
    }
}

export async function rotateRefreshToken(input: {
    refreshToken: string;
    clientId: string;
    resource: string;
}): Promise<TokenExchangeResult> {
    if (!input.refreshToken.startsWith(REFRESH_TOKEN_PREFIX)) {
        return { ok: false, error: 'invalid_grant', errorDescription: 'Invalid refresh token' };
    }
    const tokenHash = sha256Buffer(input.refreshToken);
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const rotateRes = await client.query<{ grant_id: string }>(
            `UPDATE "OAuthToken"
             SET used_at = now()
             WHERE token_hash = $1
               AND kind = 'refresh'
               AND used_at IS NULL
               AND revoked_at IS NULL
               AND expires_at > now()
             RETURNING grant_id`,
            [tokenHash],
        );

        const rotated = rotateRes.rows[0];
        if (!rotated) {
            const existing = await client.query<{ grant_id: string; used_at: Date | null }>(
                `SELECT grant_id, used_at FROM "OAuthToken" WHERE token_hash = $1 AND kind = 'refresh'`,
                [tokenHash],
            );
            const prev = existing.rows[0];
            if (prev?.used_at) {
                await revokeGrantAndTokens(client, prev.grant_id);
                await client.query('COMMIT');
            } else {
                await client.query('ROLLBACK');
            }
            return { ok: false, error: 'invalid_grant', errorDescription: 'Refresh token is invalid or expired' };
        }

        const grantRes = await client.query<GrantRow>(
            `SELECT id, user_id, client_id, resource, scopes, max_expires_at, revoked_at, session_version
             FROM "OAuthGrant"
             WHERE id = $1`,
            [rotated.grant_id],
        );
        const grant = grantRes.rows[0];
        if (
            !grant
            || grant.revoked_at !== null
            || grant.max_expires_at.getTime() <= Date.now()
            || grant.client_id !== input.clientId
            || grant.resource !== input.resource
        ) {
            await client.query('ROLLBACK');
            return { ok: false, error: 'invalid_grant', errorDescription: 'Refresh token grant is no longer valid' };
        }

        const userRes = await client.query<{ is_active: boolean; session_version: number }>(
            `SELECT is_active, session_version FROM "User" WHERE id = $1`,
            [grant.user_id],
        );
        const owner = userRes.rows[0];
        if (!owner?.is_active) {
            await client.query('ROLLBACK');
            return { ok: false, error: 'invalid_grant', errorDescription: 'User account is inactive' };
        }
        if (owner.session_version !== grant.session_version) {
            await client.query('ROLLBACK');
            return { ok: false, error: 'invalid_grant', errorDescription: 'The user signed out everywhere; connect the app again' };
        }

        const { accessToken, refreshToken } = await issueTokenPair(client, grant.id, grant.max_expires_at);
        await client.query(
            `UPDATE "OAuthGrant"
             SET last_used_at = now()
             WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '15 minutes')`,
            [grant.id],
        );

        await client.query('COMMIT');
        return {
            ok: true,
            accessToken,
            refreshToken,
            expiresIn: ACCESS_TOKEN_TTL_SECONDS,
            scope: grant.scopes.join(' '),
            grantId: grant.id,
            clientId: grant.client_id,
        };
    } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
    } finally {
        client.release();
    }
}

export async function revokeOAuthToken(token: string): Promise<void> {
    if (!token.startsWith(ACCESS_TOKEN_PREFIX) && !token.startsWith(REFRESH_TOKEN_PREFIX)) {
        return;
    }
    const tokenHash = sha256Buffer(token);
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const res = await client.query<{ grant_id: string }>(
            `SELECT grant_id FROM "OAuthToken" WHERE token_hash = $1`,
            [tokenHash],
        );
        const row = res.rows[0];
        if (row) {
            await revokeGrantAndTokens(client, row.grant_id);
        }
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
    } finally {
        client.release();
    }
}

const BEARER_TOKEN_PREFIX = { access: ACCESS_TOKEN_PREFIX, integration: INTEGRATION_TOKEN_PREFIX } as const;

/**
 * The one bearer check for every grant: an MCP access token (kind 'access')
 * or an integration token (kind 'integration'), each only on its own resource.
 */
export async function authenticateGrantToken(
    authorization: string | null,
    expected: { kind: 'access' | 'integration'; resource: string },
): Promise<OAuthAccessContext | null> {
    if (!authorization) return null;
    const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
    if (!match) return null;
    const rawToken = match[1];
    if (!rawToken || !rawToken.startsWith(BEARER_TOKEN_PREFIX[expected.kind])) return null;

    const tokenHash = sha256Buffer(rawToken);
    const grantRes = await pool.query<{
        grant_id: string;
        user_id: string;
        client_id: string;
        client_name: string;
        scopes: OAuthScope[];
    }>(
        `SELECT g.id AS grant_id, g.user_id, g.client_id, g.client_name, g.scopes
         FROM "OAuthToken" t
         INNER JOIN "OAuthGrant" g ON g.id = t.grant_id
         INNER JOIN "User" u ON u.id = g.user_id
         WHERE t.token_hash = $1
           AND t.kind = $3
           AND t.revoked_at IS NULL
           AND t.expires_at > now()
           AND g.revoked_at IS NULL
           AND g.max_expires_at > now()
           AND g.resource = $2
           AND u.is_active = true
           AND g.session_version = u.session_version`,
        [tokenHash, expected.resource, expected.kind],
    );

    const grant = grantRes.rows[0];
    if (!grant) return null;

    const siteSql = siteMembershipEnabled()
        ? `SELECT gs.site_id
           FROM "OAuthGrantSite" gs
           INNER JOIN "SiteMember" sm ON sm.site_id = gs.site_id AND sm.user_id = $2
           WHERE gs.grant_id = $1`
        : `SELECT gs.site_id
           FROM "OAuthGrantSite" gs
           INNER JOIN "Site" s ON s.id = gs.site_id AND s.user_id = $2
           WHERE gs.grant_id = $1`;

    const siteRes = await pool.query<{ site_id: string }>(siteSql, [grant.grant_id, grant.user_id]);
    const authorizedSiteIds = siteRes.rows.map(r => r.site_id);
    if (authorizedSiteIds.length === 0) return null;

    await pool.query(
        `UPDATE "OAuthGrant"
         SET last_used_at = now()
         WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '15 minutes')`,
        [grant.grant_id],
    );

    return {
        grantId: grant.grant_id,
        userId: grant.user_id,
        clientId: grant.client_id,
        clientName: grant.client_name,
        scopes: grant.scopes,
        authorizedSiteIds,
    };
}

export async function listUserOAuthGrantsForSite(
    userId: string,
    siteId: string,
): Promise<UserOAuthGrantSummary[]> {
    const res = await pool.query<{
        id: string;
        kind: GrantKind;
        client_id: string;
        client_name: string;
        client_uri: string | null;
        scopes: OAuthScope[];
        created_at: Date;
        last_used_at: Date | null;
        max_expires_at: Date | null;
        site_count: string;
    }>(
        `SELECT g.id, g.kind, g.client_id, g.client_name, g.client_uri, g.scopes,
                g.created_at, g.last_used_at,
                CASE WHEN isfinite(g.max_expires_at) THEN g.max_expires_at END AS max_expires_at,
                (SELECT count(*)::text FROM "OAuthGrantSite" all_gs WHERE all_gs.grant_id = g.id) AS site_count
         FROM "OAuthGrant" g
         INNER JOIN "OAuthGrantSite" gs ON gs.grant_id = g.id
         INNER JOIN "User" u ON u.id = g.user_id
         WHERE g.user_id = $1
           AND gs.site_id = $2
           AND g.revoked_at IS NULL
           AND g.max_expires_at > now()
           AND g.session_version = u.session_version
         ORDER BY g.created_at DESC`,
        [userId, siteId],
    );
    return res.rows.map(row => ({
        id: row.id,
        kind: row.kind,
        clientId: row.client_id,
        clientName: row.client_name,
        clientUri: row.client_uri,
        scopes: row.scopes,
        createdAt: row.created_at.toISOString(),
        lastUsedAt: row.last_used_at ? row.last_used_at.toISOString() : null,
        maxExpiresAt: row.max_expires_at ? row.max_expires_at.toISOString() : null,
        siteCount: Number(row.site_count),
        publisherHost: row.kind === 'token' ? null : cimdHost(row.client_id),
    }));
}

/**
 * Creates an integration token: a 'token' grant for one home with scope
 * billing:read and no expiry. It is stamped with the session_version the
 * caller's session was validated at, and refused (null) when the user is
 * inactive or that version has moved on, so a concurrent "Sign out
 * everywhere" always wins. The raw token is returned once; only its SHA-256
 * is stored.
 */
export async function createIntegrationToken(
    userId: string,
    siteId: string,
    name: string,
    sessionVersion: number,
): Promise<{ grant: UserOAuthGrantSummary; token: string } | null> {
    const token = generateOpaqueToken(INTEGRATION_TOKEN_PREFIX);
    const grantId = randomUUID();
    const scopes: OAuthScope[] = ['billing:read'];
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const userRes = await client.query(
            `SELECT 1 FROM "User" WHERE id = $1 AND is_active AND session_version = $2 FOR SHARE`,
            [userId, sessionVersion],
        );
        if (userRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return null;
        }
        const grantRes = await client.query<{ created_at: Date }>(
            `INSERT INTO "OAuthGrant"
                (id, user_id, client_id, client_name, client_uri, resource, scopes, max_expires_at, session_version, kind)
             VALUES ($1, $2, $3, $4, NULL, $5, $6, 'infinity', $7, 'token')
             RETURNING created_at`,
            [grantId, userId, INTEGRATION_CLIENT_ID, name, INTEGRATION_RESOURCE, scopes, sessionVersion],
        );
        await client.query(
            `INSERT INTO "OAuthGrantSite" (grant_id, site_id) VALUES ($1, $2)`,
            [grantId, siteId],
        );
        await client.query(
            `INSERT INTO "OAuthToken" (token_hash, grant_id, kind, expires_at)
             VALUES ($1, $2, 'integration', 'infinity')`,
            [sha256Buffer(token), grantId],
        );
        await client.query('COMMIT');
        return {
            token,
            grant: {
                id: grantId,
                kind: 'token',
                clientId: INTEGRATION_CLIENT_ID,
                clientName: name,
                clientUri: null,
                scopes,
                createdAt: grantRes.rows[0].created_at.toISOString(),
                lastUsedAt: null,
                maxExpiresAt: null,
                siteCount: 1,
                publisherHost: null,
            },
        };
    } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
    } finally {
        client.release();
    }
}

export async function revokeUserOAuthGrant(userId: string, grantId: string): Promise<boolean> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const res = await client.query<{ id: string }>(
            `UPDATE "OAuthGrant"
             SET revoked_at = now()
             WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
             RETURNING id`,
            [grantId, userId],
        );
        if (res.rows.length === 0) {
            await client.query('ROLLBACK');
            return false;
        }
        await client.query(
            `UPDATE "OAuthToken" SET revoked_at = COALESCE(revoked_at, now()) WHERE grant_id = $1`,
            [grantId],
        );
        await client.query('COMMIT');
        return true;
    } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
    } finally {
        client.release();
    }
}

export async function cleanupExpiredOAuthRecords(): Promise<OAuthCleanupCounts> {
    const clientsRes = await pool.query(
        `DELETE FROM "OAuthClient" c
         WHERE (
             c.last_used_at IS NULL
             AND c.created_at < now() - interval '24 hours'
             AND NOT EXISTS (SELECT 1 FROM "OAuthGrant" g WHERE g.client_id = c.client_id)
             AND NOT EXISTS (
                 SELECT 1 FROM "OAuthAuthCode" a
                 WHERE a.client_id = c.client_id AND a.consumed_at IS NULL AND a.expires_at > now()
             )
         ) OR (
             COALESCE(c.last_used_at, c.created_at) < now() - interval '90 days'
             AND NOT EXISTS (
                 SELECT 1 FROM "OAuthGrant" g
                 WHERE g.client_id = c.client_id AND g.revoked_at IS NULL AND g.max_expires_at > now()
             )
         )`,
    );

    const codesRes = await pool.query(
        `DELETE FROM "OAuthAuthCode"
         WHERE expires_at < now() - interval '1 hour'
            OR consumed_at < now() - interval '24 hours'`,
    );

    const tokensRes = await pool.query(
        `DELETE FROM "OAuthToken" t
         WHERE (
             t.kind = 'access'
             AND (t.expires_at < now() - interval '24 hours' OR t.revoked_at < now() - interval '24 hours')
         ) OR (
             t.kind = 'refresh'
             AND t.expires_at < now() - interval '7 days'
             AND EXISTS (
                 SELECT 1 FROM "OAuthGrant" g
                 WHERE g.id = t.grant_id
                   AND (g.revoked_at IS NOT NULL OR g.max_expires_at < now())
             )
         )`,
    );

    const grantsRes = await pool.query(
        `DELETE FROM "OAuthGrant"
         WHERE revoked_at < now() - interval '90 days'
            OR max_expires_at < now() - interval '90 days'`,
    );

    return {
        deletedClients: clientsRes.rowCount ?? 0,
        deletedAuthCodes: codesRes.rowCount ?? 0,
        deletedTokens: tokensRes.rowCount ?? 0,
        deletedGrants: grantsRes.rowCount ?? 0,
    };
}
