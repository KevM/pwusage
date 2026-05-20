import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queryMock } = vi.hoisted(() => ({
    queryMock: vi.fn()
}));

vi.mock('./db', () => ({
    pool: {
        query: queryMock
    }
}));

import { UserRepo } from './user-repo';

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
});

