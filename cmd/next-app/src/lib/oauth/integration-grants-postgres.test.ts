import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';

const { local, localPool } = vi.hoisted(() => {
    const local = { client: undefined as unknown as import('pg').Client };
    // Like a real pool: plain queries share one connection, and each transaction
    // gets a connection of its own, so concurrent transactions really overlap.
    const localPool = {
        query: (sql: string, values?: unknown[]) => local.client.query(sql, values),
        connect: async () => {
            const { Client: PgClient } = await import('pg');
            const client = new PgClient({ host: process.env.COMPACT_HISTORY_TEST_SOCKET, port: 55439,
                database: 'postgres', user: process.env.USER });
            await client.connect();
            return Object.assign(client, { release: () => void client.end() });
        },
    };
    return { local, localPool };
});
vi.mock('@/lib/db', async importOriginal => ({
    ...await importOriginal<typeof import('@/lib/db')>(),
    pool: localPool,
}));
vi.mock('../db', async importOriginal => ({
    ...await importOriginal<typeof import('../db')>(),
    pool: localPool,
}));

import { authenticateGrantToken, createIntegrationToken, MAX_ACTIVE_INTEGRATION_TOKENS_PER_SITE } from './oauth-repo';
import { INTEGRATION_RESOURCE } from './types';
import { UserRepo } from '@/lib/user-repo';

const token = 'pwu_int_' + 'a'.repeat(43);
const tokenHash = createHash('sha256').update(token).digest();
const credentialId = '87ed8088-70f1-482c-86ce-c4ef67106e8d';
const migration = 'db-migrations/20261125183518_integration_tokens_as_grants.sql';

// Run with npm run test:compact -- src/lib/oauth/integration-grants-postgres.test.ts.
// The runner creates a private local cluster; no .env or production DB is used.
describe.skipIf(!process.env.COMPACT_HISTORY_TEST_SOCKET)('integration tokens as OAuth grants against PostgreSQL', () => {
    const dropAll = () => local.client.query(`DROP TABLE IF EXISTS
        "IntegrationGrant", "IntegrationCredential", "OAuthToken", "OAuthAuthCode", "OAuthGrantSite",
        "OAuthGrant", "OAuthClient", "SiteMember", "Site", "User" CASCADE`);

    beforeAll(async () => {
        local.client = new Client({ host: process.env.COMPACT_HISTORY_TEST_SOCKET, port: 55439,
            database: 'postgres', user: process.env.USER });
        await local.client.connect();
        // The Supabase roles the migrations revoke from and grant to.
        for (const role of ['anon', 'authenticated', 'service_role']) {
            await local.client.query(`DO $$ BEGIN CREATE ROLE ${role}; EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
        }
        await dropAll();
        await local.client.query(`CREATE TABLE "User" (
            id text PRIMARY KEY, is_active boolean NOT NULL DEFAULT true, session_version integer NOT NULL DEFAULT 0
        )`);
        await local.client.query('CREATE TABLE "Site" (id text PRIMARY KEY, user_id text NOT NULL)');
        await local.client.query('CREATE TABLE "SiteMember" (site_id text NOT NULL, user_id text NOT NULL)');
        await local.client.query(`INSERT INTO "User" (id, session_version) VALUES ('user-1', 3), ('user-2', 0)`);
        await local.client.query(`INSERT INTO "Site" (id, user_id) VALUES ('site-1', 'user-1'), ('site-2', 'user-2')`);

        await local.client.query(await readFile('db-migrations/20261124073716_integration_credentials.sql', 'utf8'));
        await local.client.query(await readFile('db-migrations/20261125111815_oauth_mcp.sql', 'utf8'));
        // A token created before this deploy.
        await local.client.query(`INSERT INTO "IntegrationCredential" (id, site_id, user_id, name, token_hash, created_at)
            VALUES ($1, 'site-1', 'user-1', 'ecobee aux', $2, '2026-11-24T08:00:00Z')`, [credentialId, tokenHash]);
        await local.client.query(`INSERT INTO "IntegrationGrant" (credential_id, scope) VALUES ($1, 'billing:read')`, [credentialId]);

        const sql = await readFile(migration, 'utf8');
        await local.client.query(sql);
        await local.client.query(sql);
    });
    afterAll(async () => {
        await dropAll();
        await local.client?.end();
    });

    it('copies each credential into a token grant', async () => {
        const grants = await local.client.query(`SELECT id, kind, client_id, client_name, resource, scopes,
                isfinite(max_expires_at) AS expires, session_version, created_at
            FROM "OAuthGrant"`);
        expect(grants.rows).toEqual([{
            id: credentialId, kind: 'token', client_id: 'pwu_integration', client_name: 'ecobee aux',
            resource: 'urn:pwusage:integrations:v1', scopes: ['billing:read'], expires: false, session_version: 3,
            created_at: new Date('2026-11-24T08:00:00Z'),
        }]);
        const sites = await local.client.query('SELECT grant_id, site_id FROM "OAuthGrantSite"');
        expect(sites.rows).toEqual([{ grant_id: credentialId, site_id: 'site-1' }]);
        const tokens = await local.client.query(`SELECT grant_id, kind, token_hash, isfinite(expires_at) AS expires
            FROM "OAuthToken"`);
        expect(tokens.rows).toEqual([{ grant_id: credentialId, kind: 'integration', token_hash: tokenHash, expires: false }]);
    });

    it('is idempotent', async () => {
        await local.client.query(await readFile(migration, 'utf8'));
        const counts = await local.client.query(`SELECT
            (SELECT count(*) FROM "OAuthGrant")::int AS grants,
            (SELECT count(*) FROM "OAuthGrantSite")::int AS sites,
            (SELECT count(*) FROM "OAuthToken")::int AS tokens`);
        expect(counts.rows[0]).toEqual({ grants: 1, sites: 1, tokens: 1 });
    });

    it('keeps OAuth app grants as kind app', async () => {
        const res = await local.client.query(`SELECT column_default FROM information_schema.columns
            WHERE table_name = 'OAuthGrant' AND column_name = 'kind'`);
        expect(res.rows[0].column_default).toBe(`'app'::text`);
    });

    it('authenticates a copied token', async () => {
        const ctx = await authenticateGrantToken(`Bearer ${token}`, { kind: 'integration', resource: INTEGRATION_RESOURCE });
        expect(ctx).toMatchObject({ grantId: credentialId, userId: 'user-1', authorizedSiteIds: ['site-1'], scopes: ['billing:read'] });
    });

    it('drops the old integration token tables once copied', async () => {
        const res = await local.client.query(`SELECT
            to_regclass('public."IntegrationCredential"') AS credential,
            to_regclass('public."IntegrationGrant"') AS grant_scope`);
        expect(res.rows[0]).toEqual({ credential: null, grant_scope: null });
    });

    it('caps active integration tokens per home and counts only unrevoked ones', async () => {
        await local.client.query(`INSERT INTO "User" (id, session_version) VALUES ('user-3', 0)`);
        await local.client.query(`INSERT INTO "Site" (id, user_id) VALUES ('site-3', 'user-3')`);
        const first = await createIntegrationToken('user-3', 'site-3', 'script 0', 0);
        if (first.status !== 'created') throw new Error('expected a token');
        const created = await authenticateGrantToken(`Bearer ${first.token}`, { kind: 'integration', resource: INTEGRATION_RESOURCE });
        expect(created).toMatchObject({ grantId: first.grant.id, authorizedSiteIds: ['site-3'] });
        for (let i = 1; i < MAX_ACTIVE_INTEGRATION_TOKENS_PER_SITE; i++) {
            expect((await createIntegrationToken('user-3', 'site-3', `script ${i}`, 0)).status).toBe('created');
        }
        expect(await createIntegrationToken('user-3', 'site-3', 'one too many', 0)).toEqual({ status: 'limit' });
        await local.client.query(`UPDATE "OAuthGrant" SET revoked_at = now() WHERE id = $1`, [first.grant.id]);
        expect((await createIntegrationToken('user-3', 'site-3', 'replacement', 0)).status).toBe('created');
    });

    it('allows only one of several concurrent creates past the last free slot', async () => {
        await local.client.query(`INSERT INTO "User" (id, session_version) VALUES ('user-4', 0)`);
        await local.client.query(`INSERT INTO "Site" (id, user_id) VALUES ('site-4', 'user-4')`);
        for (let i = 1; i < MAX_ACTIVE_INTEGRATION_TOKENS_PER_SITE; i++) {
            expect((await createIntegrationToken('user-4', 'site-4', `script ${i}`, 0)).status).toBe('created');
        }
        const results = await Promise.all(Array.from({ length: 6 }, (_, i) =>
            createIntegrationToken('user-4', 'site-4', `racer ${i}`, 0)));
        expect(results.filter(r => r.status === 'created')).toHaveLength(1);
        const active = await local.client.query(`SELECT count(*)::int AS n FROM "OAuthGrant"
            WHERE user_id = 'user-4' AND kind = 'token' AND revoked_at IS NULL`);
        expect(active.rows[0].n).toBe(MAX_ACTIVE_INTEGRATION_TOKENS_PER_SITE);
    });

    it('deleting a home deletes its integration tokens', async () => {
        await local.client.query(`INSERT INTO "User" (id, session_version) VALUES ('user-5', 0)`);
        await local.client.query(`INSERT INTO "Site" (id, user_id) VALUES ('site-5', 'user-5')`);
        const created = await createIntegrationToken('user-5', 'site-5', 'script', 0);
        if (created.status !== 'created') throw new Error('expected a token');
        await local.client.query(`DELETE FROM "Site" WHERE id = 'site-5'`);
        const left = await local.client.query(`SELECT
            (SELECT count(*) FROM "OAuthGrant" WHERE id = $1)::int AS grants,
            (SELECT count(*) FROM "OAuthToken" WHERE grant_id = $1)::int AS tokens`, [created.grant.id]);
        expect(left.rows[0]).toEqual({ grants: 0, tokens: 0 });
    });

    it('deleting one home keeps an app grant that still covers another', async () => {
        const appGrantId = 'b0b0b0b0-1111-4222-8333-444455556666';
        await local.client.query(`INSERT INTO "Site" (id, user_id) VALUES ('site-6a', 'user-5'), ('site-6b', 'user-5')`);
        await local.client.query(`INSERT INTO "OAuthGrant"
            (id, user_id, client_id, client_name, resource, scopes, max_expires_at, session_version, kind)
            VALUES ($1, 'user-5', 'https://claude.ai/oauth/client.json', 'Claude', 'https://pwusage.fm.rodeo/api/mcp',
                    ARRAY['billing:read'], now() + interval '90 days', 0, 'app')`, [appGrantId]);
        await local.client.query(`INSERT INTO "OAuthGrantSite" (grant_id, site_id) VALUES ($1, 'site-6a'), ($1, 'site-6b')`, [appGrantId]);
        await local.client.query(`DELETE FROM "Site" WHERE id = 'site-6a'`);
        const sites = await local.client.query(`SELECT site_id FROM "OAuthGrantSite" WHERE grant_id = $1`, [appGrantId]);
        expect(sites.rows).toEqual([{ site_id: 'site-6b' }]);
        await local.client.query(`DELETE FROM "Site" WHERE id = 'site-6b'`);
        const grants = await local.client.query(`SELECT count(*)::int AS n FROM "OAuthGrant" WHERE id = $1`, [appGrantId]);
        expect(grants.rows[0].n).toBe(1);
    });

    it('does not accept an integration token stored against an app grant', async () => {
        const grant = await local.client.query(`SELECT id FROM "OAuthGrant"
            WHERE user_id = 'user-3' AND revoked_at IS NULL LIMIT 1`);
        const grantId = grant.rows[0].id;
        const raw = 'pwu_int_' + 'c'.repeat(43);
        await local.client.query(`INSERT INTO "OAuthToken" (token_hash, grant_id, kind, expires_at)
            VALUES ($1, $2, 'integration', 'infinity')`, [createHash('sha256').update(raw).digest(), grantId]);
        const expected = { kind: 'integration', resource: INTEGRATION_RESOURCE } as const;
        expect(await authenticateGrantToken(`Bearer ${raw}`, expected)).toMatchObject({ grantId });
        await local.client.query(`UPDATE "OAuthGrant" SET kind = 'app' WHERE id = $1`, [grantId]);
        expect(await authenticateGrantToken(`Bearer ${raw}`, expected)).toBeNull();
    });

    it('sign out everywhere revokes the token', async () => {
        await new UserRepo().signOutEverywhere('user-1');
        expect(await authenticateGrantToken(`Bearer ${token}`, { kind: 'integration', resource: INTEGRATION_RESOURCE })).toBeNull();
    });
});
