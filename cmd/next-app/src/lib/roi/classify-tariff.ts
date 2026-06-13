// classify-tariff.ts
import type { Tariff } from '../db';

/** A tariff is TOU if its resolved buy rates differ across schedules; otherwise fixed. */
export function classifyTariff(tariff: Tariff): 'fixed' | 'tou' {
    const rates: number[] = [];
    for (const season of tariff.seasons ?? []) {
        for (const s of season.schedules ?? []) {
            rates.push(s.buy_rate ?? season.buy_rate);
        }
    }
    if (rates.length === 0) return 'fixed';
    const first = rates[0];
    return rates.some(r => Math.abs(r - first) > 1e-9) ? 'tou' : 'fixed';
}
