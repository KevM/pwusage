import { describe, it, expect } from 'vitest';
import { aggregateUsage } from './tou-aggregation';
import { Schedule } from './schedule';
import { SiteWithTariffs, EnergyData, Tariff } from './db';
import { CycleAggregateRow } from './energy-repo';

function makeTestTariff(): Tariff[] {
    return [
        {
            id: 1,
            site_id: 'test_site',
            name: 'Test Tariff',
            updated: new Date('2026-01-01'),
            seasons: [
                {
                    id: 1,
                    tariff_id: 1,
                    name: 'Winter',
                    from_month: 1, from_day: 1,
                    to_month: 12, to_day: 31,
                    buy_rate: 0.20, sell_rate: 0.10,
                    schedules: [
                        {
                            id: 10, season_id: 1, name: 'Off-Peak',
                            buy_rate: 0.15, sell_rate: 0.08,
                            from_day_of_week: 0, to_day_of_week: 6,
                            from_hour: 20, from_minute: 0,
                            to_hour: 7, to_minute: 0,
                        },
                        {
                            id: 20, season_id: 1, name: 'On-Peak',
                            buy_rate: 0.30, sell_rate: 0.15,
                            from_day_of_week: 0, to_day_of_week: 6,
                            from_hour: 7, from_minute: 0,
                            to_hour: 20, to_minute: 0,
                        }
                    ]
                }
            ]
        }
    ];
}

const TZ = 'America/New_York';

describe('TOU Aggregation Utility', () => {
    it('handles basic aggregation, including schedule-id lookup vs midpoint fallback and credit cost math', () => {
        const tariffs = makeTestTariff();
        const site: SiteWithTariffs = {
            id: 'test_site',
            name: 'Test Site',
            timezone: TZ,
            billing_start_day: 1,
            updated: new Date(),
            installed: new Date(),
            json: {},
            tariffs
        };

        const schedule = new Schedule(tariffs, TZ);

        // Pass 1: Prior day aggregates
        // Row 1: has schedule id 10 (Off-Peak) -> buy_rate = 0.15, sell_rate = 0.08
        // Row 2: has null schedule id -> fallback to midpoint of the day (e.g. 12:00 UTC -> 07:00 local NY)
        // Midpoint of Jan 15 in New York: 12:00 in UTC is 07:00 local in NY, which is On-Peak (buy=0.30, sell=0.15)
        const priorAggregates: CycleAggregateRow[] = [
            {
                day: new Date('2026-01-15T00:00:00Z'), // Day itself
                tariff_id: 1,
                tariff_schedule_id: 10, // Off-Peak
                load_power: 1000, // 1000 Wh = 1 kWh
                solar_power: 500,
                grid_power: 500, // importing -> cost should be 0.5 * 0.15 = 0.075
                battery_power: 0
            },
            {
                day: new Date('2026-01-15T00:00:00Z'), // UTC Midnight. Midpoint is +12h = 12:00 UTC = 07:00 local. On-Peak.
                tariff_id: 1,
                tariff_schedule_id: null, // trigger midpoint fallback
                load_power: 2000, // 2 kWh
                solar_power: 3000,
                grid_power: -1000, // exporting -> credit: -1 * 0.15 = -0.15
                battery_power: 0
            }
        ];

        // Pass 2: Today's raw rows
        // Today is On-Peak (10:00 NY local = 15:00 UTC)
        // Today is Off-Peak (22:00 NY local = 03:00 UTC next day)
        const todayRaw: EnergyData[] = [
            {
                timestamp: new Date('2026-01-16T15:00:00Z'), // 10:00 NY local -> On-Peak
                site_id: 'test_site',
                tariff_id: 1,
                tariff_schedule_id: null,
                load_power: 2000, // 2 kWh
                solar_power: 1000,
                grid_power: 1000, // import -> 1 * 0.30 = 0.30
                battery_power: 0,
                battery_soc: 85
            },
            {
                timestamp: new Date('2026-01-17T03:00:00Z'), // 22:00 NY local -> Off-Peak
                site_id: 'test_site',
                tariff_id: 1,
                tariff_schedule_id: null,
                load_power: 1000, // 1 kWh
                solar_power: 0,
                grid_power: 1000, // import -> 1 * 0.15 = 0.15
                battery_power: 0,
                battery_soc: 80
            }
        ];

        const result = aggregateUsage(site, priorAggregates, todayRaw, schedule);

        expect(result.latestSeriesSoc?.value).toBe(80);
        expect(result.seriesData.length).toBe(2);

        // Verify grouping and cost calculation:
        // - Off-Peak: 500W prior + 1000W today = 1.5 kWh net grid usage (buying).
        //   Cost = 1.5 * 0.15 = 0.225.
        // - On-Peak: -1000W prior (credit) + 1000W today = 0 kWh net grid usage.
        //   Cost = 0.
        // - Total Bill Cost = 0.225 + 0 = 0.225.
        expect(result.totalBillCost).toBeCloseTo(0.225);


        // Verify tariffGroups structure
        expect(result.tariffGroups.length).toBe(1);
        const group = result.tariffGroups[0];
        expect(group.tariffName).toBe('Test Tariff');
        expect(group.periods.length).toBe(2);

        const offPeakPeriod = group.periods.find(p => p.touName === 'Off-Peak');
        const onPeakPeriod = group.periods.find(p => p.touName === 'On-Peak');

        expect(offPeakPeriod).toBeDefined();
        expect(offPeakPeriod?.grid).toBe(1500); // 500 + 1000
        expect(offPeakPeriod?.cost).toBeCloseTo(0.225);

        expect(onPeakPeriod).toBeDefined();
        expect(onPeakPeriod?.grid).toBe(0); // -1000 + 1000
        expect(onPeakPeriod?.cost).toBeCloseTo(0.0);
    });

    it('calculates credit correctly for negative net grid usage', () => {
        const tariffs = makeTestTariff();
        const site: SiteWithTariffs = {
            id: 'test_site',
            name: 'Test Site',
            timezone: TZ,
            billing_start_day: 1,
            updated: new Date(),
            installed: new Date(),
            json: {},
            tariffs
        };
        const schedule = new Schedule(tariffs, TZ);

        // Entire cycle is exporting
        const priorAggregates: CycleAggregateRow[] = [
            {
                day: new Date('2026-01-15T00:00:00Z'),
                tariff_id: 1,
                tariff_schedule_id: 10, // Off-Peak: buy=0.15, sell=0.08
                load_power: 0,
                solar_power: 2000,
                grid_power: -2000, // exporting 2 kWh -> credit = -2 * 0.08 = -0.16
                battery_power: 0
            }
        ];

        const result = aggregateUsage(site, priorAggregates, [], schedule);
        expect(result.totalBillCost).toBeCloseTo(-0.16);
    });

    it('resolves prior-cycle rows tagged with an older tariff version via historical maps', () => {
        const tariffs = makeTestTariff(); // current version: tariff id 1, schedules 10/20
        const site: SiteWithTariffs = {
            id: 'test_site',
            name: 'Test Site',
            timezone: TZ,
            billing_start_day: 1,
            updated: new Date(),
            installed: new Date(),
            json: {},
            tariffs
        };
        const schedule = new Schedule(tariffs, TZ);

        // A row imported under a PREVIOUS tariff version (tariff 99 / schedule 990),
        // which is no longer in site.tariffs because is_current = false.
        const priorAggregates: CycleAggregateRow[] = [
            {
                day: new Date('2026-01-10T00:00:00Z'),
                tariff_id: 99,
                tariff_schedule_id: 990,
                load_power: 1000,
                solar_power: 0,
                grid_power: 2000, // 2 kWh import
                battery_power: 0
            }
        ];

        const historicalTariffs: Tariff[] = [
            { id: 99, site_id: 'test_site', name: 'Old Tariff', updated: new Date('2025-06-01') }
        ];
        const historicalSchedules = [
            {
                id: 990, season_id: 900, name: 'Old-Peak',
                buy_rate: 0.25, sell_rate: 0.12,
                from_day_of_week: 0, to_day_of_week: 6,
                from_hour: 0, from_minute: 0,
                to_hour: 24, to_minute: 0,
            }
        ];

        const result = aggregateUsage(
            site, priorAggregates, [], schedule,
            historicalTariffs, historicalSchedules
        );

        const oldGroup = result.tariffGroups.find(g => g.tariffName === 'Old Tariff');
        expect(oldGroup).toBeDefined();
        const period = oldGroup!.periods.find(p => p.touName === 'Old-Peak');
        expect(period).toBeDefined();
        // 2 kWh import at the historical 0.25 buy rate
        expect(period!.cost).toBeCloseTo(0.5, 5);
        expect(result.totalBillCost).toBeCloseTo(0.5, 5);
    });

    it('still reports Unknown/$0 without historical maps (documents the pre-fix fallback)', () => {
        const tariffs = makeTestTariff();
        const site: SiteWithTariffs = {
            id: 'test_site', name: 'Test Site', timezone: TZ, billing_start_day: 1,
            updated: new Date(), installed: new Date(), json: {}, tariffs
        };
        const schedule = new Schedule(tariffs, TZ);
        const priorAggregates: CycleAggregateRow[] = [
            {
                day: new Date('2026-01-10T00:00:00Z'),
                tariff_id: 99,
                tariff_schedule_id: 990,
                load_power: 1000, solar_power: 0, grid_power: 2000, battery_power: 0
            }
        ];

        const result = aggregateUsage(site, priorAggregates, [], schedule);
        // Without version history the row can't be priced — cost stays 0.
        expect(result.totalBillCost).toBe(0);
    });
});
