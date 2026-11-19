import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { Client } from 'pg';

const local = vi.hoisted(() => ({ client: undefined as unknown as import('pg').Client }));
vi.mock('@/lib/db', async importOriginal => ({
    ...await importOriginal<typeof import('@/lib/db')>(),
    pool: { query: (sql: string, values?: unknown[]) => local.client.query(sql, values) },
}));
// Site membership is not under test: the account keeps its one site throughout.
vi.mock('@/lib/site-repo', () => ({ SiteRepo: class { getSitesForUser = async () => [{ id: 'site-1' }]; } }));

import { POST as exchangeSession } from './route';
import { createCodeChallenge, createMobileLoginHandoff } from '@/lib/mobile-login-handoff';
import { verifySiteToken } from '@/lib/auth-jwt';
import { UserRepo } from '@/lib/user-repo';

interface Attempt { attemptId: string; code: string; verifier: string; state: string }

// Run with npm run test:compact -- src/app/api/mobile/session/session-revocation-postgres.test.ts.
// The runner creates a private local cluster; no .env or production DB is used.
describe.skipIf(!process.env.COMPACT_HISTORY_TEST_SOCKET)('mobile handoff revocation against PostgreSQL', () => {
    /** The native app's half of a login: PKCE material, then the callback's handoff. */
    const startLogin = async (): Promise<Attempt> => {
        const verifier = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
        const state = 'S'.repeat(32);
        const { code, attemptId } = await createMobileLoginHandoff({
            attemptId: randomUUID(), codeChallenge: createCodeChallenge(verifier), appState: state,
            userId: 'user-1', siteIds: ['site-1'], roles: ['user'],
        });
        return { attemptId, code, verifier, state };
    };
    const exchange = (attempt: Attempt) => exchangeSession(new NextRequest('https://pwusage.test/api/mobile/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(attempt),
    }));
    const issuedCookie = (response: Response) => response.headers.getSetCookie()
        .find(cookie => cookie.startsWith('site_auth='))?.split(';', 1)[0].slice('site_auth='.length) ?? '';
    const signOutEverywhere = () => new UserRepo().bumpSessionVersion('user-1');

    beforeAll(async () => {
        local.client = new Client({ host: process.env.COMPACT_HISTORY_TEST_SOCKET, port: 55439,
            database: 'postgres', user: process.env.USER });
        await local.client.connect();
        // The Supabase roles the migrations revoke from and grant to.
        for (const role of ['anon', 'authenticated', 'service_role']) {
            await local.client.query(`DO $$ BEGIN CREATE ROLE ${role}; EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
        }
        await local.client.query('DROP TABLE IF EXISTS "MobileLoginHandoff"');
        await local.client.query(await readFile('db-migrations/20260923181812_add_mobile_login_handoff.sql', 'utf8'));
        // A handoff written by the code before this deploy, so before the column exists.
        await local.client.query(`INSERT INTO "MobileLoginHandoff"
            (attempt_id, code_hash, code_challenge, app_state, user_id, site_ids, roles, expires_at)
            VALUES ($1, repeat('0', 64), repeat('c', 43), repeat('S', 32), 'user-1', ARRAY['site-1'], ARRAY['user'],
                    now() + interval '5 minutes')`, [randomUUID()]);
        const migration = await readFile('db-migrations/20261118191802_mobile_login_handoff_session_version.sql', 'utf8');
        await local.client.query(migration);
        await local.client.query(migration);
        await local.client.query(`CREATE TEMP TABLE "User" (
            id text PRIMARY KEY, email text, roles text[] NOT NULL DEFAULT '{}'::text[], is_active boolean DEFAULT true,
            session_version integer NOT NULL DEFAULT 0, access_token text, refresh_token text
        )`);
    });
    afterAll(async () => {
        await local.client?.query('DROP TABLE IF EXISTS "MobileLoginHandoff"');
        await local.client?.end();
    });
    beforeEach(async () => {
        vi.restoreAllMocks();
        await local.client.query('DELETE FROM "MobileLoginHandoff" WHERE session_version IS NOT NULL');
        await local.client.query('TRUNCATE "User"');
        await local.client.query(`INSERT INTO "User" (id, roles) VALUES ('user-1', ARRAY['user'])`);
    });

    it('binds a new handoff to the session version current when it is created', async () => {
        await signOutEverywhere();
        const attempt = await startLogin();
        const { rows } = await local.client.query(
            'SELECT session_version FROM "MobileLoginHandoff" WHERE attempt_id = $1', [attempt.attemptId]);
        expect(rows).toEqual([{ session_version: 1 }]);
    });

    it('rejects a handoff created before sign out everywhere, then accepts a fresh login', async () => {
        const stale = await startLogin();
        await signOutEverywhere();

        const rejected = await exchange(stale);
        expect(rejected.status).toBe(401);
        expect(issuedCookie(rejected)).toBe('');

        const fresh = await exchange(await startLogin());
        expect(fresh.status).toBe(200);
        expect(verifySiteToken(issuedCookie(fresh))).toMatchObject({ sub: 'user-1', sites: ['site-1'], sv: 1 });
    });

    it('never mints the newer version when revocation lands after the handoff is consumed', async () => {
        const attempt = await startLogin();
        // Sign out everywhere commits between the consume and the route's user reload.
        const getById = UserRepo.prototype.getById;
        vi.spyOn(UserRepo.prototype, 'getById').mockImplementationOnce(async function (this: UserRepo, id: string) {
            await signOutEverywhere();
            return getById.call(this, id);
        });

        const response = await exchange(attempt);
        const cookie = issuedCookie(response);
        // Either no cookie at all, or one that the revocation check rejects; never sv 1.
        expect(response.status).toBe(401);
        expect(cookie).toBe('');
        // The handoff was spent: replaying it after the race still fails.
        expect((await exchange(attempt)).status).toBe(401);
    });

    it('rejects a handoff row written before the session_version column existed', async () => {
        const { rows } = await local.client.query(
            'SELECT attempt_id FROM "MobileLoginHandoff" WHERE session_version IS NULL');
        expect(rows).toHaveLength(1);
        // Even with a matching code the row is unbound, so it fails closed.
        await local.client.query(`UPDATE "MobileLoginHandoff" SET code_hash = encode(sha256($1::bytea), 'hex'),
            code_challenge = $2 WHERE session_version IS NULL`, ['C'.repeat(43), createCodeChallenge('V'.repeat(43))]);
        const response = await exchange({
            attemptId: rows[0].attempt_id, code: 'C'.repeat(43), verifier: 'V'.repeat(43), state: 'S'.repeat(32),
        });
        expect(response.status).toBe(401);
        expect(issuedCookie(response)).toBe('');
    });
});
