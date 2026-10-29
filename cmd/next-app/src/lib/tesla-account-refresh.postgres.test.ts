import { readFileSync } from 'node:fs';
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
import { TeslaRefreshBackoffError, TeslaRefreshError } from './tesla-refresh-outcome';
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
const migration = readFileSync(new URL('../../db-migrations/20261028192559_tesla_refresh_outcomes.sql', import.meta.url), 'utf8');

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
            last_checked_at timestamp, email text, token_expires_at bigint,
            session_version integer NOT NULL DEFAULT 0, roles text[] NOT NULL DEFAULT '{}'::text[]
        )`);
        await pool.query(migration);
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
    afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

    it('backs off after response loss, then retries the same grant', async () => {
        exchange.mockRejectedValueOnce(new TeslaRefreshError('outcome_unknown', 503));
        await expect(repo.getLockedUserRefreshHandler('owner').refreshHandler('refresh-A')).rejects.toThrow('outcome_unknown');
        const row = (await pool.query('SELECT * FROM "User"')).rows[0];
        expect(row).toMatchObject({ tesla_refresh_state: 'ready', is_active: true, is_refreshing: 0, refresh_token: 'refresh-A' });
        expect(Number(row.tesla_refresh_retry_after)).toBeGreaterThan(Date.now());
        // Inside the backoff: fail fast, no exchange.
        await expect(repo.getLockedUserRefreshHandler('owner').refreshHandler('refresh-A')).rejects.toBeInstanceOf(TeslaRefreshBackoffError);
        expect(exchange).toHaveBeenCalledTimes(1);
        // After it: the stored grant is retried, never a reconnect.
        await pool.query('UPDATE "User" SET tesla_refresh_retry_after = 0');
        expect(await repo.getLockedUserRefreshHandler('owner').refreshHandler('refresh-A')).toEqual(rotated);
        expect(exchange).toHaveBeenCalledTimes(2);
        expect(exchange.mock.calls[1][0]).toBe('refresh-A');
    });

    it('recovers a crashed worker whose lease expired into a backoff, keeping its attempt id', async () => {
        await pool.query(`UPDATE "User" SET is_refreshing = 1, refresh_lock_expires = 1,
            tesla_refresh_state = 'in_flight', tesla_refresh_attempt_id = 'dead-worker'`);
        await expect(repo.getLockedUserRefreshHandler('owner').refreshHandler('refresh-A')).rejects.toBeInstanceOf(TeslaRefreshBackoffError);
        expect(exchange).not.toHaveBeenCalled();
        const row = (await pool.query('SELECT * FROM "User"')).rows[0];
        expect(row).toMatchObject({ tesla_refresh_state: 'ready', is_refreshing: 0, tesla_refresh_attempt_id: 'dead-worker' });
        expect(Number(row.tesla_refresh_retry_after)).toBeGreaterThan(Date.now());
    });

    it('a worker whose lease expired still saves the rotation it received', async () => {
        exchange.mockImplementation(async () => {
            await pool.query('UPDATE "User" SET refresh_lock_expires = 1');
            await expect(new TeslaTokenRepo({ getSite: async () => ({ user_id: 'owner' }), invalidateCache: () => {} } as unknown as SiteRepo)
                .getLockedUserRefreshHandler('owner').refreshHandler('refresh-A')).rejects.toBeInstanceOf(TeslaRefreshBackoffError);
            return rotated;
        });
        expect(await repo.getLockedUserRefreshHandler('owner').refreshHandler('refresh-A')).toEqual(rotated);
        expect((await pool.query('SELECT * FROM "User"')).rows[0]).toMatchObject({
            ...rotated, tesla_refresh_state: 'ready', tesla_refresh_attempt_id: null, is_refreshing: 0,
            tesla_credential_generation: 1,
        });
        expect(Number((await pool.query('SELECT * FROM "User"')).rows[0].tesla_refresh_retry_after)).toBe(0);
    });

    it('a stale caller adopts the stored rotation without claiming the lease', async () => {
        await pool.query(`UPDATE "User" SET access_token = 'access-B', refresh_token = 'refresh-B', tesla_credential_generation = 1`);
        expect(await repo.getLockedUserRefreshHandler('owner').refreshHandler('refresh-A')).toEqual(rotated);
        expect(exchange).not.toHaveBeenCalled();
        expect((await pool.query('SELECT * FROM "User"')).rows[0]).toMatchObject({
            tesla_refresh_state: 'ready', tesla_refresh_attempt_id: null, is_refreshing: 0,
        });
    });

    it('keeps the backoff when recording the outcome fails', async () => {
        exchange.mockRejectedValue(new TeslaRefreshError('outcome_unknown'));
        query.mockImplementation(async (sql: string, values?: unknown[]) => {
            if (sql.includes('refresh_lock_expires = 0')) throw new Error('write unavailable');
            return pool.query(sql, values);
        });
        await expect(repo.getLockedUserRefreshHandler('owner').refreshHandler('refresh-A')).rejects.toThrow();
        query.mockImplementation((sql: string, values?: unknown[]) => pool.query(sql, values));
        expect((await pool.query('SELECT * FROM "User"')).rows[0].tesla_refresh_state).toBe('in_flight');
        await pool.query('UPDATE "User" SET refresh_lock_expires = 1');
        await expect(repo.getLockedUserRefreshHandler('owner').refreshHandler('refresh-A')).rejects.toBeInstanceOf(TeslaRefreshBackoffError);
        expect(exchange).toHaveBeenCalledTimes(1);
    });

    it('migration lets previously revoked accounts reconnect, and re-runs cleanly', async () => {
        await pool.query(`UPDATE "User" SET auth_status = 'revoked', is_active = false`);
        await pool.query(migration);
        expect((await pool.query('SELECT * FROM "User"')).rows[0]).toMatchObject({
            is_active: true, tesla_refresh_state: 'reconnect_required',
        });
        await new UserRepo().upsertOnTeslaAuth({ userId: 'owner', email: null, accessToken: 'login-A', refreshToken: 'login-R', tokenExpiresAt: Date.now() });
        expect(await repo.getLockedRefreshHandler('site').refreshHandler('login-R')).toEqual(rotated);
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

    it('requests during an in-flight refresh proceed instead of failing', async () => {
        let finish!: (value: typeof rotated) => void;
        let dispatched!: () => void;
        const started = new Promise<void>(resolve => { dispatched = resolve; });
        exchange.mockImplementation(() => { dispatched(); return new Promise(resolve => { finish = resolve; }); });
        const refreshing = repo.getLockedUserRefreshHandler('owner').refreshHandler('refresh-A');
        await started;
        const browser = await createTeslaClientForUser('owner');
        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ response: [] }));
        await expect(browser?.getProducts()).resolves.toEqual([]);
        finish(rotated);
        await refreshing;
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

    it('verification reaches an expired lease so the account can recover', async () => {
        await pool.query(`UPDATE "User" SET is_refreshing = 1, refresh_lock_expires = 1, tesla_refresh_state = 'in_flight'`);
        const createClient = vi.fn(async () => ({ getLiveStatus: async () => liveStatus }));
        await new UserRepo().verifyUserStatus({ id: 'owner' }, { createClient });
        expect(createClient).toHaveBeenCalled();
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

    it('preserves app access through response loss and restores the linked site after reconnect', async () => {
        const realAuth = await vi.importActual<typeof import('./tesla-auth')>('./tesla-auth');
        exchange.mockImplementation(realAuth.refreshAccessToken);
        vi.stubEnv('PUBLIC_TESLA_OAUTH_CLIENT_ID', 'synthetic-client');
        vi.stubEnv('TESLA_OAUTH_SECRET', 'synthetic-secret');
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('response lost after consumption'));
        const sessionVersion = (await new UserRepo().getAuthState('owner'))?.sessionVersion;
        await expect(repo.getLockedRefreshHandler('site').refreshHandler('refresh-A')).rejects.toThrow();
        await expect(repo.getLockedRefreshHandler('site').refreshHandler('refresh-A')).rejects.toBeInstanceOf(TeslaRefreshBackoffError);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(await new UserRepo().getAuthState('owner')).toMatchObject({ isActive: true, sessionVersion });
        await new UserRepo().upsertOnTeslaAuth({ userId: 'owner', email: null, accessToken: 'login-A', refreshToken: 'login-R', tokenExpiresAt: Date.now() + 3600000 });
        expect((await pool.query('SELECT user_id FROM "Site" WHERE id = $1', ['site'])).rows[0].user_id).toBe('owner');
        fetchMock.mockResolvedValue(Response.json(rotated));
        expect(await repo.getLockedRefreshHandler('site').refreshHandler('login-R')).toEqual(rotated);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(await new UserRepo().getAuthState('owner')).toMatchObject({ isActive: true, sessionVersion });
    });

    it('OAuth replaces the credential generation without reactivating a suspended account', async () => {
        await pool.query(`UPDATE "User" SET is_active = false, tesla_refresh_state = 'uncertain'`);
        await new UserRepo().upsertOnTeslaAuth({ userId: 'owner', email: null, accessToken: 'login-A', refreshToken: 'login-R', tokenExpiresAt: Date.now() });
        expect((await pool.query('SELECT * FROM "User"')).rows[0]).toMatchObject({
            is_active: false, tesla_refresh_state: 'ready', tesla_credential_generation: 1,
        });
        await expect(repo.getLockedRefreshHandler('site').refreshHandler('login-R')).rejects.toThrow();
        expect(exchange).not.toHaveBeenCalled();
    });

    it('a browser constructed before a site refresh reuses its persisted replacement', async () => {
        const browser = await createTeslaClientForUser('owner');
        expect(await repo.getLockedRefreshHandler('site').refreshHandler('refresh-A')).toEqual(rotated);
        const fetchMock = vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(Response.json({ response: [] }));
        await browser?.getProducts();
        expect(exchange).toHaveBeenCalledTimes(1);
        // Adopted before the request: the consumed copy never reaches Tesla.
        expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({ Authorization: 'Bearer access-B' });
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
        const expected = { success: 'active', terminal: 'error', transient: 'error', 'no-token': 'no_token', 'no-sites': 'no_sites' }[outcome];
        const row = (await pool.query('SELECT * FROM "User"')).rows[0];
        expect(result.status).toBe(expected);
        expect(row.auth_status).toBe(expected);
        expect(row.is_active).toBe(true);
        expect(row.last_checked_at).toBeInstanceOf(Date);
    });
});
