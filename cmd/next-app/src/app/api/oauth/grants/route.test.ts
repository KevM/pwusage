import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetCurrentUser = vi.fn();
const mockVerifySiteAccess = vi.fn();
const mockListGrants = vi.fn();
const mockCreateToken = vi.fn();

vi.mock('@/lib/auth-checks', () => ({
    getCurrentUser: () => mockGetCurrentUser(),
    verifySiteAccess: (...args: unknown[]) => mockVerifySiteAccess(...args),
}));
vi.mock('@/lib/oauth/oauth-repo', () => ({
    listUserOAuthGrantsForSite: (...args: unknown[]) => mockListGrants(...args),
    createIntegrationToken: (...args: unknown[]) => mockCreateToken(...args),
}));
vi.mock('@/lib/observability', () => ({
    observeRoute: (_route: string, fn: (req: NextRequest) => Promise<Response>) => fn,
}));

import { GET, POST } from './route';

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

describe('POST /api/oauth/grants', () => {
    const url = 'https://pwusage.fm.rodeo/api/oauth/grants';
    const post = (body: unknown, origin = 'https://pwusage.fm.rodeo') => POST(new NextRequest(url, {
        method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }));

    beforeEach(() => {
        vi.clearAllMocks();
        mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
        mockVerifySiteAccess.mockResolvedValue(true);
        mockCreateToken.mockResolvedValue({ grant: { id: 'g', kind: 'token' }, token: 'pwu_int_secret' });
    });

    it('rejects cross-origin', async () => {
        expect((await post({ siteId: 'site-1', name: 'Script' }, 'https://evil.example')).status).toBe(403);
        expect(mockCreateToken).not.toHaveBeenCalled();
    });

    it('returns 403 for another home', async () => {
        mockVerifySiteAccess.mockResolvedValue(false);
        expect((await post({ siteId: 'other', name: 'Script' })).status).toBe(403);
        expect(mockCreateToken).not.toHaveBeenCalled();
    });

    it('returns 400 for an 81-character name', async () => {
        const res = await post({ siteId: 'site-1', name: 'x'.repeat(81) });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: 'Enter a name up to 80 characters.' });
    });

    it('returns 201 with the token once', async () => {
        const res = await post({ siteId: 'site-1', name: '  Script  ' });
        expect(res.status).toBe(201);
        expect(res.headers.get('cache-control')).toBe('private, no-store');
        expect(await res.json()).toEqual({ grant: { id: 'g', kind: 'token' }, token: 'pwu_int_secret' });
        expect(mockCreateToken).toHaveBeenCalledWith('user-1', 'site-1', 'Script');
    });

    it('returns 401 when signed out', async () => {
        mockGetCurrentUser.mockResolvedValue(null);
        expect((await post({ siteId: 'site-1', name: 'Script' })).status).toBe(401);
    });
});
