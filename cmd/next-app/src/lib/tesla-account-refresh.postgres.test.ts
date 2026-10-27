import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import type { SiteRepo } from './site-repo';

const { query, exchange } = vi.hoisted(() => ({ query: vi.fn(), exchange: vi.fn() }));
vi.mock('./db', () => ({ pool: { query } }));
vi.mock('./tesla-auth', async importOriginal => ({
    ...await importOriginal<typeof import('./tesla-auth')>(), refreshAccessToken: exchange,
}));
import { TeslaTokenRepo } from './tesla-token-repo';
import { createTeslaClientForUser } from './tesla-client-factory';
import { TeslaAuthError } from './tesla-client';

// Run with npm run test:compact -- src/lib/tesla-account-refresh.postgres.test.ts.
// The runner creates a private local cluster; no .env or production DB is used.
describe.skipIf(!process.env.COMPACT_HISTORY_TEST_SOCKET)('account refresh against PostgreSQL', () => {
    let pool: Pool;
    let repo: TeslaTokenRepo;
    const rotated = { access_token: 'access-B', refresh_token: 'refresh-B' };

    beforeAll(async () => {
        pool = new Pool({ host: process.env.COMPACT_HISTORY_TEST_SOCKET, port: 55439,
            database: 'postgres', user: process.env.USER, max: 1 });
        // max:1 keeps this connection-local temporary table isolated from every
        // other test and makes interleaving application operations deterministic.
        await pool.query(`CREATE TEMP TABLE "User" (
            id text PRIMARY KEY, access_token text, refresh_token text,
            fleet_api_base_url text, is_refreshing integer NOT NULL DEFAULT 0,
            refresh_lock_expires bigint NOT NULL DEFAULT 0,
            auth_status text DEFAULT 'active', is_active boolean DEFAULT true
        )`);
        query.mockImplementation((sql: string, values?: unknown[]) => pool.query(sql, values));
        repo = new TeslaTokenRepo({
            getSite: async () => ({ user_id: 'owner' }), invalidateCache: () => {},
        } as unknown as SiteRepo);
    });
    afterAll(async () => { await pool?.end(); });
    beforeEach(async () => {
        exchange.mockReset();
        exchange.mockResolvedValue(rotated);
        await pool.query('TRUNCATE "User"');
        await pool.query(`INSERT INTO "User" (id, access_token, refresh_token) VALUES ('owner', 'access-A', 'refresh-A')`);
    });
    afterEach(() => vi.restoreAllMocks());

    it('a browser constructed before a site refresh reuses its persisted replacement', async () => {
        const browser = await createTeslaClientForUser('owner');
        expect(await repo.getLockedRefreshHandler('site').refreshHandler('refresh-A')).toEqual(rotated);
        const fetchMock = vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(new Response('', { status: 401 }))
            .mockResolvedValueOnce(Response.json({ response: [] }));
        await browser?.getProducts();
        expect(exchange).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[1][1]?.headers).toMatchObject({ Authorization: 'Bearer access-B' });
        const { rows } = await pool.query('SELECT * FROM "User"');
        expect(rows[0]).toMatchObject({ ...rotated, is_refreshing: 0, auth_status: 'active', is_active: true });
    });

    it('does not overwrite a login committed during the old refresh', async () => {
        exchange.mockImplementation(async () => {
            await pool.query(`UPDATE "User" SET access_token = 'login-access', refresh_token = 'login-refresh'`);
            return rotated;
        });
        expect(await repo.getLockedUserRefreshHandler('owner').refreshHandler('refresh-A'))
            .toEqual({ access_token: 'login-access', refresh_token: 'login-refresh' });
        expect((await pool.query('SELECT * FROM "User"')).rows[0]).toMatchObject({ refresh_token: 'login-refresh', is_active: true });
    });

    it('restores missing access credentials using the stored refresh grant', async () => {
        await pool.query('UPDATE "User" SET access_token = NULL');
        expect(await repo.getLockedRefreshHandler('site').refreshHandler('refresh-A')).toEqual(rotated);
        expect(exchange).toHaveBeenCalledWith('refresh-A');
        expect((await pool.query('SELECT * FROM "User"')).rows[0]).toMatchObject(rotated);
    });

    it('does not revoke a login committed before an old refresh is rejected', async () => {
        exchange.mockImplementation(async () => {
            await pool.query(`UPDATE "User" SET access_token = 'login-access', refresh_token = 'login-refresh'`);
            throw new TeslaAuthError('Rejected', 401);
        });
        expect(await repo.getLockedUserRefreshHandler('owner').refreshHandler('refresh-A'))
            .toEqual({ access_token: 'login-access', refresh_token: 'login-refresh' });
        expect((await pool.query('SELECT * FROM "User"')).rows[0]).toMatchObject({ auth_status: 'active', is_active: true, is_refreshing: 0 });
    });

    it('revokes a genuine rejection and makes future waiters fail without another exchange', async () => {
        exchange.mockRejectedValue(new TeslaAuthError('Rejected', 401));
        await expect(repo.getLockedUserRefreshHandler('owner').refreshHandler('refresh-A')).rejects.toThrow('Rejected');
        expect((await pool.query('SELECT * FROM "User"')).rows[0]).toMatchObject({ auth_status: 'revoked', is_active: false, is_refreshing: 0 });
        await expect(repo.getLockedRefreshHandler('site').refreshHandler('refresh-A')).rejects.toThrow('auth revoked');
        expect(exchange).toHaveBeenCalledTimes(1);
    });

    it('cannot save or release after another worker replaces the lease', async () => {
        exchange.mockImplementation(async () => {
            await pool.query(`UPDATE "User" SET access_token = 'winner-access', refresh_token = 'winner-refresh',
                refresh_lock_expires = refresh_lock_expires + 10000, is_refreshing = 0`);
            return rotated;
        });
        expect(await repo.getLockedUserRefreshHandler('owner').refreshHandler('refresh-A'))
            .toEqual({ access_token: 'winner-access', refresh_token: 'winner-refresh' });
        const row = (await pool.query('SELECT * FROM "User"')).rows[0];
        expect(Number(row.refresh_lock_expires)).toBeGreaterThan(Date.now() + 60000);
        expect(row.refresh_token).toBe('winner-refresh');
    });
});
