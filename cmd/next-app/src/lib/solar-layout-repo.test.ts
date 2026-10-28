import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('./db', () => ({ pool: { query: queryMock } }));

import { SolarLayoutRepo } from './solar-layout-repo';

function row(overrides: Record<string, unknown> = {}) {
    return {
        site_id: 's1', latitude: '43.39', longitude: '-87.87', location_set_at: new Date('2026-10-01T00:00:00Z'),
        result: null, status: 'pending', detected_at: null, attempted_at: null, detector_version: null,
        ...overrides,
    };
}

describe('SolarLayoutRepo', () => {
    beforeEach(() => queryMock.mockReset());

    it('setLocation rounds to two decimals', async () => {
        queryMock.mockResolvedValueOnce({ rows: [] });
        queryMock.mockResolvedValueOnce({ rows: [row()] });
        const repo = new SolarLayoutRepo();
        await repo.setLocation('s1', 43.39321, -87.87154);
        const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
        expect(params).toEqual(['s1', 43.39, -87.87]);
        expect(sql).toContain("status = 'pending'");
        expect(sql).toContain('attempted_at = NULL');
        const got = await repo.get('s1');
        expect(got).toMatchObject({ siteId: 's1', latitude: 43.39, longitude: -87.87, status: 'pending' });
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
        expect(sql).toMatch(/l\.detected_at IS NULL OR l\.detected_at < \$1::timestamptz - interval '30 days'/);
        expect(sql).toMatch(/l\.attempted_at IS NULL OR l\.attempted_at < \$1::timestamptz - interval '24 hours'/);
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

    it('recordFailure only stamps attempted_at', async () => {
        queryMock.mockResolvedValue({ rows: [] });
        await new SolarLayoutRepo().recordFailure('s1');
        const [sql] = queryMock.mock.calls[0] as [string];
        expect(sql).toMatch(/SET attempted_at = now\(\)\s+WHERE site_id = \$1/);
    });
});
