import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetCurrentUser = vi.fn();
const mockIsSameOriginPost = vi.fn();
const mockRevokeUserOAuthGrant = vi.fn();

vi.mock('@/lib/auth-checks', () => ({
    getCurrentUser: () => mockGetCurrentUser(),
}));

vi.mock('@/lib/oauth/csrf', () => ({
    isSameOriginPost: (...args: unknown[]) => mockIsSameOriginPost(...args),
}));

vi.mock('@/lib/oauth/oauth-repo', () => ({
    revokeUserOAuthGrant: (...args: unknown[]) => mockRevokeUserOAuthGrant(...args),
}));

vi.mock('@/lib/observability', () => ({
    logEvent: vi.fn(),
}));

import { DELETE } from './route';

describe('DELETE /api/oauth/grants/[id]', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockIsSameOriginPost.mockReturnValue(true);
        mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
        mockRevokeUserOAuthGrant.mockResolvedValue(true);
    });

    it('rejects cross-origin requests with 403', async () => {
        mockIsSameOriginPost.mockReturnValueOnce(false);
        const res = await DELETE(
            new Request('https://pwusage.fm.rodeo/api/oauth/grants/11111111-1111-1111-1111-111111111111', {
                method: 'DELETE',
            }),
            { params: Promise.resolve({ id: '11111111-1111-1111-1111-111111111111' }) },
        );
        expect(res.status).toBe(403);
        expect(mockRevokeUserOAuthGrant).not.toHaveBeenCalled();
    });

    it('rejects non-UUID grant ids with 400 before hitting Postgres', async () => {
        const res = await DELETE(
            new Request('https://pwusage.fm.rodeo/api/oauth/grants/not-a-uuid', {
                method: 'DELETE',
                headers: { Origin: 'https://pwusage.fm.rodeo' },
            }),
            { params: Promise.resolve({ id: 'not-a-uuid' }) },
        );
        expect(res.status).toBe(400);
        expect(mockRevokeUserOAuthGrant).not.toHaveBeenCalled();
    });

    it('revokes valid UUID grant for authenticated same-origin user', async () => {
        const id = '11111111-1111-1111-1111-111111111111';
        const res = await DELETE(
            new Request(`https://pwusage.fm.rodeo/api/oauth/grants/${id}`, {
                method: 'DELETE',
                headers: { Origin: 'https://pwusage.fm.rodeo' },
            }),
            { params: Promise.resolve({ id }) },
        );
        expect(res.status).toBe(200);
        expect(mockRevokeUserOAuthGrant).toHaveBeenCalledWith('user-1', id);
    });

    it('marks grant responses private and uncacheable', async () => {
        const res = await DELETE(new Request('https://pwusage.fm.rodeo/api/oauth/grants/0b6f3e1a-2c4d-4e5f-8a9b-1c2d3e4f5a6b', {
            method: 'DELETE', headers: { Origin: 'https://pwusage.fm.rodeo' },
        }), { params: Promise.resolve({ id: '0b6f3e1a-2c4d-4e5f-8a9b-1c2d3e4f5a6b' }) });
        expect(res.headers.get('cache-control')).toBe('private, no-store');
    });
});
