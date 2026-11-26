import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAuthenticateGrantToken = vi.fn();
const mockGetSite = vi.fn();

vi.mock('@/lib/oauth/oauth-repo', () => ({
    authenticateGrantToken: (...args: unknown[]) => mockAuthenticateGrantToken(...args),
}));

vi.mock('@/lib/site-repo', () => ({
    SiteRepo: class {
        getSite(...args: unknown[]) {
            return mockGetSite(...args);
        }
    },
}));

vi.mock('@/lib/observability', () => ({
    observeRoute: (_route: string, fn: (req: Request) => Promise<Response>) => fn,
    logEvent: vi.fn(),
}));

import { DELETE, GET, OPTIONS, POST } from './route';

describe('/api/mcp route', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        process.env.NEXT_PUBLIC_APP_URL = 'https://pwusage.fm.rodeo';
    });

    it('returns 405 on GET and DELETE', async () => {
        const getRes = await GET();
        expect(getRes.status).toBe(405);
        const delRes = await DELETE();
        expect(delRes.status).toBe(405);
    });

    it('returns 401 with WWW-Authenticate resource_metadata when unauthenticated', async () => {
        mockAuthenticateGrantToken.mockResolvedValueOnce(null);
        const res = await POST(new Request('https://pwusage.fm.rodeo/api/mcp', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        }));
        expect(res.status).toBe(401);
        expect(res.headers.get('www-authenticate')).toBe(
            'Bearer resource_metadata="https://pwusage.fm.rodeo/.well-known/oauth-protected-resource"',
        );
    });

    it('handles tools/list and tools/call over stateless Streamable HTTP', async () => {
        mockAuthenticateGrantToken.mockResolvedValue({
            grantId: 'grant-1',
            userId: 'user-1',
            clientId: 'pwu_client_1',
            clientName: 'Claude',
            scopes: ['billing:read', 'usage:read'],
            authorizedSiteIds: ['site-1'],
        });
        mockGetSite.mockResolvedValueOnce({
            id: 'site-1',
            name: 'Main Home',
            utility: 'PG&E',
            timezone: 'America/Los_Angeles',
            billing_start_day: 1,
            billing_start_day_confirmed_at: new Date('2026-11-01T00:00:00Z'),
            tariffs: [{ id: 1 }],
        });

        const listRes = await POST(new Request('https://pwusage.fm.rodeo/api/mcp', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json, text/event-stream',
                Authorization: 'Bearer pwu_oat_valid',
            },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        }));
        expect(listRes.status).toBe(200);
        const listJson = await listRes.json();
        const toolNames = (listJson.result.tools as Array<{ name: string }>).map(t => t.name);
        expect(toolNames).toEqual(
            expect.arrayContaining([
                'list_homes',
                'get_live_status',
                'get_current_bill',
                'get_smart_shift_outlook',
                'get_daily_usage',
            ]),
        );

        const callRes = await POST(new Request('https://pwusage.fm.rodeo/api/mcp', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json, text/event-stream',
                Authorization: 'Bearer pwu_oat_valid',
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 2,
                method: 'tools/call',
                params: { name: 'list_homes', arguments: {} },
            }),
        }));
        expect(callRes.status).toBe(200);
        const callJson = await callRes.json();
        const text = callJson.result.content[0].text as string;
        expect(JSON.parse(text).homes[0].siteId).toBe('site-1');
    });

    it('lets browser MCP clients on other origins preflight, call, and read the auth challenge (CORS)', async () => {
        const preflight = await OPTIONS();
        expect(preflight.status).toBe(204);
        expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
        expect(preflight.headers.get('access-control-allow-methods')).toContain('POST');
        const allowed = (preflight.headers.get('access-control-allow-headers') ?? '').toLowerCase();
        for (const header of ['authorization', 'content-type', 'mcp-protocol-version']) {
            expect(allowed).toContain(header);
        }

        mockAuthenticateGrantToken.mockResolvedValueOnce(null);
        const challenge = await POST(new Request('https://pwusage.fm.rodeo/api/mcp', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Origin: 'https://inspector.example' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        }));
        expect(challenge.status).toBe(401);
        expect(challenge.headers.get('access-control-allow-origin')).toBe('*');
        expect((challenge.headers.get('access-control-expose-headers') ?? '').toLowerCase()).toContain('www-authenticate');

        mockAuthenticateGrantToken.mockResolvedValueOnce({
            grantId: 'grant-1', userId: 'user-1', clientId: 'pwu_client_1', clientName: 'Claude',
            scopes: ['billing:read', 'usage:read'], authorizedSiteIds: ['site-1'],
        });
        const ok = await POST(new Request('https://pwusage.fm.rodeo/api/mcp', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
                Authorization: 'Bearer pwu_oat_valid', Origin: 'https://inspector.example',
            },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        }));
        expect(ok.status).toBe(200);
        expect(ok.headers.get('access-control-allow-origin')).toBe('*');

        expect((await GET()).headers.get('access-control-allow-origin')).toBe('*');
    });
});
