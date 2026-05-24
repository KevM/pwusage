import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queryMock } = vi.hoisted(() => ({
    queryMock: vi.fn()
}));

vi.mock('./db', () => ({
    pool: {
        query: queryMock
    }
}));

import { EnergyRepo, sumTodayRows, type UsageData } from './energy-repo';
import type { EnergyData } from './db';
import { SiteRepo } from './site-repo';
import { TariffRepo } from './tariff-repo';

function makeEnergyRow(over: Partial<EnergyData>): EnergyData {
    return {
        timestamp: new Date('2026-05-11T07:00:00Z'),
        site_id: 'site-1',
        tariff_id: 1,
        tariff_schedule_id: 10,
        load_power: 0,
        solar_power: 0,
        grid_power: 0,
        battery_power: 0,
        battery_soc: null,
        ...over
    } as EnergyData;
}

describe('sumTodayRows', () => {
    it('returns all zeros for empty input', () => {
        const totals = sumTodayRows([]);
        expect(totals).toEqual({
            homeKwh: 0, solarKwh: 0, gridNetKwh: 0,
            importKwh: 0, exportKwh: 0, batteryNetKwh: 0,
            latestBatterySoc: null
        });
    });

    it('sums Wh rows and converts to kWh', () => {
        const rows = [
            makeEnergyRow({ load_power: 200, solar_power: 50, grid_power: 300, battery_power: -100 }),
            makeEnergyRow({ load_power: 400, solar_power: 550, grid_power: 300, battery_power: -100 })
        ];
        const t = sumTodayRows(rows);
        expect(t.homeKwh).toBeCloseTo(0.6);
        expect(t.solarKwh).toBeCloseTo(0.6);
        expect(t.gridNetKwh).toBeCloseTo(0.6);
        expect(t.importKwh).toBeCloseTo(0.6);
        expect(t.exportKwh).toBeCloseTo(0);
        expect(t.batteryNetKwh).toBeCloseTo(-0.2);
    });

    it('splits grid into gross import and export by sign of each row', () => {
        const rows = [
            makeEnergyRow({ grid_power: 800 }),    // import 0.8 kWh
            makeEnergyRow({ grid_power: -200 }),   // export 0.2 kWh
            makeEnergyRow({ grid_power: -500 })    // export 0.5 kWh
        ];
        const t = sumTodayRows(rows);
        expect(t.importKwh).toBeCloseTo(0.8);
        expect(t.exportKwh).toBeCloseTo(0.7);
        // Net = 0.8 - 0.2 - 0.5 = 0.1 kWh
        expect(t.gridNetKwh).toBeCloseTo(0.1);
    });

    it('agrees with the previous live-page summary logic on the same rows', () => {
        // Regression check: this is the data shape the live page used to feed
        // through DailyTotalsRow.summarize, computed independently here. If the
        // unified helper ever drifts from the long-standing semantics, this
        // test catches it.
        const rows = [
            makeEnergyRow({ load_power: 600, solar_power: 0,   grid_power: 600 }),  // 0.6 kWh import
            makeEnergyRow({ load_power: 0,   solar_power: 600, grid_power: -300 }), // 0.3 kWh export
            makeEnergyRow({ load_power: 200, solar_power: 0,   grid_power: 200 })   // 0.2 kWh import
        ];
        const t = sumTodayRows(rows);
        expect(t.homeKwh).toBeCloseTo(0.8);
        expect(t.solarKwh).toBeCloseTo(0.6);
        expect(t.importKwh).toBeCloseTo(0.8);
        expect(t.exportKwh).toBeCloseTo(0.3);
        expect(t.gridNetKwh).toBeCloseTo(0.5);
    });

    it('reports the latest non-null battery_soc by timestamp', () => {
        const rows = [
            makeEnergyRow({ timestamp: new Date('2026-05-11T07:00:00Z'), battery_soc: 40 }),
            makeEnergyRow({ timestamp: new Date('2026-05-11T07:30:00Z'), battery_soc: 49 }),
            makeEnergyRow({ timestamp: new Date('2026-05-11T07:15:00Z'), battery_soc: 45 })
        ];
        expect(sumTodayRows(rows).latestBatterySoc).toBe(49);
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

describe('EnergyRepo.getCycleAndTodayTotals', () => {
    it('calls getUsageByTOU once for the cycle window and once for today', async () => {
        const repo = new EnergyRepo();
        const cycleResult = [
            { start: new Date(), homeUsage: 100, gridUsage: -50, solarProduction: 200, batteryChange: 0,
              tariff: { id: 1, site_id: 's', updated: new Date(), name: 'On-Peak' }, touName: 'On-Peak',
              buyRate: 0.3, sellRate: 0.03, cost: 0 } as UsageData
        ];
        const todayResult = [
            { start: new Date(), homeUsage: 10, gridUsage: -5, solarProduction: 20, batteryChange: 0,
              tariff: { id: 1, site_id: 's', updated: new Date(), name: 'On-Peak' }, touName: 'On-Peak',
              buyRate: 0.3, sellRate: 0.03, cost: 0 } as UsageData
        ];

        const spy = vi.spyOn(repo, 'getUsageByTOU')
            .mockResolvedValueOnce(cycleResult)
            .mockResolvedValueOnce(todayResult);

        const cycleStart = new Date(2026, 2, 1);
        const todayStart = new Date(2026, 2, 10);
        const end = new Date(2026, 2, 10, 18, 0, 0);

        const result = await repo.getCycleAndTodayTotals('site-1', cycleStart, todayStart, end);

        expect(spy).toHaveBeenCalledTimes(2);
        expect(spy).toHaveBeenNthCalledWith(1, 'site-1', cycleStart, end);
        expect(spy).toHaveBeenNthCalledWith(2, 'site-1', todayStart, end);
        expect(result.cycle).toEqual(cycleResult);
        expect(result.today).toEqual(todayResult);
    });

    it('returns empty arrays when the site has no data', async () => {
        const repo = new EnergyRepo();
        vi.spyOn(repo, 'getUsageByTOU').mockResolvedValue([]);

        const result = await repo.getCycleAndTodayTotals(
            'site-1',
            new Date(2026, 2, 1),
            new Date(2026, 2, 10),
            new Date(2026, 2, 10, 18, 0, 0)
        );

        expect(result.cycle).toEqual([]);
        expect(result.today).toEqual([]);
    });
});

describe('EnergyRepo.insertEnergyDataBatch conflict target', () => {
    it('upserts on (timestamp, site_id) and refreshes tariff_id', async () => {
        queryMock.mockResolvedValueOnce({ rows: [] });
        await new EnergyRepo().insertEnergyDataBatch([{
            site_id: 'site-1', tariff_id: 2, tariff_schedule_id: 20,
            timestamp: new Date('2026-05-11T07:00:00Z'),
            load_power: 1, solar_power: 2, grid_power: 3, battery_power: 4, battery_soc: 50,
        }]);
        const sql = String(queryMock.mock.calls.at(-1)?.[0] ?? '');
        expect(sql).toContain('ON CONFLICT(timestamp, site_id) DO UPDATE');
        expect(sql).toContain('tariff_id = EXCLUDED.tariff_id');
        expect(sql).not.toContain('ON CONFLICT(timestamp, site_id, tariff_id)');
    });
});

describe('EnergyRepo.getUsageByTOU historical name resolution', () => {
    it('resolves a tariff_id from an older version to its name (not Unknown)', async () => {
        const repo = new EnergyRepo();

        vi.spyOn(SiteRepo.prototype, 'getSite').mockResolvedValue({
            id: 'site-1', user_id: 'u1', name: 'Home', utility: 'PG&E',
            updated: new Date(), installed: new Date('2026-01-01T00:00:00Z'),
            timezone: 'UTC', billing_start_day: 1,
            tariffs: [{ id: 2, site_id: 'site-1', name: 'PG&E v2', updated: new Date(), seasons: [] }],
        } as never);

        // All versions: current v2 (id 2) plus historical v1 (id 1).
        vi.spyOn(TariffRepo.prototype, 'getTariffsForSite').mockResolvedValue([
            { id: 1, site_id: 'site-1', name: 'PG&E v1', updated: new Date() },
            { id: 2, site_id: 'site-1', name: 'PG&E v2', updated: new Date() },
        ] as never);

        vi.spyOn(TariffRepo.prototype, 'getSchedulesForSite').mockResolvedValue([]);

        // One historical aggregate row stamped with the old version's tariff_id (1).
        vi.spyOn(repo, 'getCycleAggregates').mockResolvedValue([{
            day: new Date('2026-02-01T00:00:00Z'),
            tariff_id: 1, tariff_schedule_id: null,
            load_power: 10, solar_power: 0, grid_power: 10, battery_power: 0,
        }] as never);
        vi.spyOn(repo, 'getRawEnergyData').mockResolvedValue([] as never);

        const usage = await repo.getUsageByTOU('site-1',
            new Date('2026-02-01T00:00:00Z'), new Date('2026-02-02T00:00:00Z'));

        const row = usage.find((u) => u.tariff?.id === 1);
        expect(row).toBeDefined();
        expect(row!.tariff.name).toBe('PG&E v1');
    });

    it('resolves a tariff_schedule_id from an older version to its name and rates', async () => {
        const repo = new EnergyRepo();

        vi.spyOn(SiteRepo.prototype, 'getSite').mockResolvedValue({
            id: 'site-1', user_id: 'u1', name: 'Home', utility: 'PG&E',
            updated: new Date(), installed: new Date('2026-01-01T00:00:00Z'),
            timezone: 'UTC', billing_start_day: 1,
            tariffs: [{ id: 2, site_id: 'site-1', name: 'PG&E v2', updated: new Date(), seasons: [] }],
        } as never);

        // All versions: current v2 (id 2) plus historical v1 (id 1).
        vi.spyOn(TariffRepo.prototype, 'getTariffsForSite').mockResolvedValue([
            { id: 1, site_id: 'site-1', name: 'PG&E v1', updated: new Date() },
            { id: 2, site_id: 'site-1', name: 'PG&E v2', updated: new Date() },
        ] as never);

        // Historical schedules: current + historical
        vi.spyOn(TariffRepo.prototype, 'getSchedulesForSite').mockResolvedValue([
            { id: 10, season_id: 100, name: 'OFF_PEAK', buy_rate: 0.25, sell_rate: 0.05, from_day_of_week: 0, to_day_of_week: 6, from_hour: 0, from_minute: 0, to_hour: 24, to_minute: 0 },
            { id: 20, season_id: 200, name: 'ON_PEAK', buy_rate: 0.50, sell_rate: 0.10, from_day_of_week: 0, to_day_of_week: 6, from_hour: 0, from_minute: 0, to_hour: 24, to_minute: 0 },
        ] as never);

        // One historical aggregate row stamped with the old version's tariff_id (1) and tariff_schedule_id (10).
        vi.spyOn(repo, 'getCycleAggregates').mockResolvedValue([{
            day: new Date('2026-02-01T00:00:00Z'),
            tariff_id: 1, tariff_schedule_id: 10,
            load_power: 10, solar_power: 0, grid_power: 10, battery_power: 0,
        }] as never);
        vi.spyOn(repo, 'getRawEnergyData').mockResolvedValue([] as never);

        const usage = await repo.getUsageByTOU('site-1',
            new Date('2026-02-01T00:00:00Z'), new Date('2026-02-02T00:00:00Z'));

        const row = usage.find((u) => u.tariff?.id === 1);
        expect(row).toBeDefined();
        expect(row!.touName).toBe('OFF_PEAK');
        expect(row!.buyRate).toBe(0.25);
        expect(row!.sellRate).toBe(0.05);
    });
});
