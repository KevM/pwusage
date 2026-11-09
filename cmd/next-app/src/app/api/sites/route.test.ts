import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
    const getSite = vi.fn();
    const getAuthorizedSites = vi.fn();
    const getInstallationByUuid = vi.fn();
    const cookies = vi.fn();
    const verifyTrmnlToken = vi.fn();
    return {
        getSite,
        getAuthorizedSites,
        getInstallationByUuid,
        cookies,
        verifyTrmnlToken
    };
});

vi.mock('next/headers', () => ({
    cookies: mocks.cookies
}));

vi.mock('@/lib/energy-repo', () => ({
    EnergyRepo: class {
        getSite = mocks.getSite;
    }
}));

vi.mock('@/lib/site-service', () => ({
    SiteService: class {
        getAuthorizedSites = mocks.getAuthorizedSites;
    }
}));

vi.mock('@/lib/trmnl-auth', () => ({
    verifyTrmnlToken: mocks.verifyTrmnlToken
}));

vi.mock('@/lib/trmnl-service', () => ({
    TrmnlService: class {
        getInstallationByUuid = mocks.getInstallationByUuid;
    }
}));

import { GET } from './route';

describe('/api/sites', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.cookies.mockResolvedValue({
            get: vi.fn().mockReturnValue({ value: 'site-token' })
        });
        mocks.getAuthorizedSites.mockResolvedValue([
            { id: 'site-1', name: 'Home', utility: 'Portland General Electric', billing_start_day: 1, billing_start_day_confirmed_at: null }
        ]);
    });

    it('returns utility from the normalized Site column without requesting site json', async () => {
        const response = await GET(new Request('http://localhost/api/sites'));
        const body = await response.json();

        expect(mocks.getAuthorizedSites).toHaveBeenCalledWith();
        expect(body).toEqual([
            { id: 'site-1', name: 'Home', utility: 'Portland General Electric', billingDay: 1, billingDayConfirmed: false }
        ]);
    });

    it('reports a chosen billing day as confirmed', async () => {
        mocks.getAuthorizedSites.mockResolvedValue([
            { id: 'site-2', name: 'Cabin', utility: null, billing_start_day: 31, billing_start_day_confirmed_at: new Date('2026-11-01T00:00:00Z') }
        ]);

        const body = await (await GET(new Request('http://localhost/api/sites'))).json();

        expect(body).toEqual([
            { id: 'site-2', name: 'Cabin', utility: 'Unknown Utility', billingDay: 31, billingDayConfirmed: true }
        ]);
    });

    it('treats a missing or zero billing day as day 1', async () => {
        mocks.getAuthorizedSites.mockResolvedValue([{ id: 'site-3', name: 'X', billing_start_day: 0 }]);

        const body = await (await GET(new Request('http://localhost/api/sites'))).json();

        expect(body[0]).toMatchObject({ billingDay: 1, billingDayConfirmed: false });
    });

    it('returns 401 when site authorization rejects a revoked user', async () => {
        mocks.getAuthorizedSites.mockRejectedValue(new Error('Unauthorized: Revoked or inactive user'));

        const response = await GET(new Request('http://localhost/api/sites'));
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: 'Unauthorized' });
    });

    it('keeps an authorized user with no sites as a valid empty response', async () => {
        mocks.getAuthorizedSites.mockResolvedValue([]);

        const response = await GET(new Request('http://localhost/api/sites'));
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual([]);
    });
});
