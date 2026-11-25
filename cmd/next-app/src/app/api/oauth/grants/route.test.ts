import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetCurrentUser = vi.fn();
const mockVerifySiteAccess = vi.fn();
const mockListGrants = vi.fn();

vi.mock('@/lib/auth-checks', () => ({
    getCurrentUser: () => mockGetCurrentUser(),
    verifySiteAccess: (...args: unknown[]) => mockVerifySiteAccess(...args),
}));
vi.mock('@/lib/oauth/oauth-repo', () => ({
    listUserOAuthGrantsForSite: (...args: unknown[]) => mockListGrants(...args),
}));
vi.mock('@/lib/observability', () => ({
    observeRoute: (_route: string, fn: (req: NextRequest) => Promise<Response>) => fn,
}));

import { GET } from './route';

describe('GET /api/oauth/grants', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
        mockVerifySiteAccess.mockResolvedValue(true);
        mockListGrants.mockResolvedValue([]);
    });

    it('marks the grant list private and uncacheable', async () => {
        const res = await GET(new NextRequest('https://pwusage.fm.rodeo/api/oauth/grants?siteId=site-1'));
        expect(res.status).toBe(200);
        expect(res.headers.get('cache-control')).toBe('private, no-store');
    });
});
