// classify-tariff.test.ts
import { describe, it, expect } from 'vitest';
import { classifyTariff } from './classify-tariff';
import type { Tariff } from '../db';

function tariff(scheduleBuyRates: (number | null)[], seasonBuy = 0.2): Tariff {
    return {
        id: 1, site_id: 's1', updated: new Date(), name: null,
        seasons: [{
            id: 1, tariff_id: 1, name: null, from_month: 1, from_day: 1, to_month: 12, to_day: 31,
            buy_rate: seasonBuy, sell_rate: 0.05,
            schedules: scheduleBuyRates.map((b, i) => ({
                id: i, season_id: 1, name: null, buy_rate: b, sell_rate: 0.05,
                from_day_of_week: 0, from_hour: i, from_minute: 0, to_day_of_week: 6, to_hour: i, to_minute: 59,
            })),
        }],
    } as Tariff;
}

describe('classifyTariff', () => {
    it('is TOU when buy rates vary across schedules', () => {
        expect(classifyTariff(tariff([0.24, 0.11]))).toBe('tou');
    });
    it('is fixed when all resolved buy rates are equal', () => {
        expect(classifyTariff(tariff([0.20, 0.20]))).toBe('fixed');
    });
    it('resolves null schedule rates to the season rate before comparing', () => {
        expect(classifyTariff(tariff([null, null], 0.20))).toBe('fixed');
    });
});
