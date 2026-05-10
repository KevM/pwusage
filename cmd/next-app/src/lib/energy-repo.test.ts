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

describe('EnergyRepo getRawEnergyData column projection', () => {
    beforeEach(() => {
        queryMock.mockReset();
    });

    it('selects explicit columns and excludes id', async () => {
        queryMock.mockResolvedValueOnce({ rows: [] });

        const repo = new EnergyRepo();
        await repo.getRawEnergyData('site-1', new Date('2026-04-01'), new Date('2026-04-02'));

        expect(queryMock).toHaveBeenCalledTimes(1);
        const sql = queryMock.mock.calls[0][0] as string;

        // Should not use SELECT *
        expect(sql).not.toMatch(/SELECT\s+\*/i);

        // Should include the 9 required columns
        expect(sql).toMatch(/site_id/);
        expect(sql).toMatch(/timestamp/);
        expect(sql).toMatch(/tariff_id/);
        expect(sql).toMatch(/tariff_schedule_id/);
        expect(sql).toMatch(/load_power/);
        expect(sql).toMatch(/solar_power/);
        expect(sql).toMatch(/grid_power/);
        expect(sql).toMatch(/battery_power/);
        expect(sql).toMatch(/battery_soc/);

        // Extract just the SELECT clause (between SELECT and FROM)
        const selectClause = sql.match(/SELECT([\s\S]+?)FROM/i)?.[1] ?? '';
        // Should NOT include the id column in the projection
        expect(selectClause).not.toMatch(/\bid\b/);
    });

    it('returns rows with battery_soc value preserved', async () => {
        queryMock.mockResolvedValueOnce({
            rows: [{
                site_id: 'site-1',
                timestamp: new Date('2026-04-01T00:00:00Z'),
                tariff_id: 1,
                tariff_schedule_id: 2,
                load_power: 1000,
                solar_power: 500,
                grid_power: 300,
                battery_power: 200,
                battery_soc: 75
            }]
        });

        const repo = new EnergyRepo();
        const rows = await repo.getRawEnergyData('site-1', new Date('2026-04-01'), new Date('2026-04-02'));

        expect(rows).toHaveLength(1);
        expect(rows[0].battery_soc).toBe(75);
        expect(rows[0].load_power).toBe(1000);
        expect(rows[0].site_id).toBe('site-1');
        expect(rows[0].tariff_id).toBe(1);
        expect(rows[0].tariff_schedule_id).toBe(2);
    });

    it('preserves null battery_soc', async () => {
        queryMock.mockResolvedValueOnce({
            rows: [{
                site_id: 'site-1',
                timestamp: new Date('2026-04-01T00:00:00Z'),
                tariff_id: 1,
                tariff_schedule_id: 2,
                load_power: 1000,
                solar_power: 500,
                grid_power: 300,
                battery_power: 200,
                battery_soc: null
            }]
        });

        const repo = new EnergyRepo();
        const rows = await repo.getRawEnergyData('site-1', new Date('2026-04-01'), new Date('2026-04-02'));

        expect(rows).toHaveLength(1);
        expect(rows[0].battery_soc).toBeNull();
    });
});
