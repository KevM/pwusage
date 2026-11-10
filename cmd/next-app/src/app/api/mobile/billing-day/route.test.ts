import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
    verifySiteAccess: vi.fn(),
    updateSiteBillingDay: vi.fn(),
}));

vi.mock('@/lib/auth-checks', () => ({ verifySiteAccess: mocks.verifySiteAccess }));
vi.mock('@/lib/site-repo', () => ({ SiteRepo: class { updateSiteBillingDay = mocks.updateSiteBillingDay; } }));

import { POST } from './route';

function post(body: unknown, headers: Record<string, string> = {}) {
    return new NextRequest('https://pwusage.test/api/mobile/billing-day', {
        method: 'POST',
        body: typeof body === 'string' ? body : JSON.stringify(body),
        headers: { 'content-type': 'application/json', ...headers },
    });
}

describe('POST /api/mobile/billing-day', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.verifySiteAccess.mockResolvedValue(true);
        mocks.updateSiteBillingDay.mockResolvedValue(undefined);
    });

    it('saves day 31 and reports it confirmed', async () => {
        const response = await POST(post({ siteId: 'site-1', day: 31 }));

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ billingDay: 31, billingDayConfirmed: true });
        expect(mocks.updateSiteBillingDay).toHaveBeenCalledWith('site-1', 31);
        expect(response.headers.get('cache-control')).toContain('no-store');
    });

    it('confirming the existing day 1 succeeds', async () => {
        const response = await POST(post({ siteId: 'site-1', day: 1 }));

        expect(response.status).toBe(200);
        expect(mocks.updateSiteBillingDay).toHaveBeenCalledWith('site-1', 1);
    });

    it('rejects a caller without access to the site and writes nothing', async () => {
        mocks.verifySiteAccess.mockResolvedValue(false);

        const response = await POST(post({ siteId: 'site-9', day: 5 }));

        expect(response.status).toBe(401);
        expect(mocks.updateSiteBillingDay).not.toHaveBeenCalled();
    });

    it.each([0, 32, 1.5, 'abc', null])('rejects day %s', async (day) => {
        const response = await POST(post({ siteId: 'site-1', day }));

        expect(response.status).toBe(400);
        expect(mocks.updateSiteBillingDay).not.toHaveBeenCalled();
    });

    it('rejects a missing site id, a non-JSON body and a wrong content type', async () => {
        expect((await POST(post({ day: 5 }))).status).toBe(400);
        expect((await POST(post('not json'))).status).toBe(400);
        const wrongType = new NextRequest('https://pwusage.test/api/mobile/billing-day', {
            method: 'POST', body: '{}', headers: { 'content-type': 'text/plain' },
        });
        expect((await POST(wrongType)).status).toBe(415);
    });

    it('rejects cross-origin browser requests but allows native requests with no Origin', async () => {
        const cross = await POST(post({ siteId: 'site-1', day: 5 }, { origin: 'https://evil.test' }));
        expect(cross.status).toBe(403);
        const crossSite = await POST(post({ siteId: 'site-1', day: 5 }, { 'sec-fetch-site': 'cross-site' }));
        expect(crossSite.status).toBe(403);
        expect(mocks.updateSiteBillingDay).not.toHaveBeenCalled();

        const native = await POST(post({ siteId: 'site-1', day: 5 }));
        expect(native.status).toBe(200);
    });
});
