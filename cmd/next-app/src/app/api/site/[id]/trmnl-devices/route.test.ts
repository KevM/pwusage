import { beforeEach, describe, expect, it, vi } from 'vitest';

const { verifyMock, listMock } = vi.hoisted(() => ({ verifyMock: vi.fn(), listMock: vi.fn() }));

vi.mock('@/lib/auth-checks', () => ({ verifySiteAccess: verifyMock }));
vi.mock('@/lib/trmnl-service', () => ({
    TrmnlService: class {
        getInstallationsBySiteId = listMock;
    }
}));

import { GET } from './route';

const ctx = { params: Promise.resolve({ id: 'site-1' }) };
const request = new Request('http://localhost/api/site/site-1/trmnl-devices');

describe('GET /api/site/[id]/trmnl-devices', () => {
    beforeEach(() => {
        verifyMock.mockReset().mockResolvedValue(true);
        listMock.mockReset().mockResolvedValue([]);
    });

    it('refuses callers without site access', async () => {
        verifyMock.mockResolvedValue(false);
        const res = await GET(request as never, ctx as never);
        expect(res.status).toBe(403);
        expect(listMock).not.toHaveBeenCalled();
    });

    it('returns finished devices without tokens, privately', async () => {
        listMock.mockResolvedValue([
            { id: 1, uuid: 'aaaaaaaa-1', plugin_setting_id: 11, created_at: new Date('2026-11-03T15:00:00Z') },
            { id: 2, uuid: 'bbbbbbbb-2', plugin_setting_id: null, json: null, created_at: new Date() }
        ]);
        const res = await GET(request as never, ctx as never);
        expect(res.status).toBe(200);
        expect(res.headers.get('Cache-Control')).toBe('private, no-store');
        const { devices } = await res.json();
        expect(devices).toHaveLength(1);
        expect(devices[0]).toMatchObject({
            id: 1, uuid: 'aaaaaaaa-1', pluginSettingId: 11, connectedAt: '2026-11-03T15:00:00.000Z'
        });
        expect(devices[0].screen).toMatchObject({ index: 0, count: 1 });
        expect(listMock).toHaveBeenCalledWith('site-1', { includeTokens: false });
    });
});
