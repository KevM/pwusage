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
import { TeslaAuthError, type EnergySiteLiveStatus } from './tesla-client';
import { TeslaRefreshError } from './tesla-refresh-outcome';
import { UserRepo } from './user-repo';

const liveStatus: EnergySiteLiveStatus = {
    percentage_charged: 50, solar_power: 0, backup_capable: true,
    battery_power: 0, load_power: 0, grid_status: 'Active',
    grid_services_active: false, grid_power: 0, grid_services_power: 0,
    generator_power: 0, island_status: 'on_grid', storm_mode_active: false,
    timestamp: '2026-10-27T12:00:00Z',
};

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
            auth_status text DEFAULT 'active', is_active boolean DEFAULT true,
            last_checked_at timestamp,
            tesla_credential_generation integer NOT NULL DEFAULT 0,
            tesla_refresh_attempt_id text,
            tesla_refresh_state text NOT NULL DEFAULT 'ready',
            tesla_refresh_started_at timestamptz,
            tesla_refresh_retry_after bigint NOT NULL DEFAULT 0
        )`);
        await pool.query('CREATE TEMP TABLE "Site" (id text PRIMARY KEY, user_id text)');
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
        await pool.query('TRUNCATE "Site"');
        await pool.query(`INSERT INTO "User" (id, access_token, refresh_token) VALUES ('owner', 'access-A', 'refresh-A')`);
        await pool.query(`INSERT INTO "Site" (id, user_id) VALUES ('site', 'owner')`);
    });
    afterEach(() => vi.restoreAllMocks());

    it('never sends a second grant after response loss and lease expiry', async () => {
        exchange.mockRejectedValue(new TeslaRefreshError('outcome_unknown'));
        await expect(repo.getLockedUserRefreshHandler('owner').refreshHandler('refresh-A')).rejects.toThrow();
        await pool.query('UPDATE "User" SET refresh_lock_expires = 0');
        await expect(repo.getLockedUserRefreshHandler('owner').refreshHandler('refresh-A')).rejects.toThrow();
        expect(exchange).toHaveBeenCalledTimes(1);
        expect((await pool.query('SELECT * FROM "User"')).rows[0]).toMatchObject({
            tesla_refresh_state: 'uncertain', is_active: true,
        });
    });

    it('suppresses a crashed worker whose lease expired with an unresolved attempt', async () => {
        await pool.query(`UPDATE "User" SET is_refreshing = 1, refresh_lock_expires = 1,
            tesla_refresh_state = 'in_flight', tesla_refresh_attempt_id = 'dead-worker'`);
        await expect(repo.getLockedUserRefreshHandler('owner').refreshHandler('refresh-A')).rejects.toThrow();
        expect(exchange).not.toHaveBeenCalled();
        expect((await pool.query('SELECT * FROM "User"')).rows[0].tesla_refresh_state).toBe('uncertain');
    });

    it('keeps durable suppression when recording uncertainty fails', async () => {
        exchange.mockRejectedValue(new TeslaRefreshError('outcome_unknown'));
        query.mockImplementation(async (sql: string, values?: unknown[]) => {
            if (sql.includes("tesla_refresh_state = $5")) throw new Error('write unavailable');
            return pool.query(sql, values);
        });
        await expect(repo.getLockedUserRefreshHandler('owner').refreshHandler('refresh-A')).rejects.toThrow();
        query.mockImplementation((sql: string, values?: unknown[]) => pool.query(sql, values));
        await pool.query('UPDATE "User" SET refresh_lock_expires = 0');
        await expect(repo.getLockedUserRefreshHandler('owner').refreshHandler('refresh-A')).rejects.toThrow();
        expect(exchange).toHaveBeenCalledTimes(1);
    });

    it('a lost save acknowledgement never replays the old generation', async () => {
        query.mockImplementation(async (sql: string, values?: unknown[]) => {
            const result = await pool.query(sql, values);
            if (sql.includes('SET access_token')) throw new Error('acknowledgement lost');
            return result;
        });
        await expect(repo.getLockedUserRefreshHandler('owner').refreshHandler('refresh-A')).rejects.toThrow();
        query.mockImplementation((sql: string, values?: unknown[]) => pool.query(sql, values));
        expect(await repo.getLockedUserRefreshHandler('owner').refreshHandler('refresh-A')).toEqual(rotated);
        expect(exchange).toHaveBeenCalledTimes(1);
        expect((await pool.query('SELECT * FROM "User"')).rows[0]).toMatchObject({
            tesla_credential_generation: 1, tesla_refresh_state: 'ready',
        });
    });

    it('serializes two workers on the same generation', async () => {
        let finish!: (value: typeof rotated) => void;
        let dispatched!: () => void;
        const started = new Promise<void>(resolve => { dispatched = resolve; });
        exchange.mockImplementation(() => { dispatched(); return new Promise(resolve => { finish = resolve; }); });
        const first = repo.getLockedUserRefreshHandler('owner').refreshHandler('refresh-A');
        await started;
        const second = repo.getLockedUserRefreshHandler('owner').refreshHandler('refresh-A');
        finish(rotated);
        expect(await first).toEqual(rotated);
        expect(await second).toEqual(rotated);
        expect(exchange).toHaveBeenCalledTimes(1);
    });

    it.each(['not_dispatched', 'configuration_rejected'] as const)('bounds retries for %s without revoking the user', async outcome => {
        exchange.mockRejectedValue(new TeslaRefreshError(outcome));
        await expect(repo.getLockedUserRefreshHandler('owner').refreshHandler('refresh-A')).rejects.toThrow();
        await expect(repo.getLockedUserRefreshHandler('owner').refreshHandler('refresh-A')).rejects.toThrow();
        expect(exchange).toHaveBeenCalledTimes(1);
        const row = (await pool.query('SELECT * FROM "User"')).rows[0];
        expect(row).toMatchObject({ tesla_refresh_state: 'ready', is_active: true });
        expect(Number(row.tesla_refresh_retry_after)).toBeGreaterThan(Date.now());
    });

    it('verification never clears uncertain exchange state or calls Tesla for it', async () => {
        await pool.query(`UPDATE "User" SET tesla_refresh_state = 'uncertain'`);
        const createClient = vi.fn();
        await new UserRepo().verifyUserStatus({ id: 'owner' }, { createClient });
        expect(createClient).not.toHaveBeenCalled();
        expect((await pool.query('SELECT * FROM "User"')).rows[0]).toMatchObject({ tesla_refresh_state: 'uncertain', is_active: true });
    });

    it('verification never reactivates a suspended account', async () => {
        await pool.query(`UPDATE "User" SET is_active = false`);
        await new UserRepo().verifyUserStatus({ id: 'owner' }, {
            createClient: async () => ({ getLiveStatus: async () => liveStatus }),
        });
        expect((await pool.query('SELECT * FROM "User"')).rows[0].is_active).toBe(false);
    });

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
            await pool.query(`UPDATE "User" SET access_token = 'login-access', refresh_token = 'login-refresh', tesla_credential_generation = tesla_credential_generation + 1, tesla_refresh_state = 'ready', tesla_refresh_attempt_id = NULL, is_refreshing = 0, refresh_lock_expires = 0`);
            return rotated;
        });
        expect(await repo.getLockedUserRefreshHandler('owner').refreshHandler('refresh-A'))
            .toEqual({ access_token: 'login-access', refresh_token: 'login-refresh' });
        expect((await pool.query('SELECT * FROM "User"')).rows[0]).toMatchObject({ refresh_token: 'login-refresh', is_active: true });
    });

    it('restores missing access credentials using the stored refresh grant', async () => {
        await pool.query('UPDATE "User" SET access_token = NULL');
        expect(await repo.getLockedRefreshHandler('site').refreshHandler('refresh-A')).toEqual(rotated);
        expect(exchange).toHaveBeenCalledWith('refresh-A', expect.objectContaining({ exchangeId: expect.any(String) }));
        expect((await pool.query('SELECT * FROM "User"')).rows[0]).toMatchObject(rotated);
    });

    it('does not revoke a login committed before an old refresh is rejected', async () => {
        exchange.mockImplementation(async () => {
            await pool.query(`UPDATE "User" SET access_token = 'login-access', refresh_token = 'login-refresh', tesla_credential_generation = tesla_credential_generation + 1, tesla_refresh_state = 'ready', tesla_refresh_attempt_id = NULL, is_refreshing = 0, refresh_lock_expires = 0`);
            throw new TeslaRefreshError('credential_rejected');
        });
        expect(await repo.getLockedUserRefreshHandler('owner').refreshHandler('refresh-A'))
            .toEqual({ access_token: 'login-access', refresh_token: 'login-refresh' });
        expect((await pool.query('SELECT * FROM "User"')).rows[0]).toMatchObject({ auth_status: 'active', is_active: true, is_refreshing: 0 });
    });

    it('revokes a genuine rejection and makes future waiters fail without another exchange', async () => {
        exchange.mockRejectedValue(new TeslaRefreshError('credential_rejected'));
        await expect(repo.getLockedUserRefreshHandler('owner').refreshHandler('refresh-A')).rejects.toThrow('credential_rejected');
        expect((await pool.query('SELECT * FROM "User"')).rows[0]).toMatchObject({ tesla_refresh_state: 'reconnect_required', is_active: true, is_refreshing: 0 });
        await expect(repo.getLockedRefreshHandler('site').refreshHandler('refresh-A')).rejects.toThrow('Reconnect Tesla');
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

    it('a late verification failure cannot revoke a newer login', async () => {
        const result = await new UserRepo().verifyUserStatus({ id: 'owner' }, {
            createClient: async () => ({ getLiveStatus: async () => {
                await pool.query(`UPDATE "User" SET access_token = 'login-access', refresh_token = 'login-refresh', tesla_credential_generation = tesla_credential_generation + 1, tesla_refresh_state = 'ready', tesla_refresh_attempt_id = NULL, is_refreshing = 0, refresh_lock_expires = 0`);
                throw new TeslaAuthError('Old grant rejected');
            } }),
        });
        expect(result).toEqual({ status: 'active' });
        expect((await pool.query('SELECT * FROM "User"')).rows[0]).toMatchObject({
            is_active: true, auth_status: 'active', refresh_token: 'login-refresh', last_checked_at: null,
        });
    });

    it.each(['success', 'transient'])('a late verification %s cannot reactivate a revoked account', async outcome => {
        const result = await new UserRepo().verifyUserStatus({ id: 'owner' }, {
            createClient: async () => ({ getLiveStatus: async () => {
                await pool.query(`UPDATE "User" SET auth_status = 'revoked', is_active = false`);
                if (outcome === 'transient') throw new Error('Tesla unavailable');
                return liveStatus;
            } }),
        });
        expect(result).toEqual({ status: 'revoked' });
        expect((await pool.query('SELECT * FROM "User"')).rows[0]).toMatchObject({
            is_active: false, auth_status: 'revoked', last_checked_at: null,
        });
    });

    it('retains a newer refresh performed by verification itself without marking it checked', async () => {
        const result = await new UserRepo().verifyUserStatus({ id: 'owner' }, {
            createClient: async () => ({ getLiveStatus: async () => {
                await repo.getLockedUserRefreshHandler('owner').refreshHandler('refresh-A');
                return liveStatus;
            } }),
        });
        expect(result.status).toBe('active');
        expect((await pool.query('SELECT * FROM "User"')).rows[0]).toMatchObject({ ...rotated, last_checked_at: null });
    });

    it('does not apply a verification for a site reassigned during the Tesla request', async () => {
        await new UserRepo().verifyUserStatus({ id: 'owner' }, {
            createClient: async () => ({ getLiveStatus: async () => {
                await pool.query(`UPDATE "Site" SET user_id = 'somebody-else'`);
                return liveStatus;
            } }),
        });
        expect((await pool.query('SELECT last_checked_at FROM "User"')).rows[0].last_checked_at).toBeNull();
    });

    it.each(['success', 'terminal', 'transient', 'no-token', 'no-sites'] as const)('commits an unchanged verification %s', async outcome => {
        if (outcome === 'no-sites') await pool.query('TRUNCATE "Site"');
        const result = await new UserRepo().verifyUserStatus({ id: 'owner' }, {
            createClient: async () => outcome === 'no-token' ? null : { getLiveStatus: async () => {
                if (outcome === 'terminal') throw new TeslaAuthError('Rejected');
                if (outcome === 'transient') throw new Error('Tesla unavailable');
                return liveStatus;
            } },
        });
        const expected = { success: 'active', terminal: 'revoked', transient: 'error', 'no-token': 'no_token', 'no-sites': 'no_sites' }[outcome];
        const row = (await pool.query('SELECT * FROM "User"')).rows[0];
        expect(result.status).toBe(expected);
        expect(row.auth_status).toBe(expected);
        expect(row.is_active).toBe(true);
        expect(row.last_checked_at).toBeInstanceOf(Date);
    });
});
