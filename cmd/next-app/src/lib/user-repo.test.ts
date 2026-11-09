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
import { decryptToken, encryptToken, isEncryptedToken, tokenFingerprint } from './token-crypto';

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

    it('includes each member in admin site summaries after the cutover', async () => {
        vi.stubEnv('SITE_MEMBERSHIP_ENABLED', 'true');
        try {
            queryMock.mockResolvedValueOnce({ rows: [{ id: 'owner' }, { id: 'invited' }] });
            queryMock.mockResolvedValueOnce({ rows: [
                { id: 'home', user_id: 'owner' },
                { id: 'home', user_id: 'invited' },
            ] });
            const users = await new UserRepo().getAllUsers();
            expect(users.map(user => user.sites.map(site => site.id))).toEqual([['home'], ['home']]);
            expect(queryMock.mock.calls[0][0]).toContain('"SiteMember" m');
            expect(queryMock.mock.calls[1][0]).toContain('JOIN "SiteMember" m ON m.site_id = s.id');
        } finally {
            vi.unstubAllEnvs();
        }
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

    it('getTokens returns access + refresh tokens', async () => {
        queryMock.mockResolvedValueOnce({
            rows: [{ access_token: 'a', refresh_token: 'r' }]
        });
        const repo = new UserRepo();
        const result = await repo.getTokens('u1');
        expect(result).toEqual({ access_token: 'a', refresh_token: 'r' });
        expect(queryMock).toHaveBeenCalledWith(
            expect.stringContaining('SELECT access_token, refresh_token, fleet_api_base_url'),
            ['u1']
        );
    });

    it('getTokens decrypts encrypted tokens and passes legacy plaintext through', async () => {
        queryMock.mockResolvedValueOnce({
            rows: [{ access_token: encryptToken('a', 'access_token', 'u1'), refresh_token: encryptToken('r', 'refresh_token', 'u1') }]
        });
        const repo = new UserRepo();
        expect(await repo.getTokens('u1')).toEqual({ access_token: 'a', refresh_token: 'r' });
        queryMock.mockResolvedValueOnce({ rows: [{ access_token: 'legacy-a', refresh_token: 'legacy-r' }] });
        expect(await repo.getTokens('u1')).toEqual({ access_token: 'legacy-a', refresh_token: 'legacy-r' });
    });

    it('getTokensForSite decrypts using the owning user id', async () => {
        queryMock.mockResolvedValueOnce({
            rows: [{ access_token: encryptToken('a', 'access_token', 'u1'), refresh_token: encryptToken('r', 'refresh_token', 'u1'), user_id: 'u1' }]
        });
        const result = await new UserRepo().getTokensForSite('site-1');
        expect(result?.access_token).toBe('a');
        expect(result?.refresh_token).toBe('r');
    });

    it('getById and getByEmail decrypt tokens on the row', async () => {
        const row = () => ({ id: 'u1', access_token: encryptToken('a', 'access_token', 'u1'), refresh_token: encryptToken('r', 'refresh_token', 'u1') });
        queryMock.mockResolvedValueOnce({ rows: [row()] }).mockResolvedValueOnce({ rows: [row()] });
        const repo = new UserRepo();
        expect((await repo.getById('u1'))?.refresh_token).toBe('r');
        expect((await repo.getByEmail('a@b.c'))?.access_token).toBe('a');
    });

    it('getTokensForSite joins User and Site', async () => {
        queryMock.mockResolvedValueOnce({
            rows: [{ access_token: 'a', refresh_token: 'r', user_id: 'u1' }]
        });
        const repo = new UserRepo();
        const result = await repo.getTokensForSite('site-1');
        expect(result?.user_id).toBe('u1');
        expect(queryMock.mock.calls[0][0]).toContain('FROM "User" u');
        expect(queryMock.mock.calls[0][0]).toContain('JOIN "Site" s ON s.tesla_connection_user_id = u.id');
        expect(queryMock.mock.calls[0][0]).toContain('JOIN "SiteMember" m ON m.site_id = s.id AND m.user_id = u.id');
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
        const params = queryMock.mock.calls[0][1];
        expect(queryMock.mock.calls[0][0]).toContain('refresh_token_fp');
        expect(params.slice(0, 2)).toEqual(['u1', 'a@b.c']);
        expect(isEncryptedToken(params[2])).toBe(true);
        expect(isEncryptedToken(params[3])).toBe(true);
        expect(decryptToken(params[2], 'access_token', 'u1')).toBe('at');
        expect(decryptToken(params[3], 'refresh_token', 'u1')).toBe('rt');
        expect(params.slice(4, 6)).toEqual([expiresAt, null]);
        expect(params[6]).toBe(tokenFingerprint('rt'));
    });

    it('updateTokens updates access and refresh tokens', async () => {
        queryMock.mockResolvedValueOnce({ rows: [] });
        const repo = new UserRepo();
        await repo.updateTokens('u1', 'newA', 'newR');
        const [sql, params] = queryMock.mock.calls[0];
        expect(sql).toBe('UPDATE "User" SET access_token = $1, refresh_token = $2, refresh_token_fp = $4 WHERE id = $3');
        expect(decryptToken(params[0], 'access_token', 'u1')).toBe('newA');
        expect(decryptToken(params[1], 'refresh_token', 'u1')).toBe('newR');
        expect(isEncryptedToken(params[0]) && isEncryptedToken(params[1])).toBe(true);
        expect(params.slice(2)).toEqual(['u1', tokenFingerprint('newR')]);
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

    it('checks the member row and fences the status write to that membership', async () => {
        vi.stubEnv('SITE_MEMBERSHIP_ENABLED', 'true');
        try {
            queryMock.mockResolvedValueOnce({ rows: [{ id: 'shared-home' }] })
                .mockResolvedValueOnce({ rowCount: 1, rows: [] });
            const result = await new UserRepo().verifyUserStatus({ id: 'u1' }, {
                createClient: async () => ({ getLiveStatus: async () => ({}) }) as never,
            });
            expect(result.status).toBe('active');
            expect(queryMock.mock.calls[1][0]).toContain('FROM "SiteMember" WHERE user_id = $1');
            expect(queryMock.mock.calls[2][0]).toContain('SELECT 1 FROM "SiteMember" WHERE site_id = $5 AND user_id = $3');
        } finally {
            vi.unstubAllEnvs();
        }
    });

    it('does not turn a connection-required response into account ineligibility', async () => {
        queryMock.mockResolvedValueOnce({ rows: [{ id: 'site-1' }] }).mockResolvedValueOnce({ rowCount: 1, rows: [] });
        const result = await new UserRepo().verifyUserStatus({ id: 'u1' }, {
            createClient: async () => ({ getLiveStatus: async () => { throw new Error('Connection unavailable'); } }),
        });
        expect(result.status).toBe('error');
        expect(queryMock).toHaveBeenCalledWith(UPDATE_STATUS_SQL, ['error', true, 'u1', '100', 'site-1', expect.any(Number), 120_000]);
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
        expect(queryMock).toHaveBeenCalledWith(UPDATE_STATUS_SQL, ['error', true, 'u1', '100', 'site-1', expect.any(Number), 120_000]);
        expect(logEventMock).toHaveBeenCalledWith('warn', 'tesla.user-verification.completed', expect.objectContaining({
            outcome: 'error', reason: 'transient-failure', siteId: 'site-1',
        }));
    });

    it('records a Fleet access rejection without claiming refresh revocation', async () => {
        queryMock
            .mockResolvedValueOnce({ rows: [{ id: 'site-1' }] })
            .mockResolvedValueOnce({ rows: [], rowCount: 1 });
        const repo = new UserRepo();
        const client = { getLiveStatus: vi.fn().mockRejectedValue(new TeslaAuthError('Tesla API Error: 401 invalid token', 401)) };
        const result = await repo.verifyUserStatus({ id: 'u1' }, { createClient: async () => client as never });
        expect(result.status).toBe('error');
        expect(queryMock).toHaveBeenCalledWith(UPDATE_STATUS_SQL, ['error', true, 'u1', '100', 'site-1', expect.any(Number), 120_000]);
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
        expect(queryMock).toHaveBeenCalledWith(UPDATE_STATUS_SQL, ['active', true, 'u1', '100', 'site-1', expect.any(Number), 120_000]);
    });

    it('marks no_token when the client factory finds no credentials', async () => {
        queryMock
            .mockResolvedValueOnce({ rows: [{ id: 'site-1' }] })
            .mockResolvedValueOnce({ rows: [], rowCount: 1 });
        const repo = new UserRepo();
        const result = await repo.verifyUserStatus({ id: 'u1' }, { createClient: async () => null });
        expect(result.status).toBe('no_token');
        expect(queryMock).toHaveBeenCalledWith(UPDATE_STATUS_SQL, ['no_token', true, 'u1', '100', 'site-1', expect.any(Number), 120_000]);
    });

    it('marks no_sites when the user has no sites', async () => {
        queryMock
            .mockResolvedValueOnce({ rows: [] })  // site lookup: none
            .mockResolvedValueOnce({ rows: [], rowCount: 1 });
        const repo = new UserRepo();
        const result = await repo.verifyUserStatus({ id: 'u1' }, { createClient: async () => null });
        expect(result.status).toBe('no_sites');
        expect(queryMock).toHaveBeenCalledWith(UPDATE_STATUS_SQL, ['no_sites', true, 'u1', '100', null, expect.any(Number), 120_000]);
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
        expect(queryMock.mock.calls[0][1][5]).toBe(EU);
        expect(queryMock.mock.calls[1][1][5]).toBeNull();
    });

    it('returns the stored host with tokens', async () => {
        const repo = new UserRepo();
        await repo.getTokens('u');
        await repo.getTokensForSite('s');
        expect(queryMock.mock.calls[0][0]).toContain('fleet_api_base_url');
        expect(queryMock.mock.calls[1][0]).toContain('u.fleet_api_base_url');
    });
});
