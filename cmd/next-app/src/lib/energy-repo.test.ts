import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queryMock } = vi.hoisted(() => ({
    queryMock: vi.fn()
}));

vi.mock('./db', () => ({
    pool: {
        query: queryMock
    }
}));

import { EnergyRepo } from './energy-repo';

describe('EnergyRepo site payload selection', () => {
    beforeEach(() => {
        queryMock.mockReset();
        const repo = new EnergyRepo();
        repo.invalidateCache('site-1');
    });

    it('fetches slim site columns by default', async () => {
        queryMock
            .mockResolvedValueOnce({
                rows: [{
                    id: 'site-1',
                    user_id: 'user-1',
                    name: 'Home',
                    updated: new Date(),
                    installed: new Date(),
                    timezone: 'America/Chicago',
                    billing_start_day: 1
                }]
            })
            .mockResolvedValueOnce({ rows: [{ access_token: 'a', refresh_token: 'r', auth_status: 'active' }] })
            .mockResolvedValueOnce({ rows: [] });

        const repo = new EnergyRepo();
        await repo.getSite('site-1');

        expect(queryMock).toHaveBeenCalledWith(
            expect.stringContaining('SELECT id, user_id, name, utility, updated, installed, timezone, billing_start_day'),
            ['site-1']
        );
        expect(queryMock).not.toHaveBeenCalledWith(
            expect.stringContaining('SELECT * FROM "Site" WHERE id = $1'),
            expect.anything()
        );
    });

    it('includes site json only when explicitly requested', async () => {
        queryMock
            .mockResolvedValueOnce({
                rows: [{
                    id: 'site-1',
                    user_id: 'user-1',
                    name: 'Home',
                    updated: new Date(),
                    installed: new Date(),
                    timezone: 'America/Chicago',
                    json: { components: { battery: true } },
                    billing_start_day: 1
                }]
            })
            .mockResolvedValueOnce({ rows: [{ access_token: 'a', refresh_token: 'r', auth_status: 'active' }] })
            .mockResolvedValueOnce({ rows: [] });

        const repo = new EnergyRepo();
        const site = await repo.getSite('site-1', { includeJson: true });

        expect(queryMock).toHaveBeenCalledWith(
            expect.stringContaining('SELECT id, user_id, name, utility, updated, installed, timezone, billing_start_day, timezone_display_mode, json'),
            ['site-1']
        );
        expect(site?.json).toEqual({ components: { battery: true } });
    });

    it('fetches slim site rows for user lists', async () => {
        queryMock.mockResolvedValueOnce({
            rows: [{
                id: 'site-1',
                user_id: 'user-1',
                name: 'Home',
                updated: new Date(),
                installed: new Date(),
                timezone: 'America/Chicago',
                billing_start_day: 1
            }]
        });

        const repo = new EnergyRepo();
        await repo.getSitesForUser('user-1');

        expect(queryMock).toHaveBeenCalledWith(
            expect.stringContaining('SELECT id, user_id, name, utility, updated, installed, timezone, billing_start_day'),
            ['user-1']
        );
        expect(queryMock).not.toHaveBeenCalledWith(
            expect.stringContaining('SELECT * FROM "Site" WHERE user_id = $1'),
            expect.anything()
        );
    });

    it('does not fetch site json for TRMNL installation lookups', async () => {
        queryMock
            .mockResolvedValueOnce({
                rows: [{
                    id: 1,
                    uuid: 'uuid-1',
                    site_id: 'site-1',
                    plugin_setting_id: 123,
                    created_at: new Date(),
                    json: { device: true },
                    access_token: 'install-token',
                    refresh_token: 'install-refresh',
                    tesla_access_token: 'tesla-token',
                    tesla_refresh_token: 'tesla-refresh',
                    tesla_auth_status: 'active'
                }]
            })
            .mockResolvedValueOnce({
                rows: [{
                    id: 'site-1',
                    user_id: 'user-1',
                    name: 'Home',
                    updated: new Date(),
                    installed: new Date(),
                    timezone: 'America/Chicago',
                    billing_start_day: 1
                }]
            })
            .mockResolvedValueOnce({ rows: [{ access_token: 'tesla-token', refresh_token: 'tesla-refresh', auth_status: 'active' }] })
            .mockResolvedValueOnce({ rows: [] });

        const repo = new EnergyRepo();
        const result = await repo.getInstallationAndSite('uuid-1');

        expect(queryMock).toHaveBeenNthCalledWith(
            1,
            expect.not.stringContaining('s.json as site_json'),
            ['uuid-1']
        );
        expect(result?.site.json).toBeUndefined();
    });
});

describe('EnergyRepo.getCycleAggregates', () => {
    const start = new Date('2026-04-01T00:00:00Z');
    const end   = new Date('2026-04-28T00:00:00Z');

    beforeEach(() => {
        queryMock.mockReset();
    });

    it('returns an empty array when there are no rows', async () => {
        queryMock.mockResolvedValueOnce({ rows: [] });

        const repo = new EnergyRepo();
        const result = await repo.getCycleAggregates('site-1', start, end);

        expect(result).toEqual([]);
        expect(queryMock).toHaveBeenCalledWith(
            expect.stringContaining('GROUP BY'),
            ['site-1', start, end]
        );
    });

    it('coerces pg numeric strings to JS numbers', async () => {
        queryMock.mockResolvedValueOnce({
            rows: [{
                day: '2026-04-15T00:00:00Z',
                tariff_id: '42',
                tariff_schedule_id: '7',
                load_power: '100000',
                solar_power: '80000',
                grid_power: '20000',
                battery_power: '-5000',
            }]
        });

        const repo = new EnergyRepo();
        const [row] = await repo.getCycleAggregates('site-1', start, end);

        expect(typeof row.tariff_id).toBe('number');
        expect(row.tariff_id).toBe(42);
        expect(typeof row.tariff_schedule_id).toBe('number');
        expect(row.tariff_schedule_id).toBe(7);
        expect(row.load_power).toBe(100000);
        expect(row.solar_power).toBe(80000);
        expect(row.grid_power).toBe(20000);
        expect(row.battery_power).toBe(-5000);
        expect(row.day).toBeInstanceOf(Date);
    });

    it('maps NULL tariff_schedule_id to null (not 0)', async () => {
        queryMock.mockResolvedValueOnce({
            rows: [{
                day: '2026-04-15T00:00:00Z',
                tariff_id: '42',
                tariff_schedule_id: null,
                load_power: '50000',
                solar_power: '0',
                grid_power: '50000',
                battery_power: '0',
            }]
        });

        const repo = new EnergyRepo();
        const [row] = await repo.getCycleAggregates('site-1', start, end);

        expect(row.tariff_schedule_id).toBeNull();
    });

    it('returns one row per distinct (day, tariff_id, tariff_schedule_id) combination', async () => {
        queryMock.mockResolvedValueOnce({
            rows: [
                {
                    day: '2026-04-14T00:00:00Z',
                    tariff_id: '1',
                    tariff_schedule_id: '10',
                    load_power: '60000',
                    solar_power: '30000',
                    grid_power: '30000',
                    battery_power: '0',
                },
                {
                    day: '2026-04-14T00:00:00Z',
                    tariff_id: '1',
                    tariff_schedule_id: '11',
                    load_power: '90000',
                    solar_power: '10000',
                    grid_power: '80000',
                    battery_power: '0',
                },
                {
                    day: '2026-04-15T00:00:00Z',
                    tariff_id: '1',
                    tariff_schedule_id: '10',
                    load_power: '70000',
                    solar_power: '40000',
                    grid_power: '30000',
                    battery_power: '0',
                },
            ]
        });

        const repo = new EnergyRepo();
        const rows = await repo.getCycleAggregates('site-1', start, end);

        expect(rows).toHaveLength(3);

        const apr14Rows = rows.filter(r => r.day.toISOString().startsWith('2026-04-14'));
        expect(apr14Rows).toHaveLength(2);
        expect(apr14Rows.map(r => r.tariff_schedule_id).sort()).toEqual([10, 11]);

        const apr15Rows = rows.filter(r => r.day.toISOString().startsWith('2026-04-15'));
        expect(apr15Rows).toHaveLength(1);
        expect(apr15Rows[0].load_power).toBe(70000);
    });

    it('queries EnergyData with GROUP BY day, tariff_id, tariff_schedule_id', async () => {
        queryMock.mockResolvedValueOnce({ rows: [] });

        const repo = new EnergyRepo();
        await repo.getCycleAggregates('site-1', start, end);

        const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
        expect(sql).toContain('GROUP BY');
        expect(sql).toContain('tariff_id');
        expect(sql).toContain('tariff_schedule_id');
        expect(sql).toContain('"EnergyData"');
        expect(params).toEqual(['site-1', start, end]);
    });
});
