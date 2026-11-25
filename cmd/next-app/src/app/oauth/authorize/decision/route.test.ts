import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetCurrentUser = vi.fn();
const mockGetAuthorizedSiteIds = vi.fn();
const mockResolveOAuthClient = vi.fn();
const mockCreateAuthCode = vi.fn();
const mockRefreshTodayData = vi.fn();
const mockVerifyCsrf = vi.fn();
const mockVerifySameOrigin = vi.fn();

vi.mock('@/lib/auth-checks', () => ({
    getCurrentUser: () => mockGetCurrentUser(),
    getAuthorizedSiteIds: () => mockGetAuthorizedSiteIds(),
}));

vi.mock('@/lib/oauth/client-resolver', () => ({
    resolveOAuthClient: (...args: unknown[]) => mockResolveOAuthClient(...args),
}));

vi.mock('@/lib/oauth/oauth-repo', () => ({
    createAuthCode: (...args: unknown[]) => mockCreateAuthCode(...args),
}));

vi.mock('@/lib/today-refresh', () => ({
    refreshTodayData: (...args: unknown[]) => mockRefreshTodayData(...args),
}));

vi.mock('@/lib/oauth/csrf', () => ({
    verifyOAuthCsrfToken: (...args: unknown[]) => mockVerifyCsrf(...args),
    isSameOriginPost: (...args: unknown[]) => mockVerifySameOrigin(...args),
}));

vi.mock('@/lib/observability', () => ({
    observeRoute: (_route: string, fn: (req: Request) => Promise<Response>) => fn,
    logEvent: vi.fn(),
}));

import { POST } from './route';

describe('POST /oauth/authorize/decision', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        process.env.NEXT_PUBLIC_APP_URL = 'https://pwusage.fm.rodeo';
        mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
        mockGetAuthorizedSiteIds.mockResolvedValue(['site-1', 'site-2']);
        mockVerifySameOrigin.mockReturnValue(true);
        mockVerifyCsrf.mockResolvedValue(true);
        mockResolveOAuthClient.mockResolvedValue({
            clientId: 'pwu_client_1',
            clientName: 'Claude',
            redirectUris: ['https://claude.ai/cb'],
            clientUri: null,
            kind: 'dcr',
        });
        mockCreateAuthCode.mockResolvedValue({
            code: 'auth-code-123',
            expiresAt: new Date(Date.now() + 300_000),
        });
        mockRefreshTodayData.mockResolvedValue({ status: 'ok' });
    });

    function makeRequest(params: Record<string, string | string[]>): Request {
        const form = new URLSearchParams();
        for (const [key, value] of Object.entries(params)) {
            if (Array.isArray(value)) {
                for (const item of value) form.append(key, item);
            } else {
                form.set(key, value);
            }
        }
        return new Request('https://pwusage.fm.rodeo/oauth/authorize/decision', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Origin: 'https://pwusage.fm.rodeo',
            },
            body: form.toString(),
        });
    }

    const validBase = {
        csrf_token: 'csrf-ok',
        client_id: 'pwu_client_1',
        redirect_uri: 'https://claude.ai/cb',
        state: 'st-1',
        code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
        code_challenge_method: 'S256',
        resource: 'https://pwusage.fm.rodeo/api/mcp',
        scope: 'billing:read usage:read',
        decision: 'allow',
        site_ids: ['site-1'],
    };

    it('rejects cross-origin or invalid CSRF token with 403', async () => {
        mockVerifySameOrigin.mockReturnValueOnce(false);
        const crossOriginRes = await POST(makeRequest(validBase));
        expect(crossOriginRes.status).toBe(403);

        mockVerifyCsrf.mockResolvedValueOnce(false);
        const badCsrfRes = await POST(makeRequest(validBase));
        expect(badCsrfRes.status).toBe(403);
        // The token is checked against the exact request the consent screen rendered.
        expect(mockVerifyCsrf).toHaveBeenLastCalledWith('csrf-ok', expect.any(String), {
            clientId: 'pwu_client_1',
            redirectUri: 'https://claude.ai/cb',
            codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
            resource: 'https://pwusage.fm.rodeo/api/mcp',
            scope: 'billing:read usage:read',
        });
    });

    it('redirects with error=access_denied when decision is deny', async () => {
        const res = await POST(makeRequest({ ...validBase, decision: 'deny' }));
        expect(res.status).toBe(303);
        expect(res.headers.get('location')).toBe('https://claude.ai/cb?error=access_denied&state=st-1');
        expect(mockCreateAuthCode).not.toHaveBeenCalled();
    });

    it('validates site_ids subset, creates auth code, and redirects with code & state', async () => {
        const res = await POST(makeRequest({ ...validBase, site_ids: ['site-1', 'site-999'] }));
        expect(res.status).toBe(400);
        expect(mockCreateAuthCode).not.toHaveBeenCalled();

        const okRes = await POST(makeRequest(validBase));
        expect(okRes.status).toBe(303);
        expect(okRes.headers.get('location')).toBe('https://claude.ai/cb?code=auth-code-123&state=st-1');
        expect(mockCreateAuthCode).toHaveBeenCalledWith(expect.objectContaining({
            clientId: 'pwu_client_1',
            userId: 'user-1',
            siteIds: ['site-1'],
        }));
    });

    it('defaults omitted resource to canonical MCP endpoint', async () => {
        const { resource: _omitted, ...withoutResource } = validBase;
        void _omitted;
        const okRes = await POST(makeRequest(withoutResource));
        expect(okRes.status).toBe(303);
        expect(mockCreateAuthCode).toHaveBeenCalledWith(expect.objectContaining({
            resource: 'https://pwusage.fm.rodeo/api/mcp',
        }));
    });

    it('returns 400 without redirecting when client_id or redirect_uri is invalid', async () => {
        const res = await POST(makeRequest({
            ...validBase,
            redirect_uri: 'https://evil.example/cb',
        }));
        expect(res.status).toBe(400);
        expect(res.headers.get('location')).toBeNull();
    });
});
