import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('./db', () => ({ pool: { query: queryMock } }));

import { SolarLayoutRepo } from './solar-layout-repo';

function row(overrides: Record<string, unknown> = {}) {
    return {
        site_id: 's1', latitude: '43.39', longitude: '-87.87', location_set_at: new Date('2026-10-01T00:00:00Z'),
        result: null, status: 'pending', detected_at: null, attempted_at: null, detector_version: null,
        location_source: 'estimated',
        ...overrides,
    };
}

describe('SolarLayoutRepo', () => {
    beforeEach(() => queryMock.mockReset());

    it('setLocation rounds to two decimals and records the source', async () => {
        queryMock.mockResolvedValueOnce({ rows: [{ site_id: 's1' }] });
        queryMock.mockResolvedValueOnce({ rows: [row()] });
        const repo = new SolarLayoutRepo();
        const outcome = await repo.setLocation('s1', 43.39321, -87.87154, 'estimated');
        const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
        expect(outcome).toBe('stored');
        expect(params).toEqual(['s1', 43.39, -87.87, 'estimated', false]);
        expect(sql).toContain("'pending'");
        const got = await repo.get('s1');
        expect(got).toMatchObject({ siteId: 's1', latitude: 43.39, longitude: -87.87, status: 'pending', locationSource: 'estimated' });
    });

    it('setLocation keeps a phone location against an admin estimate unless overwriteDevice is set', async () => {
        queryMock.mockResolvedValueOnce({ rows: [] });
        expect(await new SolarLayoutRepo().setLocation('s1', 43.39, -87.87, 'estimated')).toBe('device-location-kept');
        const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
        expect(sql).toMatch(/WHERE NOT \(COALESCE\("SiteSolarLayout"\.location_source, ''\) = 'device' AND \$4::text = 'estimated' AND NOT \$5::boolean\)/);
        expect(params[4]).toBe(false);

        queryMock.mockResolvedValueOnce({ rows: [{ site_id: 's1' }] });
        expect(await new SolarLayoutRepo().setLocation('s1', 43.39, -87.87, 'estimated', { overwriteDevice: true })).toBe('stored');
        expect(queryMock.mock.calls[1][1][4]).toBe(true);
    });

    it('setLocation queues re-detection only when the location changes', async () => {
        queryMock.mockResolvedValueOnce({ rows: [] });
        await new SolarLayoutRepo().setLocation('s1', 43.39, -87.87, 'estimated');
        const [sql] = queryMock.mock.calls[0] as [string];
        const moved = '"SiteSolarLayout".latitude IS DISTINCT FROM EXCLUDED.latitude OR "SiteSolarLayout".longitude IS DISTINCT FROM EXCLUDED.longitude';
        expect(sql).toContain(`detected_at = CASE WHEN ${moved} THEN NULL ELSE "SiteSolarLayout".detected_at END`);
        expect(sql).toContain(`attempted_at = CASE WHEN ${moved} THEN NULL ELSE "SiteSolarLayout".attempted_at END`);
        expect(sql).toContain(`WHEN ${moved} THEN 'pending' ELSE "SiteSolarLayout".status END`);
    });

    it('setLocation keeps a detected layout while a phone location replaces an estimate', async () => {
        queryMock.mockResolvedValueOnce({ rows: [{ site_id: 's1' }] });
        await new SolarLayoutRepo().setLocation('s1', 43.39, -87.87, 'device');
        const [sql] = queryMock.mock.calls[0] as [string];
        expect(sql).toMatch(/WHEN .* AND \$4::text = 'device' AND "SiteSolarLayout"\.status = 'detected' AND "SiteSolarLayout"\.result IS NOT NULL THEN "SiteSolarLayout"\.status/);
    });

    it('get returns null for a site without a row', async () => {
        queryMock.mockResolvedValueOnce({ rows: [] });
        expect(await new SolarLayoutRepo().get('nope')).toBeNull();
    });

    it('listDue skips sites without the beta role, without a location, detected in the last 30 days, or attempted in the last 24 hours', async () => {
        queryMock.mockResolvedValueOnce({ rows: [{ site_id: 's2', timezone: 'America/Chicago', latitude: '43.39', longitude: '-87.87' }] });
        const now = new Date('2026-10-27T12:00:00Z');
        const due = await new SolarLayoutRepo().listDue(5, now);
        expect(due).toEqual([{ siteId: 's2', timezone: 'America/Chicago', latitude: 43.39, longitude: -87.87 }]);
        const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
        expect(sql).toContain("'solar-forecast-beta' = ANY(u.roles)");
        expect(sql).toMatch(/l\.latitude IS NOT NULL AND l\.longitude IS NOT NULL/);
        expect(sql).toMatch(/l\.status = 'not-enough-history' OR l\.detected_at IS NULL OR l\.detected_at < \$1::timestamptz - interval '30 days'/);
        expect(sql).toMatch(/l\.attempted_at IS NULL OR l\.attempted_at <= \$1::timestamptz - interval '24 hours'/);
        expect(sql).toMatch(/ORDER BY l\.detected_at NULLS FIRST, l\.attempted_at NULLS FIRST/);
        expect(params).toEqual([now, 5]);
    });

    it('saveResult with failed status keeps the previous result', async () => {
        queryMock.mockResolvedValue({ rows: [] });
        const repo = new SolarLayoutRepo();
        const failed = { status: 'failed' } as never;
        await repo.saveResult('s1', failed, 1);
        const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
        expect(sql).toMatch(/result = CASE WHEN \$2 = 'failed' THEN result ELSE \$3::jsonb END/);
        expect(params[0]).toBe('s1');
        expect(params[1]).toBe('failed');
        expect(params[3]).toBe(1);
    });

    it('saveResult and recordFailure skip a site whose location changed during detection', async () => {
        queryMock.mockResolvedValue({ rows: [] });
        const repo = new SolarLayoutRepo();
        await repo.saveResult('s1', { status: 'detected' } as never, 1, { latitude: 43.39, longitude: -87.87 });
        await repo.recordFailure('s1', { latitude: 43.39, longitude: -87.87 });
        for (const [sql, params] of queryMock.mock.calls as [string, unknown[]][]) {
            expect(sql).toMatch(/AND latitude = \$\d+ AND longitude = \$\d+/);
            expect(params.slice(-2)).toEqual([43.39, -87.87]);
        }
    });

    it('recordFailure only stamps attempted_at', async () => {
        queryMock.mockResolvedValue({ rows: [] });
        await new SolarLayoutRepo().recordFailure('s1');
        const [sql] = queryMock.mock.calls[0] as [string];
        expect(sql).toMatch(/SET attempted_at = now\(\)\s+WHERE site_id = \$1/);
    });
});
