import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    isUserAdmin: vi.fn(),
    listBetaSites: vi.fn(),
    findUserId: vi.fn(),
    setBeta: vi.fn(),
    siteOwnerHasBeta: vi.fn(),
    setLocation: vi.fn(),
}));

vi.mock('@/lib/auth-checks', () => ({ isUserAdmin: mocks.isUserAdmin }));

vi.mock('@/lib/solar-beta-admin-repo', () => ({
    SolarBetaAdminRepo: class {
        listBetaSites = mocks.listBetaSites;
        findUserId = mocks.findUserId;
        setBeta = mocks.setBeta;
        siteOwnerHasBeta = mocks.siteOwnerHasBeta;
    },
}));

vi.mock('@/lib/solar-layout-repo', () => ({
    SolarLayoutRepo: class {
        setLocation = mocks.setLocation;
    },
}));

import { GET, POST, PUT } from './route';

const request = (method: string, body?: unknown) => new Request('http://localhost/api/admin/solar-beta', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
});

describe('/api/admin/solar-beta', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.isUserAdmin.mockResolvedValue(true);
    });

    it('rejects non-admins on every method', async () => {
        mocks.isUserAdmin.mockResolvedValue(false);
        expect((await GET()).status).toBe(403);
        expect((await POST(request('POST', { siteId: 's1', enabled: true }))).status).toBe(403);
        expect((await PUT(request('PUT', { siteId: 's1', latitude: 1, longitude: 2 }))).status).toBe(403);
        expect(mocks.setBeta).not.toHaveBeenCalled();
        expect(mocks.setLocation).not.toHaveBeenCalled();
    });

    it('lists beta sites', async () => {
        mocks.listBetaSites.mockResolvedValue([{ userId: 'u1', siteId: 's1' }]);
        const res = await GET();
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ sites: [{ userId: 'u1', siteId: 's1' }] });
    });

    it('grants beta to the owner of a site', async () => {
        mocks.findUserId.mockResolvedValue('u1');
        const res = await POST(request('POST', { siteId: '2282114', enabled: true }));
        expect(res.status).toBe(204);
        expect(mocks.findUserId).toHaveBeenCalledWith({ siteId: '2282114', email: undefined });
        expect(mocks.setBeta).toHaveBeenCalledWith('u1', true);
    });

    it('revokes beta by email', async () => {
        mocks.findUserId.mockResolvedValue('u2');
        const res = await POST(request('POST', { email: ' Someone@Example.com ', enabled: false }));
        expect(res.status).toBe(204);
        expect(mocks.findUserId).toHaveBeenCalledWith({ siteId: undefined, email: 'someone@example.com' });
        expect(mocks.setBeta).toHaveBeenCalledWith('u2', false);
    });

    it('returns 404 when no user matches and 400 without a target or flag', async () => {
        mocks.findUserId.mockResolvedValue(null);
        expect((await POST(request('POST', { siteId: 'nope', enabled: true }))).status).toBe(404);
        expect((await POST(request('POST', { enabled: true }))).status).toBe(400);
        expect((await POST(request('POST', { siteId: 's1' }))).status).toBe(400);
        expect(mocks.setBeta).not.toHaveBeenCalled();
    });

    it('stores a location for a beta site', async () => {
        mocks.siteOwnerHasBeta.mockResolvedValue(true);
        const res = await PUT(request('PUT', { siteId: 's1', latitude: 43.39321, longitude: -87.87154 }));
        expect(res.status).toBe(204);
        expect(mocks.setLocation).toHaveBeenCalledWith('s1', 43.39321, -87.87154, 'estimated', { overwriteDevice: false });
    });

    it('does not replace a phone location unless overwrite is true', async () => {
        mocks.siteOwnerHasBeta.mockResolvedValue(true);
        mocks.setLocation.mockResolvedValue('device-location-kept');
        const res = await PUT(request('PUT', { siteId: 's1', latitude: 1, longitude: 2 }));
        expect(res.status).toBe(409);
        expect(await res.json()).toEqual({ error: 'This site already has a location from the phone' });

        mocks.setLocation.mockResolvedValue('stored');
        expect((await PUT(request('PUT', { siteId: 's1', latitude: 1, longitude: 2, overwrite: true }))).status).toBe(204);
        expect(mocks.setLocation).toHaveBeenLastCalledWith('s1', 1, 2, 'estimated', { overwriteDevice: true });
    });

    it('refuses a location for a site whose owner is not in the beta', async () => {
        mocks.siteOwnerHasBeta.mockResolvedValue(false);
        expect((await PUT(request('PUT', { siteId: 's1', latitude: 1, longitude: 2 }))).status).toBe(409);
        expect(mocks.setLocation).not.toHaveBeenCalled();
    });

    it('rejects out-of-range or non-numeric coordinates', async () => {
        mocks.siteOwnerHasBeta.mockResolvedValue(true);
        for (const body of [
            { siteId: 's1', latitude: 91, longitude: 0 },
            { siteId: 's1', latitude: 0, longitude: -181 },
            { siteId: 's1', latitude: '43', longitude: 0 },
            { latitude: 1, longitude: 2 },
        ]) {
            expect((await PUT(request('PUT', body))).status).toBe(400);
        }
        expect(mocks.setLocation).not.toHaveBeenCalled();
    });
});
