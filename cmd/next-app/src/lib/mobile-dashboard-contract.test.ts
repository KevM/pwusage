import { describe, expect, it } from 'vitest';
import { buildMobileDashboardContract, maxBucketSampleTimestamp, sumBucketedTodayRows, withMobileBillSummary } from './mobile-dashboard-contract';
import { Schedule } from './schedule';
import { EnergyRepo } from './energy-repo';
import type { EnergyData, Tariff } from './db-types';

describe('buildMobileDashboardContract', () => {
    const base = {
        site: { id: 'site-a', name: 'Home', timezone: 'America/Chicago' },
        live: { solar_power: 1200, load_power: 900, battery_power: -100, grid_power: 200, percentage_charged: 73, timestamp: '2026-09-23T12:00:00Z' },
        energyTimestamp: new Date('2026-09-23T11:55:00Z'),
        now: new Date('2026-09-23T12:01:00Z'),
        activeTariff: 'Peak',
        today: { homeKwh: 4, solarKwh: 5, gridNetKwh: -1, importKwh: 2, exportKwh: 3, batteryNetKwh: 0.5 },
        todayComplete: true,
        bill: { estimatedCost: 12.34, currency: 'USD', cycleStart: new Date('2026-09-01T05:00:00Z'), cycleEnd: new Date('2026-10-01T05:00:00Z') },
        todayDate: '2026-09-23',
    };

    it('builds a compact versioned contract scoped to the requested site', () => {
        const result = buildMobileDashboardContract(base);

        expect(result.site).toEqual({ id: 'site-a', name: 'Home', timezone: 'America/Chicago', localDate: '2026-09-23' });
        expect(result.version).toBe(1);
        expect(result.live).toEqual({ solarPower: 1200, loadPower: 900, batteryPower: -100, gridPower: 200 });
        expect(result.today).toEqual(base.today);
        expect(result.currentBill?.periods).toEqual([]);
        expect(JSON.stringify(result)).not.toContain('tariff_content_v2');
    });

    it('retains a recent last-known SoC with its source time', () => {
        const result = buildMobileDashboardContract({
            ...base,
            live: { ...base.live, timestamp: '2026-09-23T11:40:00Z' },
            now: new Date('2026-09-23T12:01:00Z'),
        });

        expect(result.stateOfCharge).toBe(73);
        expect(result.sources.stateOfChargeAt).toBe('2026-09-23T11:40:00.000Z');
    });

    it('uses a recent stored SoC when the live response omits charge', () => {
        const result = buildMobileDashboardContract({
            ...base,
            live: { ...base.live, percentage_charged: null },
            fallbackSoc: { value: 68, timestamp: new Date('2026-09-23T11:30:00Z') },
        });
        expect(result.stateOfCharge).toBe(68);
        expect(result.sources.stateOfChargeAt).toBe('2026-09-23T11:30:00.000Z');
    });

    it('hides an SoC older than two hours', () => {
        const result = buildMobileDashboardContract({
            ...base,
            live: { ...base.live, timestamp: '2026-09-23T09:00:00Z' },
        });
        expect(result.stateOfCharge).toBeNull();
        expect(result.sources.stateOfChargeAt).toBeNull();
    });

    it('preserves source timestamps and site-local cycle boundaries as instants', () => {
        const result = buildMobileDashboardContract(base);

        expect(result.sources.liveStatusAt).toBe('2026-09-23T12:00:00.000Z');
        expect(result.sources.energyDataThrough).toBe('2026-09-23T11:55:00.000Z');
        expect(result.currentBill?.cycleStart).toBe('2026-09-01T05:00:00.000Z');
        expect(result.currentBill?.cycleEnd).toBe('2026-10-01T05:00:00.000Z');
    });

    it('combines the slower exact bill summary only when it belongs to the same site', () => {
        const dashboard = buildMobileDashboardContract({ ...base, bill: null });
        const summary = {
            version: 1,
            site: { id: 'site-a', name: 'Home', timezone: 'America/Chicago' },
            currentBill: {
                estimatedCost: 12.34, currency: 'USD',
                cycleStart: '2026-09-01T05:00:00.000Z', cycleEnd: '2026-10-01T05:00:00.000Z',
                periods: [{ tariffName: 'Old tariff', periodName: 'Peak', netGridKwh: -2, cost: 12.34 }],
            },
            sources: { calculatedAt: '2026-09-23T12:01:00.000Z', energyDataThrough: '2026-09-23T12:00:00.000Z' },
        };

        expect(withMobileBillSummary(dashboard, summary).currentBill).toEqual(summary.currentBill);
        expect(withMobileBillSummary(dashboard, summary).currentBill?.periods).toEqual(summary.currentBill.periods);
        const combined = withMobileBillSummary(dashboard, summary);
        expect(combined.sources.energyDataThrough).toBe('2026-09-23T11:55:00.000Z');
        expect(combined.billSources.energyDataThrough).toBe('2026-09-23T12:00:00.000Z');
        expect(() => withMobileBillSummary(dashboard, { ...summary, site: { ...summary.site, id: 'site-b' } })).toThrow(/different sites/);
    });

    it('derives only exact today totals from buckets, omitting gross import/export across mixed signs', () => {
        const totals = sumBucketedTodayRows([
            {
                timestamp: new Date('2026-09-23T04:45:00Z'), site_id: 'site-a', tariff_id: 1,
                tariff_schedule_id: 1, load_power: 1000, solar_power: 500, grid_power: 500,
                battery_power: 0, battery_soc: null, sample_count: 3,
            },
            {
                timestamp: new Date('2026-09-23T05:00:00Z'), site_id: 'site-a', tariff_id: 1,
                tariff_schedule_id: 1, load_power: 1000, solar_power: 500, grid_power: -500,
                battery_power: 0, battery_soc: null, sample_count: 3,
            },
        ], new Date('2026-09-23T05:00:00Z'));

        expect(totals.homeKwh).toBe(3);
        expect(totals.solarKwh).toBe(1.5);
        expect(totals.gridNetKwh).toBe(-1.5);
        expect(totals).not.toHaveProperty('importKwh');
        expect(totals).not.toHaveProperty('exportKwh');
    });

    it('keeps the exact net for opposite-sign samples in one 15-minute bucket', () => {
        const rawRows: EnergyData[] = [1000, -600, -600].map((grid_power, index) => ({
            timestamp: new Date(Date.UTC(2026, 8, 23, 5, index * 5)),
            site_id: 'site-a', tariff_id: 1, tariff_schedule_id: 1,
            load_power: 1000, solar_power: 0, grid_power, battery_power: 0, battery_soc: null,
        }));
        const rawExact = sumBucketedTodayRows(rawRows, new Date('2026-09-23T05:00:00Z'));
        const bucketAggregate: EnergyData[] = [{
            timestamp: new Date('2026-09-23T05:00:00Z'), site_id: 'site-a', tariff_id: 1,
            tariff_schedule_id: 1, load_power: 1000, solar_power: 0, grid_power: -200 / 3,
            battery_power: 0, battery_soc: null, sample_count: 3,
        }];
        const reconstructed = sumBucketedTodayRows(bucketAggregate, new Date('2026-09-23T05:00:00Z'));

        expect(rawExact.gridNetKwh).toBe(-0.2);
        expect(reconstructed.gridNetKwh).toBeCloseTo(rawExact.gridNetKwh);
        expect(reconstructed.homeKwh).toBe(3);
        expect(reconstructed.solarKwh).toBe(0);
        expect(reconstructed.batteryNetKwh).toBe(0);
    });

    it('keeps an intra-bin TOU transition exact by pricing raw 5-minute rows', () => {
        const tariff: Tariff = {
            id: 1, site_id: 'site-a', name: 'Utility tariff', updated: new Date('2026-01-01'),
            seasons: [{
                id: 2, tariff_id: 1, name: 'All year', from_month: 1, from_day: 1, to_month: 12, to_day: 31,
                buy_rate: 0.1, sell_rate: 0.05,
                schedules: [
                    { id: 3, season_id: 2, name: 'Off peak', buy_rate: 0.1, sell_rate: 0.05, from_day_of_week: 0, to_day_of_week: 6, from_hour: 0, from_minute: 0, to_hour: 6, to_minute: 7 },
                    { id: 4, season_id: 2, name: 'Peak', buy_rate: 0.5, sell_rate: 0.05, from_day_of_week: 0, to_day_of_week: 6, from_hour: 6, from_minute: 7, to_hour: 24, to_minute: 0 },
                ],
            }],
        };
        const schedule = new Schedule([tariff], 'UTC');
        const rawRows: EnergyData[] = [0, 5, 10, 15].map((minute) => ({
            timestamp: new Date(`2026-09-23T06:${String(minute).padStart(2, '0')}:00Z`),
            site_id: 'site-a', tariff_id: 1, tariff_schedule_id: minute < 10 ? 3 : 4,
            load_power: 1000, solar_power: 0, grid_power: 1000, battery_power: 0, battery_soc: null,
        }));
        const exactUsage = EnergyRepo.aggregateUsageByTOU({
            siteId: 'site-a', start: new Date('2026-09-01T00:00:00Z'), priorAggregates: [],
            todayRaw: rawRows, schedule, tariffMap: new Map([[1, tariff]]),
            scheduleMap: new Map(tariff.seasons?.[0].schedules?.map((entry) => [entry.id, entry]) ?? []),
        });
        const exactServerCost = exactUsage.reduce((sum, usage) => sum + (usage.cost ?? 0), 0);
        const bucketGroups = [
            { scheduleId: 3, gridWh: 2000 },
            { scheduleId: 4, gridWh: 2000 },
        ];
        const bucketApproximation = bucketGroups.reduce((sum, group) => {
            const rate = schedule.getTariffPeriod(new Date('2026-09-23T06:00:00Z'))?.schedule.buy_rate ?? 0;
            return sum + group.gridWh / 1000 * rate;
        }, 0);

        expect(exactServerCost).toBeCloseTo(1.2);
        expect(bucketApproximation).toBeCloseTo(0.4);
        expect(bucketApproximation).not.toBeCloseTo(exactServerCost);
    });

    it('uses the newest sample timestamp rather than the bucket start for energy freshness', () => {
        const newestSample = maxBucketSampleTimestamp([
            {
                timestamp: new Date('2026-09-23T11:45:00Z'), sample_timestamp: new Date('2026-09-23T11:59:40Z'),
                site_id: 'site-a', tariff_id: 1, tariff_schedule_id: 1, load_power: 1, solar_power: 0,
                grid_power: 1, battery_power: 0, battery_soc: null, sample_count: 3,
            },
            {
                timestamp: new Date('2026-09-23T11:45:00Z'), sample_timestamp: new Date('2026-09-23T11:58:20Z'),
                site_id: 'site-a', tariff_id: 2, tariff_schedule_id: 2, load_power: 1, solar_power: 0,
                grid_power: 1, battery_power: 0, battery_soc: null, sample_count: 2,
            },
        ]);

        expect(newestSample?.toISOString()).toBe('2026-09-23T11:59:40.000Z');
        expect(newestSample?.getTime()).toBeGreaterThan(new Date('2026-09-23T11:45:00Z').getTime());
        expect(maxBucketSampleTimestamp([])).toBeNull();
    });
});
