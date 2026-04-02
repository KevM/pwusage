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
            { id: 'site-1', name: 'Home', utility: 'Portland General Electric' }
        ]);
    });

    it('returns utility from the normalized Site column without requesting site json', async () => {
        const response = await GET(new Request('http://localhost/api/sites'));
        const body = await response.json();

        expect(mocks.getAuthorizedSites).toHaveBeenCalledWith();
        expect(body).toEqual([
            { id: 'site-1', name: 'Home', utility: 'Portland General Electric' }
        ]);
    });
});
