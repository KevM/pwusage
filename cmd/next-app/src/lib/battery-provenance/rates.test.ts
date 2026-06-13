import { describe, it, expect } from 'vitest';
import { resolveRates } from './rates';
import type { TariffPeriod } from '../schedule';

function period(scheduleRates: { buy: number | null; sell: number | null }, seasonRates: { buy: number; sell: number }): TariffPeriod {
    return {
        start: new Date(), end: new Date(),
        tariff: {} as TariffPeriod['tariff'],
        season: { buy_rate: seasonRates.buy, sell_rate: seasonRates.sell } as TariffPeriod['season'],
        schedule: { buy_rate: scheduleRates.buy, sell_rate: scheduleRates.sell } as TariffPeriod['schedule'],
    };
}

describe('resolveRates', () => {
    it('uses schedule rates when present', () => {
        expect(resolveRates(period({ buy: 0.24, sell: 0.04 }, { buy: 0.11, sell: 0.03 })))
            .toEqual({ buyRate: 0.24, sellRate: 0.04 });
    });

    it('falls back to season rates when schedule rates are null', () => {
        expect(resolveRates(period({ buy: null, sell: null }, { buy: 0.11, sell: 0.03 })))
            .toEqual({ buyRate: 0.11, sellRate: 0.03 });
    });
});
