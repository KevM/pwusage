import type { ParsedTariff } from '../importer/tariff-parser';

export interface FixedComparisonInput {
    name: string;
    buyRate: number;
    sellRate: number;
}

/** A flat plan = one full-year season + one all-day/all-week schedule.
 *  Day-of-week MUST be 0..6: matchDayOfWeek returns false when both bounds are
 *  null, so null-day bounds would match zero days. Hours 0..24 cover all hours. */
export function buildFixedComparisonInput(input: FixedComparisonInput): ParsedTariff {
    return {
        name: input.name,
        seasons: [{
            name: 'All Year',
            from_month: 1, from_day: 1, to_month: 12, to_day: 31,
            buy_rate: input.buyRate, sell_rate: input.sellRate,
            schedules: [{
                name: 'Flat',
                buy_rate: input.buyRate, sell_rate: input.sellRate,
                from_day_of_week: 0, to_day_of_week: 6,
                from_hour: 0, from_minute: 0, to_hour: 24, to_minute: 0,
            }],
        }],
    };
}
