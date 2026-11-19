import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db', () => ({ pool: { query: vi.fn(), connect: vi.fn() } }));

import type { EnergyData } from './db';
import { EnergyRepo, sumTodayRows, type EnergyHistoryReader } from './energy-repo';
import { readLiveTodayHistory, storedLiveReading, STORED_LIVE_MAX_AGE_MS } from './live-page-data';
import { IncompleteTariffAttributionError } from './billing-availability';
import { SiteRepo } from './site-repo';
import { TariffRepo } from './tariff-repo';

const TZ = 'America/Chicago';
const now = new Date('2026-10-07T15:00:00Z');
const todayStart = new Date('2026-10-07T05:00:00Z');
const cycleStart = new Date('2026-10-01T05:00:00Z');

function row(iso: string, over: Partial<EnergyData> = {}): EnergyData {
    return {
        timestamp: new Date(iso), site_id: 'site-1', tariff_id: 1, tariff_schedule_id: 10,
        load_power: 400, solar_power: 300, grid_power: 100, battery_power: 0, battery_soc: 60, ...over,
    } as EnergyData;
}

/** A populated current day: 5-minute samples from midnight to now. */
const todaySamples = Array.from({ length: 120 }, (_, i) =>
    row(new Date(+todayStart + i * 300000).toISOString(), { grid_power: i % 3 === 0 ? -200 : 150 }));

function countingReader() {
    const reader = {
        getRawEnergyData: vi.fn(async (_id: string, start: Date, end: Date) =>
            todaySamples.filter(r => r.timestamp >= start && r.timestamp < end)),
        getBucketedEnergyData: vi.fn(),
        getCycleAggregates: vi.fn(async () => [{ day: cycleStart, tariff_id: 1, tariff_schedule_id: 10, load_power: 5000, solar_power: 0, grid_power: 5000, battery_power: 0 }]),
    };
    return reader;
}

function mockTariffs() {
    const schedule = { id: 10, season_id: 1, name: 'Standard', buy_rate: .3, sell_rate: .04, from_day_of_week: 0, to_day_of_week: 6, from_hour: 0, to_hour: 24, from_minute: 0, to_minute: 0 };
    const tariff = { id: 1, site_id: 'site-1', name: 'Utility', updated: new Date(), seasons: [{ id: 1, tariff_id: 1, name: 'All', from_month: 1, from_day: 1, to_month: 12, to_day: 31, buy_rate: .3, sell_rate: .04, schedules: [schedule] }] };
    vi.spyOn(SiteRepo.prototype, 'getSite').mockResolvedValue({ id: 'site-1', timezone: TZ, tariffs: [tariff] } as never);
    vi.spyOn(TariffRepo.prototype, 'getTariffsForSite').mockResolvedValue([tariff] as never);
    vi.spyOn(TariffRepo.prototype, 'getSchedulesForSite').mockResolvedValue([schedule] as never);
}

describe('readLiveTodayHistory', () => {
    afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

    it('reads today\'s raw history once and matches the separate reads', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now);
        mockTariffs();
        const reader = countingReader();
        const repo = new EnergyRepo(reader as unknown as EnergyHistoryReader);

        const shared = await readLiveTodayHistory(repo, 'site-1', cycleStart, todayStart, now);
        expect(reader.getRawEnergyData).toHaveBeenCalledTimes(1);
        expect(reader.getBucketedEnergyData).not.toHaveBeenCalled();

        // The former page: billing, chart and totals each read today on their own.
        reader.getRawEnergyData.mockClear();
        const [billing, chart, raw] = await Promise.all([
            repo.getCycleAndTodayTotals('site-1', cycleStart, todayStart, now),
            repo.getRawEnergyData('site-1', todayStart, now).then(rows => repo.getBucketedEnergyData('site-1', todayStart, now, rows)),
            repo.getRawEnergyData('site-1', todayStart, now),
        ]);
        expect(reader.getRawEnergyData).toHaveBeenCalledTimes(3);
        expect(shared.billing.cycle).toEqual(billing.cycle);
        expect(shared.billing.today).toEqual(billing.today);
        expect(shared.billing.today.length).toBeGreaterThan(0);
        expect(shared.todayChartRows).toEqual(chart);
        expect(shared.todayTotals).toEqual(sumTodayRows(raw));
    });

    it('keeps the today-only fallback when cycle pricing is incomplete, still on one read', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now);
        mockTariffs();
        const reader = countingReader();
        const repo = new EnergyRepo(reader as unknown as EnergyHistoryReader);
        vi.spyOn(repo, 'getCycleAndTodayTotals').mockRejectedValue(new IncompleteTariffAttributionError());
        const usage = vi.spyOn(repo, 'getUsageByTOU');

        const shared = await readLiveTodayHistory(repo, 'site-1', cycleStart, todayStart, now);
        expect(shared.billing.cycleStatus).toBe('incomplete-attribution');
        expect(shared.billing.todayStatus).toBe('complete');
        expect(usage).toHaveBeenCalledWith('site-1', todayStart, now, shared.todayRows);
        expect(reader.getRawEnergyData).toHaveBeenCalledTimes(1);
    });
});

describe('storedLiveReading', () => {
    const latest = { timestamp: new Date('2026-10-07T14:55:00Z'), batterySoc: 55, batteryPower: 0, solarPower: 0, gridPower: 0, loadPower: 0 };
    const status = (iso: string) => ({ solar_power: 1000, percentage_charged: 80, battery_power: 0, load_power: 500, grid_power: 0, timestamp: iso });

    it('uses a recent stored live status with its own timestamp', () => {
        const reading = storedLiveReading({ live_status_cache: status('2026-10-07T14:58:00Z'), last_live_refresh_at: +now }, latest, now);
        expect(reading.liveStatus?.percentage_charged).toBe(80);
        expect(reading.asOf).toEqual(new Date('2026-10-07T14:58:00Z'));
    });

    it('does not present an old stored charge as current', () => {
        const old = new Date(+now - STORED_LIVE_MAX_AGE_MS - 1000).toISOString();
        const reading = storedLiveReading({ live_status_cache: status(old) }, latest, now);
        expect(reading.liveStatus).toBeNull();
        expect(reading.asOf).toEqual(latest.timestamp);
    });

    it('with nothing stored, has no reading', () => {
        expect(storedLiveReading({ live_status_cache: null }, null, now)).toEqual({ liveStatus: null, asOf: null });
    });
});
