import type { TariffPeriod } from '../schedule';

export interface Rates {
    buyRate: number;
    sellRate: number;
}

/** Schedule rates win; fall back to the parent season's rates when null. */
export function resolveRates(period: TariffPeriod): Rates {
    return {
        buyRate: period.schedule.buy_rate ?? period.season.buy_rate,
        sellRate: period.schedule.sell_rate ?? period.season.sell_rate,
    };
}
