import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetCurrentUser = vi.fn();
const mockGetCurrentSession = vi.fn();
const mockVerifySiteAccess = vi.fn();
const mockListGrants = vi.fn();
const mockCreateToken = vi.fn();
const mockAuthorizedSiteIds = vi.fn();

vi.mock('@/lib/auth-checks', () => ({
    getCurrentUser: () => mockGetCurrentUser(),
    getCurrentSession: () => mockGetCurrentSession(),
    verifySiteAccess: (...args: unknown[]) => mockVerifySiteAccess(...args),
    getAuthorizedSiteIds: () => mockAuthorizedSiteIds(),
}));
vi.mock('@/lib/oauth/oauth-repo', () => ({
    listUserOAuthGrantsForSite: (...args: unknown[]) => mockListGrants(...args),
    createIntegrationToken: (...args: unknown[]) => mockCreateToken(...args),
    MAX_ACTIVE_INTEGRATION_TOKENS_PER_SITE: 5,
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
        mockGetCurrentSession.mockResolvedValue({ id: 'user-1', sessionVersion: 7 });
        mockAuthorizedSiteIds.mockResolvedValue(['site-1']);
        mockCreateToken.mockResolvedValue({ status: 'created', grant: { id: 'g', kind: 'token' }, token: 'pwu_int_secret' });
    });

    it('rejects cross-origin', async () => {
        expect((await post({ siteId: 'site-1', name: 'Script' }, 'https://evil.example')).status).toBe(403);
        expect(mockCreateToken).not.toHaveBeenCalled();
    });

    it('returns 403 for another home', async () => {
        mockAuthorizedSiteIds.mockResolvedValue(['site-1']);
        expect((await post({ siteId: 'other', name: 'Script' })).status).toBe(403);
        expect(mockCreateToken).not.toHaveBeenCalled();
    });

    // verifySiteAccess lets admins into any home, but a token only works for a
    // home the user is a member of, so it would 401 on every poll.
    it('returns 403 for an admin who is not a member of the home', async () => {
        mockVerifySiteAccess.mockResolvedValue(true);
        mockAuthorizedSiteIds.mockResolvedValue(['site-1']);
        expect((await post({ siteId: 'site-2', name: 'Script' })).status).toBe(403);
        expect(mockCreateToken).not.toHaveBeenCalled();
    });

    it('returns 413 for a body over 16 KB', async () => {
        const res = await post({ siteId: 'site-1', name: 'Script', padding: 'x'.repeat(16_384) });
        expect(res.status).toBe(413);
        expect(mockCreateToken).not.toHaveBeenCalled();
    });

    it('returns 409 when the home already has the most tokens allowed', async () => {
        mockCreateToken.mockResolvedValue({ status: 'limit' });
        const res = await post({ siteId: 'site-1', name: 'Script' });
        expect(res.status).toBe(409);
        expect(await res.json()).toEqual({ error: 'This home already has 5 integration tokens. Revoke one first.' });
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
        expect(mockCreateToken).toHaveBeenCalledWith('user-1', 'site-1', 'Script', 7);
    });

    it('returns 401 when the session ended before the token was written', async () => {
        mockCreateToken.mockResolvedValue({ status: 'session-ended' });
        const res = await post({ siteId: 'site-1', name: 'Script' });
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: 'Your session ended. Sign in again to create a token.' });
    });

    it('returns 401 when signed out', async () => {
        mockGetCurrentSession.mockResolvedValue(null);
        expect((await post({ siteId: 'site-1', name: 'Script' })).status).toBe(401);
    });
});
