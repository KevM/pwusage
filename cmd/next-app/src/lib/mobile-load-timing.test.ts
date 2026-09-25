import { describe, expect, it } from 'vitest';
import type { EnergyData } from './db-types';
import type { UsageData } from './energy-repo';
import { activeLoadTimingForMobile } from './mobile-load-timing';
import type { Schedule } from './schedule';

const NOW = new Date('2026-09-24T12:00:00.000Z');
const MIDNIGHT = new Date('2026-09-24T00:00:00.000Z');
const SAMPLE = new Date('2026-09-24T11:55:00.000Z');

function schedule(activeName = 'Off peak', buyRate: number | null = 0.2, sellRate: number | null = 0.05, seasonBuy: number | null = 0.3, seasonSell: number | null = 0.1): Schedule {
    return {
        getTariffPeriod: () => ({
            schedule: { name: activeName, buy_rate: buyRate, sell_rate: sellRate },
            season: { buy_rate: seasonBuy, sell_rate: seasonSell },
        }),
    } as unknown as Schedule;
}

function usage(name: string, gridUsage: number): UsageData {
    return {
        start: MIDNIGHT, homeUsage: 0, gridUsage, solarProduction: 0, batteryChange: 0,
        tariff: {} as UsageData['tariff'], touName: name, buyRate: 0.2, sellRate: 0.05,
    };
}

function bin(gridPower: number, sampleCount = 3): EnergyData {
    return {
        timestamp: new Date('2026-09-24T11:45:00.000Z'), sample_timestamp: SAMPLE,
        site_id: 'site-a', tariff_id: 1, tariff_schedule_id: 1,
        load_power: 0, solar_power: 0, grid_power: gridPower, battery_power: 0, battery_soc: null,
        sample_count: sampleCount,
    };
}

describe('activeLoadTimingForMobile', () => {
    it('uses sell pricing for observed surplus', () => {
        const result = activeLoadTimingForMobile(schedule(), NOW, [usage('Off peak', -2_000)], [], MIDNIGHT, SAMPLE);
        expect(result).toEqual({ periodName: 'Off peak', buyRate: 0.2, sellRate: 0.05, marginalCost: 0.05, basis: 'sell', balanceKwh: 2, energyDataThrough: SAMPLE.toISOString() });
    });

    it('uses buy pricing for observed deficit', () => {
        const result = activeLoadTimingForMobile(schedule(), NOW, [usage('Off peak', 2_000)], [], MIDNIGHT, SAMPLE);
        expect(result?.marginalCost).toBe(0.2);
        expect(result?.basis).toBe('buy');
        expect(result?.balanceKwh).toBe(-2);
    });

    it('uses buy rate as marginal cost at the web neutral threshold', () => {
        const result = activeLoadTimingForMobile(schedule(), NOW, [usage('Off peak', -50)], [], MIDNIGHT, SAMPLE);
        expect(result?.balanceKwh).toBeCloseTo(0.05);
        expect(result?.marginalCost).toBe(0.2);
        expect(result?.basis).toBe('neutral');
    });

    it('keeps an unobserved active period unknown when another period was observed', () => {
        const result = activeLoadTimingForMobile(schedule(), NOW, [usage('Peak', -5_000)], [], MIDNIGHT, SAMPLE);
        expect(result?.balanceKwh).toBeNull();
        expect(result?.marginalCost).toBeNull();
        expect(result?.basis).toBeNull();
    });

    it('derives today balance from the existing bins and preserves the real sample time', () => {
        const result = activeLoadTimingForMobile(schedule(), NOW, [], [bin(-1000)], MIDNIGHT, SAMPLE);
        expect(result?.balanceKwh).toBe(3);
        expect(result?.energyDataThrough).toBe(SAMPLE.toISOString());
    });

    it('uses schedule rates when the rate belongs to the season', () => {
        const result = activeLoadTimingForMobile(schedule('Off peak', null, null), NOW, [], [bin(1000)], MIDNIGHT, null);
        expect(result?.buyRate).toBe(0.3);
        expect(result?.sellRate).toBe(0.1);
    });

    it('returns null when no tariff period or usable rates are available', () => {
        const noPeriod = { getTariffPeriod: () => null } as unknown as Schedule;
        expect(activeLoadTimingForMobile(noPeriod, NOW, [], [], MIDNIGHT, null)).toBeNull();
        expect(activeLoadTimingForMobile(schedule('Off peak', null, null, null, null), NOW, [], [], MIDNIGHT, null)).toBeNull();
    });
});
