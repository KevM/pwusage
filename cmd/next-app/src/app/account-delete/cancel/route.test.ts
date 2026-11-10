import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ getCurrentUser: vi.fn() }));
vi.mock('@/lib/auth-checks', () => ({ getCurrentUser: mocks.getCurrentUser }));

import { GET } from './route';

describe('GET /account-delete/cancel', () => {
    beforeEach(() => { vi.clearAllMocks(); });

    it.each([[{ id: 'user-1' }], [null]])('returns to the profile page for %j', async user => {
        mocks.getCurrentUser.mockResolvedValue(user);
        const response = await GET(new NextRequest('https://pwusage.test/account-delete/cancel'));
        expect(response.status).toBe(303);
        expect(response.headers.get('location')).toBe('https://pwusage.test/profile');
    });
});
