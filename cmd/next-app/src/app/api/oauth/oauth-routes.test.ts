import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRegisterDcrClient = vi.fn();
const mockExchangeAuthCode = vi.fn();
const mockRotateRefreshToken = vi.fn();
const mockRevokeOAuthToken = vi.fn();

vi.mock('@/lib/oauth/oauth-repo', () => ({
    registerDcrClient: (...args: unknown[]) => mockRegisterDcrClient(...args),
    exchangeAuthCode: (...args: unknown[]) => mockExchangeAuthCode(...args),
    rotateRefreshToken: (...args: unknown[]) => mockRotateRefreshToken(...args),
    revokeOAuthToken: (...args: unknown[]) => mockRevokeOAuthToken(...args),
}));

vi.mock('@/lib/observability', () => ({
    observeRoute: (_route: string, fn: (req: Request) => Promise<Response>) => fn,
    logEvent: vi.fn(),
    errorFields: () => ({}),
}));

import { GET as getProtectedResource } from '@/app/.well-known/oauth-protected-resource/route';
import { GET as getAuthServerMetadata } from '@/app/.well-known/oauth-authorization-server/route';
import { POST as postRegister } from '@/app/api/oauth/register/route';
import { POST as postToken } from '@/app/api/oauth/token/route';
import { POST as postRevoke } from '@/app/api/oauth/revoke/route';

describe('oauth routes', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        process.env.NEXT_PUBLIC_APP_URL = 'https://pwusage.fm.rodeo';
    });

    it('GET /.well-known/oauth-protected-resource returns RFC 9728 metadata', async () => {
        const res = await getProtectedResource(new Request('https://pwusage.fm.rodeo/.well-known/oauth-protected-resource'));
        expect(res.status).toBe(200);
        expect(res.headers.get('access-control-allow-origin')).toBe('*');
        const body = await res.json();
        expect(body).toEqual({
            resource: 'https://pwusage.fm.rodeo/api/mcp',
            authorization_servers: ['https://pwusage.fm.rodeo'],
            scopes_supported: ['billing:read', 'usage:read'],
            bearer_methods_supported: ['header'],
        });
    });

    it('GET /.well-known/oauth-authorization-server returns RFC 8414 metadata', async () => {
        const res = await getAuthServerMetadata(new Request('https://pwusage.fm.rodeo/.well-known/oauth-authorization-server'));
        expect(res.status).toBe(200);
        expect(res.headers.get('access-control-allow-origin')).toBe('*');
        const body = await res.json();
        expect(body).toMatchObject({
            issuer: 'https://pwusage.fm.rodeo',
            authorization_endpoint: 'https://pwusage.fm.rodeo/oauth/authorize',
            token_endpoint: 'https://pwusage.fm.rodeo/api/oauth/token',
            registration_endpoint: 'https://pwusage.fm.rodeo/api/oauth/register',
            revocation_endpoint: 'https://pwusage.fm.rodeo/api/oauth/revoke',
            response_types_supported: ['code'],
            grant_types_supported: ['authorization_code', 'refresh_token'],
            code_challenge_methods_supported: ['S256'],
            token_endpoint_auth_methods_supported: ['none'],
            scopes_supported: ['billing:read', 'usage:read'],
            client_id_metadata_document_supported: true,
        });
    });

    it('POST /api/oauth/register accepts valid DCR payload and rejects invalid auth method or redirect_uri', async () => {
        mockRegisterDcrClient.mockResolvedValueOnce({
            clientId: 'pwu_client_123',
            clientName: 'Cursor',
            redirectUris: ['cursor://anysphere.cursor-mcp/oauth/callback'],
            clientUri: null,
            kind: 'dcr',
        });

        const okRes = await postRegister(new Request('https://pwusage.fm.rodeo/api/oauth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.10' },
            body: JSON.stringify({
                client_name: 'Cursor',
                redirect_uris: ['cursor://anysphere.cursor-mcp/oauth/callback'],
                token_endpoint_auth_method: 'none',
            }),
        }));
        expect(okRes.status).toBe(201);
        const okBody = await okRes.json();
        expect(okBody.client_id).toBe('pwu_client_123');
        expect(okBody.token_endpoint_auth_method).toBe('none');

        const badAuthRes = await postRegister(new Request('https://pwusage.fm.rodeo/api/oauth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.10' },
            body: JSON.stringify({
                client_name: 'Confidential',
                redirect_uris: ['https://example.com/cb'],
                token_endpoint_auth_method: 'client_secret_post',
            }),
        }));
        expect(badAuthRes.status).toBe(400);

        const badUriRes = await postRegister(new Request('https://pwusage.fm.rodeo/api/oauth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.10' },
            body: JSON.stringify({
                client_name: 'BadUri',
                redirect_uris: ['javascript:alert(1)'],
            }),
        }));
        expect(badUriRes.status).toBe(400);
    });

    it('POST /api/oauth/token handles authorization_code, refresh_token, and invalid_grant with no-store', async () => {
        mockExchangeAuthCode.mockResolvedValueOnce({
            ok: true,
            accessToken: 'pwu_oat_1',
            refreshToken: 'pwu_ort_1',
            expiresIn: 3600,
            scope: 'billing:read usage:read',
            grantId: 'grant-1',
            clientId: 'pwu_client_1',
        });

        const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
        createHash('sha256').update(verifier).digest('base64url');
        const form = new URLSearchParams({
            grant_type: 'authorization_code',
            code: 'raw-code',
            client_id: 'pwu_client_1',
            redirect_uri: 'https://claude.ai/cb',
            code_verifier: verifier,
            resource: 'https://pwusage.fm.rodeo/api/mcp',
        });
        const res = await postToken(new Request('https://pwusage.fm.rodeo/api/oauth/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: form.toString(),
        }));
        expect(res.status).toBe(200);
        expect(res.headers.get('cache-control')).toBe('no-store');
        expect(await res.json()).toEqual({
            access_token: 'pwu_oat_1',
            refresh_token: 'pwu_ort_1',
            token_type: 'Bearer',
            expires_in: 3600,
            scope: 'billing:read usage:read',
        });

        mockRotateRefreshToken.mockResolvedValueOnce({
            ok: false,
            error: 'invalid_grant',
            errorDescription: 'Refresh token is invalid or expired',
        });
        const badRefresh = await postToken(new Request('https://pwusage.fm.rodeo/api/oauth/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: 'pwu_ort_bad',
                client_id: 'pwu_client_1',
                resource: 'https://pwusage.fm.rodeo/api/mcp',
            }).toString(),
        }));
        expect(badRefresh.status).toBe(400);
        expect(badRefresh.headers.get('cache-control')).toBe('no-store');
        expect(await badRefresh.json()).toMatchObject({ error: 'invalid_grant' });
    });

    it('POST /api/oauth/revoke returns 200 regardless of whether token existed', async () => {
        mockRevokeOAuthToken.mockResolvedValueOnce(undefined);
        const res = await postRevoke(new Request('https://pwusage.fm.rodeo/api/oauth/revoke', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ token: 'pwu_oat_unknown' }).toString(),
        }));
        expect(res.status).toBe(200);
        expect(mockRevokeOAuthToken).toHaveBeenCalledWith('pwu_oat_unknown');
    });

    it('refuses oversized bodies on register, token and revoke before parsing them', async () => {
        const big = 'x'.repeat(40_000);
        const reg = await postRegister(new Request('https://pwusage.fm.rodeo/api/oauth/register', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'x-real-ip': '198.51.1.1' },
            body: JSON.stringify({ client_name: 'Big', redirect_uris: ['https://a.example/cb'], pad: big }),
        }));
        expect(reg.status).toBe(413);
        expect(mockRegisterDcrClient).not.toHaveBeenCalled();
        for (const [post, path] of [[postToken, 'token'], [postRevoke, 'revoke']] as const) {
            const res = await post(new Request(`https://pwusage.fm.rodeo/api/oauth/${path}`, {
                method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `token=${big}`,
            }));
            expect(res.status, path).toBe(413);
        }
    });

    it('answers 429 when the unused-registration cap is reached', async () => {
        mockRegisterDcrClient.mockResolvedValueOnce(null);
        const res = await postRegister(new Request('https://pwusage.fm.rodeo/api/oauth/register', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'x-real-ip': '198.51.2.1' },
            body: JSON.stringify({ client_name: 'Late', redirect_uris: ['https://a.example/cb'] }),
        }));
        expect(res.status).toBe(429);
    });

    it('rate-limits registrations per IPv6 /64, not per address', async () => {
        mockRegisterDcrClient.mockResolvedValue({ clientId: 'pwu_client_x', clientName: 'X', redirectUris: ['https://a.example/cb'], clientUri: null, kind: 'dcr' });
        const statuses: number[] = [];
        for (let i = 1; i <= 21; i++) {
            const res = await postRegister(new Request('https://pwusage.fm.rodeo/api/oauth/register', {
                method: 'POST', headers: { 'Content-Type': 'application/json', 'x-real-ip': `2001:db9:1:2::${i.toString(16)}` },
                body: JSON.stringify({ client_name: 'X', redirect_uris: ['https://a.example/cb'] }),
            }));
            statuses.push(res.status);
        }
        expect(statuses.slice(0, 20).every(status => status === 201)).toBe(true);
        expect(statuses[20]).toBe(429);
    });

    it('marks host-derived discovery metadata as varying by Host', async () => {
        const prm = await getProtectedResource(new Request('https://pwusage.fm.rodeo/.well-known/oauth-protected-resource'));
        const as = await getAuthServerMetadata(new Request('https://pwusage.fm.rodeo/.well-known/oauth-authorization-server'));
        expect(prm.headers.get('vary')).toMatch(/host/i);
        expect(as.headers.get('vary')).toMatch(/host/i);
    });

    it('stores and compares the canonical resource when a client spells it differently', async () => {
        mockExchangeAuthCode.mockResolvedValueOnce({ ok: false, error: 'invalid_grant', errorDescription: 'x' });
        await postToken(new Request('https://pwusage.fm.rodeo/api/oauth/token', {
            method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'authorization_code', client_id: 'pwu_client_1', code: 'c',
                redirect_uri: 'https://claude.ai/cb', code_verifier: 'v'.repeat(43),
                resource: 'https://pwusage.fm.rodeo:443/api/mcp',
            }).toString(),
        }));
        expect(mockExchangeAuthCode).toHaveBeenCalledWith(expect.objectContaining({ resource: 'https://pwusage.fm.rodeo/api/mcp' }));
    });
});
