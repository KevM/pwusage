import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { queryMock, logEventMock } = vi.hoisted(() => ({
    queryMock: vi.fn(),
    logEventMock: vi.fn(),
}));

vi.mock('./observability', () => ({ logEvent: logEventMock, flushLogEvents: vi.fn() }));

vi.mock('./db', () => ({
    pool: {
        query: queryMock
    }
}));

import { UserRepo } from './user-repo';
import { latestStoredSampleSql } from './latest-stored-sample-sql';
import { TeslaAuthError } from './tesla-client';
import { TeslaTokenRepo } from './tesla-token-repo';
import { SiteRepo } from './site-repo';

describe('UserRepo admin ordering', () => {
    beforeEach(() => {
        queryMock.mockReset();
    });

    it('sorts users by last data import descending before activity status', async () => {
        queryMock
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [] });

        const repo = new UserRepo();
        await repo.getAllUsers();

        expect(queryMock).toHaveBeenNthCalledWith(
            1,
            expect.stringContaining('ORDER BY last_data_import DESC NULLS LAST, u.is_active DESC')
        );
    });

    it('takes last data import from raw rows or day records, whichever is newer', async () => {
        queryMock
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [] });

        await new UserRepo().getAllUsers();

        const [sql] = queryMock.mock.calls[0] as [string];
        expect(sql).toContain(`SELECT MAX(${latestStoredSampleSql('s.id')}) FROM "Site" s WHERE s.user_id = u.id`);
    });
});

describe('UserRepo email synchronization', () => {
    beforeEach(() => {
        queryMock.mockReset();
    });

    it('getUserEmail fetches email column', async () => {
        queryMock.mockResolvedValueOnce({ rows: [{ email: 'test@trmnl.com' }] });
        const repo = new UserRepo();
        const email = await repo.getUserEmail('user-123');
        expect(email).toBe('test@trmnl.com');
        expect(queryMock).toHaveBeenCalledWith(
            'SELECT email FROM "User" WHERE id = $1',
            ['user-123']
        );
    });

    it('updateUserEmail updates email column', async () => {
        queryMock.mockResolvedValueOnce({ rows: [] });
        const repo = new UserRepo();
        await repo.updateUserEmail('user-123', 'new@trmnl.com');
        expect(queryMock).toHaveBeenCalledWith(
            'UPDATE "User" SET email = $1 WHERE id = $2',
            ['new@trmnl.com', 'user-123']
        );
    });

    it('getByEmail queries user by lowercased email column', async () => {
        queryMock.mockResolvedValueOnce({ rows: [{ id: 'user-123', email: 'test@trmnl.com' }] });
        const repo = new UserRepo();
        const user = await repo.getByEmail('TEST@trmnl.com');
        expect(user).toEqual({ id: 'user-123', email: 'test@trmnl.com' });
        expect(queryMock).toHaveBeenCalledWith(
            'SELECT * FROM "User" WHERE LOWER(email) = LOWER($1) ORDER BY id LIMIT 1',
            ['TEST@trmnl.com']
        );
    });
});

describe('UserRepo class methods (folded from module functions)', () => {
    beforeEach(() => {
        queryMock.mockReset();
    });

    it('getByAccessToken returns user row', async () => {
        queryMock.mockResolvedValueOnce({ rows: [{ id: 'u1', email: 'a@b.c', roles: ['user'] }] });
        const repo = new UserRepo();
        const result = await repo.getByAccessToken('tok-123');
        expect(result?.id).toBe('u1');
        expect(queryMock).toHaveBeenCalledWith(
            'SELECT id, email, roles FROM "User" WHERE access_token = $1',
            ['tok-123']
        );
    });

    it('getByAccessToken returns null on no rows', async () => {
        queryMock.mockResolvedValueOnce({ rows: [] });
        const repo = new UserRepo();
        const result = await repo.getByAccessToken('nope');
        expect(result).toBeNull();
    });

    it('getTokens returns access + refresh tokens', async () => {
        queryMock.mockResolvedValueOnce({
            rows: [{ access_token: 'a', refresh_token: 'r' }]
        });
        const repo = new UserRepo();
        const result = await repo.getTokens('u1');
        expect(result).toEqual({ access_token: 'a', refresh_token: 'r' });
        expect(queryMock).toHaveBeenCalledWith(
            'SELECT access_token, refresh_token, fleet_api_base_url FROM "User" WHERE id = $1',
            ['u1']
        );
    });

    it('getTokensForSite joins User and Site', async () => {
        queryMock.mockResolvedValueOnce({
            rows: [{ access_token: 'a', refresh_token: 'r', user_id: 'u1' }]
        });
        const repo = new UserRepo();
        const result = await repo.getTokensForSite('site-1');
        expect(result?.user_id).toBe('u1');
        expect(queryMock.mock.calls[0][0]).toContain('FROM "User" u');
        expect(queryMock.mock.calls[0][0]).toContain('JOIN "Site" s ON s.user_id = u.id');
        expect(queryMock.mock.calls[0][1]).toEqual(['site-1']);
    });

    it('isActive returns true when is_active is true', async () => {
        queryMock.mockResolvedValueOnce({ rows: [{ is_active: true }] });
        const repo = new UserRepo();
        expect(await repo.isActive('u1')).toBe(true);
    });

    it('isActive returns false when no row found', async () => {
        queryMock.mockResolvedValueOnce({ rows: [] });
        const repo = new UserRepo();
        expect(await repo.isActive('missing')).toBe(false);
    });
});

describe('UserRepo new commands', () => {
    beforeEach(() => {
        queryMock.mockReset();
    });

    it('getById returns full user row', async () => {
        queryMock.mockResolvedValueOnce({
            rows: [{ id: 'u1', email: 'a@b.c', roles: ['admin'], is_active: true }]
        });
        const repo = new UserRepo();
        const result = await repo.getById('u1');
        expect(result?.email).toBe('a@b.c');
        expect(queryMock).toHaveBeenCalledWith(
            'SELECT * FROM "User" WHERE id = $1',
            ['u1']
        );
    });

    it('getById returns null when not found', async () => {
        queryMock.mockResolvedValueOnce({ rows: [] });
        const repo = new UserRepo();
        expect(await repo.getById('nope')).toBeNull();
    });

    it('upsertOnTeslaAuth issues INSERT ... ON CONFLICT', async () => {
        queryMock.mockResolvedValueOnce({ rows: [] });
        const repo = new UserRepo();
        const expiresAt = Date.now() + 3600_000;
        await repo.upsertOnTeslaAuth({
            userId: 'u1',
            email: 'a@b.c',
            accessToken: 'at',
            refreshToken: 'rt',
            tokenExpiresAt: expiresAt,
        });
        expect(queryMock.mock.calls[0][0]).toContain('INSERT INTO "User"');
        expect(queryMock.mock.calls[0][0]).toContain('ON CONFLICT (id) DO UPDATE');
        expect(queryMock.mock.calls[0][1]).toEqual(['u1', 'a@b.c', 'at', 'rt', expiresAt, null]);
    });

    it('updateTokens updates access and refresh tokens', async () => {
        queryMock.mockResolvedValueOnce({ rows: [] });
        const repo = new UserRepo();
        await repo.updateTokens('u1', 'newA', 'newR');
        expect(queryMock).toHaveBeenCalledWith(
            'UPDATE "User" SET access_token = $1, refresh_token = $2 WHERE id = $3',
            ['newA', 'newR', 'u1']
        );
    });
});

describe('UserRepo.verifyUserStatus', () => {
    beforeEach(() => {
        queryMock.mockReset();
        queryMock.mockResolvedValueOnce({ rows: [{ auth_version: '100', auth_status: 'active', is_active: true }] });
        logEventMock.mockClear();
    });
    afterEach(() => { vi.restoreAllMocks(); });

    const UPDATE_STATUS_SQL = expect.stringContaining('WHERE id = $3 AND xmin::text = $4');

    it('keeps a revoked account inactive when the real refresh waiter observes revocation', async () => {
        const siteRepo = new SiteRepo();
        vi.spyOn(siteRepo, 'getSite').mockResolvedValue({
            id: 'site-1', user_id: 'u1', name: 'Home', timezone: 'America/Chicago',
            billing_start_day: 1, updated: new Date(), installed: new Date(), tariffs: [], json: null,
        });
        const tokens = new TeslaTokenRepo(siteRepo);
        queryMock
            .mockResolvedValueOnce({ rows: [{ id: 'site-1' }] })
            .mockResolvedValueOnce({ rows: [{ is_refreshing: 0, auth_status: 'revoked' }] })
            .mockResolvedValueOnce({ rows: [], rowCount: 1 });
        const client = { getLiveStatus: async () => {
            await tokens.waitForTokenRefresh('site-1');
            throw new Error('Unexpected waiter success');
        } };

        const result = await new UserRepo().verifyUserStatus({
            id: 'u1', auth_status: 'revoked', is_active: false,
        }, { createClient: async () => client });

        expect(result.status).toBe('revoked');
        expect(queryMock).toHaveBeenCalledWith(UPDATE_STATUS_SQL, ['revoked', false, 'u1', '100', 'site-1']);
        expect(queryMock).not.toHaveBeenCalledWith(UPDATE_STATUS_SQL, ['error', true, 'u1', '100', 'site-1']);
        expect(logEventMock).toHaveBeenCalledWith('warn', 'tesla.refresh.wait-revoked', expect.objectContaining({
            siteId: 'site-1', authStatus: 'revoked', waitedMs: expect.any(Number),
        }));
        const started = logEventMock.mock.calls.find(call => call[1] === 'tesla.user-verification.started');
        expect(logEventMock).toHaveBeenCalledWith('warn', 'tesla.user-verification.completed', expect.objectContaining({
            verificationId: started?.[2].verificationId, siteId: 'site-1',
            selectedAuthStatus: 'revoked', selectedIsActive: false,
            outcome: 'revoked', reason: 'terminal-auth-failure', durationMs: expect.any(Number),
        }));
    });

    it('logs an interrupted verification when client construction fails without changing account status', async () => {
        queryMock.mockResolvedValueOnce({ rows: [{ id: 'site-1' }] });
        const error = new Error('client construction failed');
        await expect(new UserRepo().verifyUserStatus({ id: 'u1' }, {
            createClient: async () => { throw error; },
        })).rejects.toBe(error);
        expect(queryMock).toHaveBeenCalledTimes(2);
        expect(logEventMock).toHaveBeenCalledWith('error', 'tesla.user-verification.failed', expect.objectContaining({
            siteId: 'site-1', phase: 'client-construction', reason: 'verification-interrupted', error,
        }));
        expect(logEventMock.mock.calls.some(call => call[1] === 'tesla.user-verification.completed')).toBe(false);
    });

    it('does not classify a failed status write as a Tesla failure or report a committed outcome', async () => {
        const error = Object.assign(new Error('database unavailable'), { code: '08006' });
        queryMock
            .mockResolvedValueOnce({ rows: [{ id: 'site-1' }] })
            .mockRejectedValueOnce(error);
        const client = { getLiveStatus: vi.fn().mockResolvedValue({ percentage_charged: 50 }) };
        await expect(new UserRepo().verifyUserStatus({ id: 'u1' }, {
            createClient: async () => client,
        })).rejects.toBe(error);
        expect(queryMock).toHaveBeenCalledTimes(3);
        expect(logEventMock).toHaveBeenCalledWith('error', 'tesla.user-verification.failed', expect.objectContaining({
            siteId: 'site-1', phase: 'status-write', error,
        }));
        expect(logEventMock.mock.calls.some(call => call[1] === 'tesla.user-verification.completed')).toBe(false);
    });

    it('keeps the user active when Tesla fails transiently', async () => {
        queryMock
            .mockResolvedValueOnce({ rows: [{ id: 'site-1' }] }) // site lookup
            .mockResolvedValueOnce({ rows: [], rowCount: 1 });                 // updateUserStatus
        const repo = new UserRepo();
        const client = { getLiveStatus: vi.fn().mockRejectedValue(new Error('Tesla API Error: 503 upstream unavailable')) };
        const result = await repo.verifyUserStatus({ id: 'u1' }, { createClient: async () => client as never });
        expect(result.status).toBe('error');
        expect(queryMock).toHaveBeenCalledWith(UPDATE_STATUS_SQL, ['error', true, 'u1', '100', 'site-1']);
        expect(logEventMock).toHaveBeenCalledWith('warn', 'tesla.user-verification.completed', expect.objectContaining({
            outcome: 'error', reason: 'transient-failure', siteId: 'site-1',
        }));
    });

    it('marks the user revoked and inactive on a terminal auth error', async () => {
        queryMock
            .mockResolvedValueOnce({ rows: [{ id: 'site-1' }] })
            .mockResolvedValueOnce({ rows: [], rowCount: 1 });
        const repo = new UserRepo();
        const client = { getLiveStatus: vi.fn().mockRejectedValue(new TeslaAuthError('Tesla API Error: 401 invalid token', 401)) };
        const result = await repo.verifyUserStatus({ id: 'u1' }, { createClient: async () => client as never });
        expect(result.status).toBe('revoked');
        expect(queryMock).toHaveBeenCalledWith(UPDATE_STATUS_SQL, ['revoked', false, 'u1', '100', 'site-1']);
    });

    it('marks the user active on success', async () => {
        queryMock
            .mockResolvedValueOnce({ rows: [{ id: 'site-1' }] })
            .mockResolvedValueOnce({ rows: [], rowCount: 1 });
        const repo = new UserRepo();
        const client = { getLiveStatus: vi.fn().mockResolvedValue({ percentage_charged: 50 }) };
        const result = await repo.verifyUserStatus({ id: 'u1' }, { createClient: async () => client as never });
        expect(result.status).toBe('active');
        expect(client.getLiveStatus).toHaveBeenCalledWith('site-1');
        expect(queryMock).toHaveBeenCalledWith(UPDATE_STATUS_SQL, ['active', true, 'u1', '100', 'site-1']);
    });

    it('marks no_token when the client factory finds no credentials', async () => {
        queryMock
            .mockResolvedValueOnce({ rows: [{ id: 'site-1' }] })
            .mockResolvedValueOnce({ rows: [], rowCount: 1 });
        const repo = new UserRepo();
        const result = await repo.verifyUserStatus({ id: 'u1' }, { createClient: async () => null });
        expect(result.status).toBe('no_token');
        expect(queryMock).toHaveBeenCalledWith(UPDATE_STATUS_SQL, ['no_token', false, 'u1', '100', 'site-1']);
    });

    it('marks no_sites when the user has no sites', async () => {
        queryMock
            .mockResolvedValueOnce({ rows: [] })  // site lookup: none
            .mockResolvedValueOnce({ rows: [], rowCount: 1 });
        const repo = new UserRepo();
        const result = await repo.verifyUserStatus({ id: 'u1' }, { createClient: async () => null });
        expect(result.status).toBe('no_sites');
        expect(queryMock).toHaveBeenCalledWith(UPDATE_STATUS_SQL, ['no_sites', false, 'u1', '100', null]);
    });
});


describe('UserRepo Fleet API base URL', () => {
    const EU = 'https://fleet-api.prd.eu.vn.cloud.tesla.com';

    beforeEach(() => {
        queryMock.mockReset();
        queryMock.mockResolvedValue({ rows: [] });
    });

    it('stores an allowlisted host', async () => {
        await new UserRepo().setFleetApiBaseUrl('user-1', `${EU}/`);
        expect(queryMock).toHaveBeenCalledWith(
            expect.stringContaining('SET fleet_api_base_url = $1'),
            [EU, 'user-1']
        );
    });

    it('never stores an unrecognized host', async () => {
        await new UserRepo().setFleetApiBaseUrl('user-1', 'https://evil.example.com');
        expect(queryMock).not.toHaveBeenCalled();
    });

    it('records the host on Tesla login, keeping the old one when unknown', async () => {
        const repo = new UserRepo();
        const base = { userId: 'u', email: null, accessToken: 'a', refreshToken: 'r', tokenExpiresAt: 1 };

        await repo.upsertOnTeslaAuth({ ...base, fleetApiBaseUrl: EU });
        await repo.upsertOnTeslaAuth({ ...base, fleetApiBaseUrl: 'https://evil.example.com' });

        expect(queryMock.mock.calls[0][0]).toContain('fleet_api_base_url = COALESCE(EXCLUDED.fleet_api_base_url, "User".fleet_api_base_url)');
        expect(queryMock.mock.calls[0][1]).toEqual(['u', null, 'a', 'r', 1, EU]);
        expect(queryMock.mock.calls[1][1]).toEqual(['u', null, 'a', 'r', 1, null]);
    });

    it('returns the stored host with tokens', async () => {
        const repo = new UserRepo();
        await repo.getTokens('u');
        await repo.getTokensForSite('s');
        expect(queryMock.mock.calls[0][0]).toContain('fleet_api_base_url');
        expect(queryMock.mock.calls[1][0]).toContain('u.fleet_api_base_url');
    });
});
