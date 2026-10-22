import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const { queryMock } = vi.hoisted(() => ({
    queryMock: vi.fn()
}));

vi.mock('./db', () => ({
    pool: {
        query: queryMock,
        connect: async()=>({query:queryMock,release:vi.fn()})
    }
}));

import { EnergyRepo, sumTodayRows } from './energy-repo';
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

describe('EnergyRepo.getLatestEnergyData snapshot bounds', () => {
    it('limits the latest-row read to the requested snapshot instant', async () => {
        queryMock.mockReset();
        queryMock.mockResolvedValueOnce({ rows: [] });
        const asOf = new Date('2026-08-27T22:25:00.000Z');

        await new EnergyRepo().getLatestEnergyData('site-1', asOf);

        const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
        expect(sql).toMatch(/timestamp\s*<=\s*\$2/);
        expect(sql).toMatch(/ORDER BY timestamp DESC/);
        expect(params).toEqual(['site-1', asOf]);
    });
});

describe('EnergyRepo.getCycleAggregates', () => {
    const start = new Date('2026-04-01T00:00:00Z');
    const end   = new Date('2026-04-28T00:00:00Z');

    beforeEach(() => {
        queryMock.mockReset();
    });

    it('uses explicit local midnight for chart aggregates regardless of database timezone', async () => {
        queryMock.mockResolvedValue({ rows: [] });
        const repo = new EnergyRepo();
        await repo.getCycleAggregatesAndCoverage('site-1', start, end, 'America/Chicago');
        expect(queryMock).toHaveBeenCalledWith(
            expect.stringContaining("date_trunc('day', timestamp, $4::text)"),
            ['site-1', start, end, 'America/Chicago']);
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

describe('EnergyRepo.getDailyCoverage', () => {
    const start = new Date('2026-03-08T06:00:00Z');
    const end   = new Date('2026-03-09T05:00:00Z');

    beforeEach(() => {
        queryMock.mockReset();
    });

    it('maps pg numeric strings to numbers and gap seconds to ms', async () => {
        queryMock.mockResolvedValueOnce({
            rows: [{
                local_day_key: '2026-03-08',
                count: '288',
                first: new Date('2026-03-08T06:00:00Z'),
                last: new Date('2026-03-09T04:55:00Z'),
                max_gap_sec: '300',
            }]
        });

        const repo = new EnergyRepo();
        const result = await repo.getDailyCoverage('site-1', start, end, 'America/Chicago');

        expect(result).toEqual([{
            localDayKey: '2026-03-08',
            count: 288,
            first: new Date('2026-03-08T06:00:00Z'),
            last: new Date('2026-03-09T04:55:00Z'),
            maxInteriorGapMs: 300000,
        }]);
    });

    it('buckets days explicitly by site timezone with LAG and GROUP BY local_day', async () => {
        queryMock.mockResolvedValueOnce({ rows: [] });

        const repo = new EnergyRepo();
        await repo.getDailyCoverage('site-1', start, end, 'America/Chicago');

        const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
        expect(sql).toContain('date_trunc(\'day\', timestamp AT TIME ZONE $4::text)');
        // The LAG window must be partitioned by the *same* site-local day
        // expression as the projection above. A session-timezone form (or no
        // partitioning at all) would compute the interior gap across the wrong
        // grouping, which no other assertion here would catch.
        expect(sql).toContain('PARTITION BY date_trunc(\'day\', timestamp AT TIME ZONE $4::text)');
        expect(sql).toContain('LAG(timestamp) OVER');
        expect(sql).toContain('GROUP BY local_day');
        expect(sql).toContain('to_char(local_day, \'YYYY-MM-DD\')');
        expect(params).toEqual(['site-1', start.toISOString(), end.toISOString(), 'America/Chicago']);
    });

    it('falls back to UTC for an invalid timezone instead of throwing', async () => {
        queryMock.mockResolvedValueOnce({ rows: [] });

        const repo = new EnergyRepo();
        await expect(
            repo.getDailyCoverage('site-1', start, end, 'Not/AZone')
        ).resolves.toEqual([]);

        const params = queryMock.mock.calls[0][1] as unknown[];
        expect(params[3]).toBe('UTC');
    });
});

describe('EnergyRepo.countAlignedSamples', () => {
    beforeEach(() => queryMock.mockReset());

    it('counts 5-minute-aligned rows per site window in one query', async () => {
        queryMock.mockResolvedValueOnce({ rows: [{ site_id: 'a', n: '4032' }, { site_id: 'b', n: 12 }] });
        const windows = [
            { siteId: 'a', start: new Date('2026-10-04T05:00:00Z'), end: new Date('2026-10-18T05:00:00Z') },
            { siteId: 'b', start: new Date('2026-10-04T07:00:00Z'), end: new Date('2026-10-18T07:00:00Z') },
        ];

        const counts = await new EnergyRepo().countAlignedSamples(windows);

        expect(counts).toEqual(new Map([['a', 4032], ['b', 12]]));
        expect(queryMock).toHaveBeenCalledTimes(1);
        const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
        expect(sql).toContain('unnest($1::text[], $2::timestamp[], $3::timestamp[])');
        expect(sql).toContain('% 300 = 0');
        expect(params).toEqual([
            ['a', 'b'],
            ['2026-10-04T05:00:00.000Z', '2026-10-04T07:00:00.000Z'],
            ['2026-10-18T05:00:00.000Z', '2026-10-18T07:00:00.000Z'],
        ]);
    });

    it('skips the query when there are no windows', async () => {
        await expect(new EnergyRepo().countAlignedSamples([])).resolves.toEqual(new Map());
        expect(queryMock).not.toHaveBeenCalled();
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
    afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});
    it('shares request inputs while preserving independent cycle and today netting',async()=>{
        vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-10-07T15:00:00Z'));
        const repo=new EnergyRepo();
        const todayStart=new Date('2026-10-07T05:00:00Z'),cycleStart=new Date('2026-10-01T05:00:00Z'),end=new Date('2026-10-07T15:00:00Z');
        const schedule={id:10,season_id:1,name:'Standard',buy_rate:.3,sell_rate:.04,from_day_of_week:0,to_day_of_week:6,from_hour:0,to_hour:24,from_minute:0,to_minute:0};
        const tariff={id:1,site_id:'site-1',name:'Utility',updated:new Date(),seasons:[{id:1,tariff_id:1,name:'All',from_month:1,from_day:1,to_month:12,to_day:31,buy_rate:.3,sell_rate:.04,schedules:[schedule]}]};
        const site=vi.spyOn(SiteRepo.prototype,'getSite').mockResolvedValue({id:'site-1',timezone:'America/Chicago',tariffs:[tariff]} as never);
        const versions=vi.spyOn(TariffRepo.prototype,'getTariffsForSite').mockResolvedValue([tariff]);
        const schedules=vi.spyOn(TariffRepo.prototype,'getSchedulesForSite').mockResolvedValue([schedule]);
        const aggregate=vi.spyOn(repo,'getCycleAggregates').mockImplementation(async(_site,start,end)=>start<end?[{day:cycleStart,tariff_id:1,tariff_schedule_id:10,load_power:2000,solar_power:0,grid_power:2000,battery_power:0}]:[]);
        const raw=vi.spyOn(repo,'getRawEnergyData').mockResolvedValue([makeEnergyRow({timestamp:new Date('2026-10-07T10:00:00Z'),grid_power:-1000,tariff_schedule_id:10})]);
        const expected={cycle:await repo.getUsageByTOU('site-1',cycleStart,end),today:await repo.getUsageByTOU('site-1',todayStart,end)};
        expect(expected.cycle[0].cost).toBeCloseTo(.3);expect(expected.today[0].cost).toBeCloseTo(-.04);
        for(const spy of [site,versions,schedules,aggregate,raw])spy.mockClear();
        expect(await repo.getCycleAndTodayTotals('site-1',cycleStart,todayStart,end)).toEqual(expected);
        for(const spy of [site,versions,schedules,aggregate,raw])expect(spy).toHaveBeenCalledTimes(1);
    });
    it.each([
        ['historical','2026-10-01','2026-10-03','2026-10-04'],
        ['future cycle','2026-10-09','2026-10-07','2026-10-10'],
        ['same start','2026-10-01','2026-10-01','2026-10-04'],
        ['reversed cycle','2026-10-09','2026-10-01','2026-10-04'],
    ])('preserves independent results for %s ranges',async(_label,cycle,today,until)=>{
        vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-10-07T15:00:00Z'));
        const repo=new EnergyRepo();const cycleStart=new Date(cycle),todayStart=new Date(today),end=new Date(until);
        const tariff={id:1,site_id:'site-1',name:'Utility',updated:new Date(),seasons:[]};
        vi.spyOn(SiteRepo.prototype,'getSite').mockResolvedValue({id:'site-1',timezone:'UTC',tariffs:[tariff]} as never);
        vi.spyOn(TariffRepo.prototype,'getTariffsForSite').mockResolvedValue([tariff]);
        vi.spyOn(TariffRepo.prototype,'getSchedulesForSite').mockResolvedValue([]);
        const samples=['2026-10-01','2026-10-03','2026-10-07','2026-10-09'].map((day,i)=>makeEnergyRow({timestamp:new Date(day+'T10:00:00Z'),grid_power:i%2?-1000:2000,tariff_schedule_id:null}));
        vi.spyOn(repo,'getRawEnergyData').mockImplementation(async(_id,start,end)=>samples.filter(r=>r.timestamp>=start&&r.timestamp<end));
        vi.spyOn(repo,'getCycleAggregates').mockImplementation(async(_id,start,end)=>samples.filter(r=>r.timestamp>=start&&r.timestamp<end).map(r=>({day:new Date(r.timestamp.toISOString().slice(0,10)),tariff_id:r.tariff_id,tariff_schedule_id:r.tariff_schedule_id??null,load_power:r.load_power,solar_power:r.solar_power,grid_power:r.grid_power,battery_power:r.battery_power})));
        const expected={cycle:await repo.getUsageByTOU('site-1',cycleStart,end),today:await repo.getUsageByTOU('site-1',todayStart,end)};
        expect(await repo.getCycleAndTodayTotals('site-1',cycleStart,todayStart,end)).toEqual(expected);
    });
    it('returns empty arrays for a missing site without tariff or energy reads',async()=>{
        const repo=new EnergyRepo();const site=vi.spyOn(SiteRepo.prototype,'getSite').mockResolvedValue(undefined);
        const raw=vi.spyOn(repo,'getRawEnergyData');
        expect(await repo.getCycleAndTodayTotals('site-1',new Date(0),new Date(1000),new Date(2000))).toEqual({cycle:[],today:[]});
        expect(site).toHaveBeenCalledTimes(1);expect(raw).not.toHaveBeenCalled();
    });
});

describe('EnergyRepo.insertEnergyDataBatch conflict target', () => {
    it('upserts on (timestamp, site_id) and refreshes tariff_id', async () => {
        queryMock.mockResolvedValue({rows:[]});
        queryMock.mockResolvedValueOnce({ rows: [] });
        await new EnergyRepo().insertEnergyDataBatch([{
            site_id: 'site-1', tariff_id: 2, tariff_schedule_id: 20,
            timestamp: new Date('2026-05-11T07:00:00Z'),
            load_power: 1, solar_power: 2, grid_power: 3, battery_power: 4, battery_soc: 50,
        }]);
        const sql = String(queryMock.mock.calls.find(([sql])=>String(sql).includes('INSERT INTO'))?.[0] ?? '');
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

describe('EnergyRepo.getUsageByTOU range clamping', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('does not fetch raw rows from before a future cycle start', async () => {
        const repo = new EnergyRepo();
        vi.spyOn(SiteRepo.prototype, 'getSite').mockResolvedValue({
            id: 'site-1', user_id: 'u1', name: 'Home', utility: 'PG&E',
            updated: new Date(), installed: new Date('2026-01-01T00:00:00Z'),
            timezone: 'UTC', billing_start_day: 1, tariffs: [],
        } as never);
        vi.spyOn(TariffRepo.prototype, 'getTariffsForSite').mockResolvedValue([] as never);
        vi.spyOn(TariffRepo.prototype, 'getSchedulesForSite').mockResolvedValue([] as never);
        const aggSpy = vi.spyOn(repo, 'getCycleAggregates').mockResolvedValue([] as never);
        const rawSpy = vi.spyOn(repo, 'getRawEnergyData').mockResolvedValue([] as never);

        // A cycle entirely in the future: splitPoint must not drop below start,
        // or the raw pass fetches [todayMidnight, end) — rows preceding the cycle.
        const start = new Date(Date.now() + 30 * 24 * 3600 * 1000);
        const end = new Date(Date.now() + 60 * 24 * 3600 * 1000);
        await repo.getUsageByTOU('site-1', start, end);

        expect(aggSpy).toHaveBeenCalledWith('site-1', start, start);
        expect(rawSpy).toHaveBeenCalledWith('site-1', start, end);
    });
});


describe('EnergyRepo.getBillOutlook', () => {
    afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
    it.each([false, true])('reads once, respects the 25-hour DST day and marks gaps (%s)', async (gap) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-11-02T06:10:00Z'));
        const start = new Date('2026-11-01T05:00:00Z');
        const midnight = new Date('2026-11-02T06:00:00Z');
        const end = new Date('2026-12-01T06:00:00Z');
        const schedule = { id: 10, season_id: 1, name: 'Standard', buy_rate: .3, sell_rate: .04,
            from_day_of_week: 0, to_day_of_week: 6, from_hour: 0, to_hour: 24, from_minute: 0, to_minute: 0 };
        const tariff = { id: 1, site_id: 'site-1', name: 'Utility', updated: new Date(), seasons: [
            { id: 1, tariff_id: 1, name: 'All', from_month: 1, from_day: 1, to_month: 12, to_day: 31,
                buy_rate: .3, sell_rate: .04, schedules: [schedule] }] };
        vi.spyOn(SiteRepo.prototype, 'getSite').mockResolvedValue({ id: 'site-1', timezone: 'America/Chicago', tariffs: [tariff] } as never);
        vi.spyOn(TariffRepo.prototype, 'getTariffsForSite').mockResolvedValue([tariff]);
        vi.spyOn(TariffRepo.prototype, 'getSchedulesForSite').mockResolvedValue([schedule]);
        const repo = new EnergyRepo();
        const prior = vi.spyOn(repo, 'getCycleAggregatesAndCoverage').mockResolvedValue({
            aggregates: [{ day: start, tariff_id: 1, tariff_schedule_id: 10, load_power: 0, solar_power: 0,
                grid_power: 10000, battery_power: 0 }],
            coverage: [{ localDayKey: '2026-11-01', count: gap ? 299 : 300, first: start,
                last: new Date(+midnight - 300000), maxInteriorGapMs: gap ? 600000 : 300000 }],
        });
        const raw = vi.spyOn(repo, 'getRawEnergyData').mockResolvedValue([
            makeEnergyRow({ timestamp: midnight, grid_power: -500 }),
            makeEnergyRow({ timestamp: new Date(+midnight + 300000), grid_power: -500 }),
        ]);
        const result = await repo.getBillOutlook('site-1', start, end);
        expect(prior).toHaveBeenCalledTimes(1);
        expect(raw).toHaveBeenCalledTimes(1);
        expect(prior).toHaveBeenCalledWith('site-1', start, midnight, 'America/Chicago');
        expect(result.outlook?.points.map(point => point.date)).toEqual([
            start.toISOString(), midnight.toISOString(), '2026-11-02T06:10:00.000Z']);
        expect(result.outlook?.complete).toBe(!gap);
        expect(result.outlook?.points.at(-1)?.estimatedCost).toBeCloseTo(result.usage.reduce((sum, row) => sum + (row.cost ?? 0), 0));
        expect(result.outlook?.points.at(-1)?.periods[0].netGridKwh).toBe(9);
    });
});
