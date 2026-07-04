import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    cookies: vi.fn(),
    verifyTrmnlToken: vi.fn(),
    verifySiteToken: vi.fn(),
    getInstallationByUuid: vi.fn(),
    upsertSettings: vi.fn(),
    validateSiteAccess: vi.fn(),
    getTokens: vi.fn(),
}));

vi.mock('next/headers', () => ({
    cookies: mocks.cookies
}));

vi.mock('@/lib/trmnl-auth', () => ({
    verifyTrmnlToken: mocks.verifyTrmnlToken
}));

vi.mock('@/lib/auth-jwt', () => ({
    verifySiteToken: mocks.verifySiteToken
}));

vi.mock('@/lib/trmnl-service', () => ({
    TrmnlService: class {
        getInstallationByUuid = mocks.getInstallationByUuid;
    }
}));

vi.mock('@/lib/trmnl-installation-repo', () => ({
    TrmnlInstallationRepo: class {
        upsertSettings = mocks.upsertSettings;
    }
}));

vi.mock('@/lib/site-repo', () => ({
    SiteRepo: class {}
}));

vi.mock('@/lib/user-repo', () => ({
    UserRepo: class {
        getTokens = mocks.getTokens;
    }
}));

vi.mock('@/lib/site-service', () => ({
    SiteService: class {
        validateSiteAccess = mocks.validateSiteAccess;
    }
}));

import { GET, POST } from './route';

describe('/api/trmnl/manage', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.cookies.mockResolvedValue({
            get: vi.fn().mockReturnValue(undefined)
        });
    });

    describe('GET', () => {
        it('returns 400 when uuid parameter is missing', async () => {
            const req = new Request('http://localhost/api/trmnl/manage');
            const res = await GET(req);
            expect(res.status).toBe(400);
        });

        it('allows GET with valid TRMNL token', async () => {
            mocks.verifyTrmnlToken.mockResolvedValue({ sub: 'dev-1' });
            mocks.getInstallationByUuid.mockResolvedValue({
                site_id: 'site-1',
                plugin_setting_id: 12,
                json: { component_screens: ['solar_overview'] }
            });

            const req = new Request('http://localhost/api/trmnl/manage?uuid=dev-1&token=valid-trmnl-token');
            const res = await GET(req);
            expect(res.status).toBe(200);
            const data = await res.json();
            expect(data.site_id).toBe('site-1');
            expect(data.plugin_setting_id).toBe(12);
        });

        it('allows GET with site cookie for linked owned site', async () => {
            mocks.cookies.mockResolvedValue({
                get: vi.fn((name: string) => name === 'site_auth' ? { value: 'site-cookie-jwt' } : undefined)
            });
            mocks.verifySiteToken.mockReturnValue({ sub: 'user-1', sites: ['site-1'], roles: [] });
            mocks.getInstallationByUuid.mockResolvedValue({
                site_id: 'site-1',
                plugin_setting_id: 12,
                json: {}
            });

            const req = new Request('http://localhost/api/trmnl/manage?uuid=dev-1');
            const res = await GET(req);
            expect(res.status).toBe(200);
            const data = await res.json();
            expect(data.site_id).toBe('site-1');
        });

        it('rejects GET for unlinked device with site cookie only', async () => {
            mocks.cookies.mockResolvedValue({
                get: vi.fn((name: string) => name === 'site_auth' ? { value: 'site-cookie-jwt' } : undefined)
            });
            mocks.verifySiteToken.mockReturnValue({ sub: 'user-1', sites: ['site-1'], roles: [] });
            mocks.getInstallationByUuid.mockResolvedValue(null);

            const req = new Request('http://localhost/api/trmnl/manage?uuid=dev-unlinked');
            const res = await GET(req);
            expect(res.status).toBe(401);
        });
    });

    describe('POST', () => {
        it('returns 400 for invalid component_screens (empty array)', async () => {
            const req = new Request('http://localhost/api/trmnl/manage', {
                method: 'POST',
                body: JSON.stringify({
                    uuid: 'dev-1',
                    site_id: 'site-1',
                    component_screens: []
                })
            });
            const res = await POST(req);
            expect(res.status).toBe(400);
        });

        it('allows POST with TRMNL token to link a device to an authorized target site', async () => {
            mocks.verifyTrmnlToken.mockResolvedValue({ sub: 'dev-1', plugin_setting_id: 55 });
            mocks.validateSiteAccess.mockResolvedValue(true);
            mocks.upsertSettings.mockResolvedValue('installation-id-1');

            const req = new Request('http://localhost/api/trmnl/manage', {
                method: 'POST',
                body: JSON.stringify({
                    uuid: 'dev-1',
                    site_id: 'site-1',
                    token: 'valid-token',
                    component_screens: ['solar_overview']
                })
            });
            const res = await POST(req);
            expect(res.status).toBe(200);
            expect(mocks.upsertSettings).toHaveBeenCalledWith(
                'dev-1',
                'site-1',
                expect.any(Object),
                55
            );
        });

        it('allows POST site-auth fallback only for existing linked installation the user owns', async () => {
            mocks.cookies.mockResolvedValue({
                get: vi.fn((name: string) => name === 'site_auth' ? { value: 'site-cookie-jwt' } : undefined)
            });
            mocks.verifySiteToken.mockReturnValue({ sub: 'user-1', sites: ['site-1'], roles: [] });
            mocks.getInstallationByUuid.mockResolvedValue({
                uuid: 'dev-1',
                site_id: 'site-1',
                json: {}
            });
            mocks.validateSiteAccess.mockResolvedValue(true);
            mocks.upsertSettings.mockResolvedValue('inst-id');

            const req = new Request('http://localhost/api/trmnl/manage', {
                method: 'POST',
                body: JSON.stringify({
                    uuid: 'dev-1',
                    site_id: 'site-1',
                    component_screens: ['solar_overview']
                })
            });
            const res = await POST(req);
            expect(res.status).toBe(200);
        });

        it('validates target site access when re-linking to a different target site', async () => {
            mocks.verifyTrmnlToken.mockResolvedValue({ sub: 'dev-1' });
            // User does NOT have access to target site-2
            mocks.validateSiteAccess.mockResolvedValue(false);

            const req = new Request('http://localhost/api/trmnl/manage', {
                method: 'POST',
                body: JSON.stringify({
                    uuid: 'dev-1',
                    site_id: 'site-2',
                    token: 'valid-token',
                    component_screens: ['solar_overview']
                })
            });
            const res = await POST(req);
            expect(res.status).toBe(403);
            const data = await res.json();
            expect(data.error).toContain('Unauthorized access to target site');
        });
    });
});
