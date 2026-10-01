import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queryMock, connectMock, clientQueryMock, releaseMock } = vi.hoisted(() => ({
    queryMock: vi.fn(),
    connectMock: vi.fn(),
    clientQueryMock: vi.fn(),
    releaseMock: vi.fn()
}));

vi.mock('./db', () => ({
    pool: {
        query: queryMock,
        connect: connectMock
    }
}));

import { UserRepo } from './user-repo';
import { TeslaAuthError } from './tesla-client';

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
            'SELECT access_token, refresh_token FROM "User" WHERE id = $1',
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
        expect(queryMock.mock.calls[0][0].split('ON CONFLICT')[1]).not.toContain('history_retention');
        expect(queryMock.mock.calls[0][1]).toEqual(['u1', 'a@b.c', 'at', 'rt', expiresAt, true]);
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
    });

    const UPDATE_STATUS_SQL = 'UPDATE "User" SET auth_status = $1, is_active = $2, last_checked_at = NOW() WHERE id = $3';

    it('keeps the user active when Tesla fails transiently', async () => {
        queryMock
            .mockResolvedValueOnce({ rows: [{ id: 'site-1' }] }) // site lookup
            .mockResolvedValueOnce({ rows: [] });                 // updateUserStatus
        const repo = new UserRepo();
        const client = { getLiveStatus: vi.fn().mockRejectedValue(new Error('Tesla API Error: 503 upstream unavailable')) };
        const result = await repo.verifyUserStatus({ id: 'u1' }, { createClient: async () => client as never });
        expect(result.status).toBe('error');
        expect(queryMock).toHaveBeenCalledWith(UPDATE_STATUS_SQL, ['error', true, 'u1']);
    });

    it('marks the user revoked and inactive on a terminal auth error', async () => {
        queryMock
            .mockResolvedValueOnce({ rows: [{ id: 'site-1' }] })
            .mockResolvedValueOnce({ rows: [] });
        const repo = new UserRepo();
        const client = { getLiveStatus: vi.fn().mockRejectedValue(new TeslaAuthError('Tesla API Error: 401 invalid token', 401)) };
        const result = await repo.verifyUserStatus({ id: 'u1' }, { createClient: async () => client as never });
        expect(result.status).toBe('revoked');
        expect(queryMock).toHaveBeenCalledWith(UPDATE_STATUS_SQL, ['revoked', false, 'u1']);
    });

    it('marks the user active on success', async () => {
        queryMock
            .mockResolvedValueOnce({ rows: [{ id: 'site-1' }] })
            .mockResolvedValueOnce({ rows: [] });
        const repo = new UserRepo();
        const client = { getLiveStatus: vi.fn().mockResolvedValue({ percentage_charged: 50 }) };
        const result = await repo.verifyUserStatus({ id: 'u1' }, { createClient: async () => client as never });
        expect(result.status).toBe('active');
        expect(client.getLiveStatus).toHaveBeenCalledWith('site-1');
        expect(queryMock).toHaveBeenCalledWith(UPDATE_STATUS_SQL, ['active', true, 'u1']);
    });

    it('marks no_token when the client factory finds no credentials', async () => {
        queryMock
            .mockResolvedValueOnce({ rows: [{ id: 'site-1' }] })
            .mockResolvedValueOnce({ rows: [] });
        const repo = new UserRepo();
        const result = await repo.verifyUserStatus({ id: 'u1' }, { createClient: async () => null });
        expect(result.status).toBe('no_token');
        expect(queryMock).toHaveBeenCalledWith(UPDATE_STATUS_SQL, ['no_token', false, 'u1']);
    });

    it('marks no_sites when the user has no sites', async () => {
        queryMock
            .mockResolvedValueOnce({ rows: [] })  // site lookup: none
            .mockResolvedValueOnce({ rows: [] });
        const repo = new UserRepo();
        const result = await repo.verifyUserStatus({ id: 'u1' }, { createClient: async () => null });
        expect(result.status).toBe('no_sites');
        expect(queryMock).toHaveBeenCalledWith(UPDATE_STATUS_SQL, ['no_sites', false, 'u1']);
    });
});



describe('UserRepo history retention assignments', () => {
    const base = { history_retention_days: 365, history_retention_grace_until: null, history_retention_transition_pending: false };
    const now = new Date('2026-10-01T18:00:00Z');
    beforeEach(() => {
        queryMock.mockReset();
        connectMock.mockReset();
        clientQueryMock.mockReset();
        releaseMock.mockReset();
        connectMock.mockResolvedValue({ query: clientQueryMock, release: releaseMock });
        clientQueryMock.mockImplementation(async (sql: string) => ({ rows: sql.includes('SELECT') ? [base] : [] }));
    });
    it('previews without connecting for a write transaction', async () => {
        queryMock.mockResolvedValue({ rows: [base] });
        const result = await new UserRepo().setHistoryRetention('u1', 90, { now });
        expect(result.after.history_retention_grace_until).toEqual(new Date('2026-10-31T18:00:00Z'));
        expect(connectMock).not.toHaveBeenCalled();
        expect(queryMock).toHaveBeenCalledTimes(1);
        expect(queryMock.mock.calls[0][0]).not.toContain('access_token');
    });
    it('locks and updates only the requested account in one transaction', async () => {
        const result = await new UserRepo().setHistoryRetention('u1', 90, { apply: true, now });
        expect(result.after.history_retention_days).toBe(90);
        expect(clientQueryMock.mock.calls[0][0]).toBe('BEGIN');
        expect(clientQueryMock.mock.calls[1][0]).toContain('FOR UPDATE');
        expect(clientQueryMock.mock.calls[2][1]).toEqual([90, new Date('2026-10-31T18:00:00Z'), false, 'u1']);
        expect(clientQueryMock.mock.calls[3][0]).toBe('COMMIT');
        expect(releaseMock).toHaveBeenCalledOnce();
    });
    it('rejects a missing account and rolls back before releasing', async () => {
        clientQueryMock.mockResolvedValue({ rows: [] });
        await expect(new UserRepo().setHistoryRetention('missing', 90, { apply: true, now })).rejects.toThrow('not found');
        expect(clientQueryMock.mock.calls.map(call => call[0])).not.toContain('COMMIT');
        expect(clientQueryMock.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
        expect(releaseMock).toHaveBeenCalledOnce();
    });
    it('rejects invalid days before any database access', async () => {
        await expect(new UserRepo().setHistoryRetention('u1', 180, { apply: true, now })).rejects.toThrow();
        expect(connectMock).not.toHaveBeenCalled();
        expect(queryMock).not.toHaveBeenCalled();
    });
    it('rolls back an update failure and releases the lock', async () => {
        clientQueryMock.mockImplementation(async (sql: string) => {
            if (sql.includes('UPDATE "User"')) throw new Error('write failed');
            return { rows: sql.includes('SELECT') ? [base] : [] };
        });
        await expect(new UserRepo().setHistoryRetention('u1', 90, { apply: true, now })).rejects.toThrow('write failed');
        expect(clientQueryMock.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
        expect(releaseMock).toHaveBeenCalledOnce();
    });
    it('bootstraps only a pending existing account and leaves a new one unchanged', async () => {
        queryMock.mockResolvedValueOnce({ rows: [{ ...base, history_retention_days: 90, history_retention_transition_pending: true }] });
        const repo = new UserRepo();
        const preview = await repo.bootstrapHistoryRetention('u1', now);
        expect(preview.after.history_retention_grace_until).toEqual(new Date('2026-10-31T18:00:00Z'));
        queryMock.mockResolvedValueOnce({ rows: [{ ...base, history_retention_days: 90 }] });
        expect((await repo.bootstrapHistoryRetention('new', now)).after.history_retention_grace_until).toBeNull();
    });
});
