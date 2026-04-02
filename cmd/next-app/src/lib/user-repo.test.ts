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
