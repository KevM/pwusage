import { EnergyRepo, type CycleAggregateRow } from '../energy-repo';
import { aggregateUsage } from '../tou-aggregation';
import { Schedule } from '../schedule';
import type { SiteWithTariffs, TariffSchedule } from '../db';

export function calculate(balances: number[], rates: (number | null)[] = [0.3, 0.31], sellRates: (number | null)[] = [0.04, 0.04], options: { periods?: string[]; tariffNames?: string[]; versions?: boolean; today?: boolean; inheritRates?: boolean } = {}) {
    const schedules: TariffSchedule[] = balances.map((_, index) => ({
        id: index + 1, season_id: index + 1, name: options.periods?.[index] ?? 'ON_PEAK',
        buy_rate: rates[index], sell_rate: sellRates[index],
        from_day_of_week: 0, to_day_of_week: 6,
        from_hour: 0, to_hour: 24, from_minute: 0, to_minute: 0,
    }));
    const site: SiteWithTariffs = {
        id: 'site', name: 'Harrison', timezone: 'America/Chicago', billing_start_day: 11,
        updated: new Date(), installed: new Date(), json: {},
        tariffs: [{ id: 1, site_id: 'site', name: 'We energies', updated: new Date(),
            seasons: schedules.map((period, index) => ({
                id: index + 1, tariff_id: 1, name: index === 0 ? 'Summer' : 'Winter',
                from_month: index === 0 ? 6 : 10, from_day: 1,
                to_month: index === 0 ? 9 : 5, to_day: index === 0 ? 30 : 31,
                buy_rate: options.inheritRates ? (index === 0 ? 0.3 : 0.31) : 0,
                sell_rate: options.inheritRates ? 0.04 : 0, schedules: [period],
            })) }],
    };
    const priorAggregates: CycleAggregateRow[] = balances.map((grid, index) => ({
        day: new Date(index === 0 ? '2026-09-30T05:00:00Z' : '2026-10-01T05:00:00Z'),
        tariff_id: options.versions || options.tariffNames ? index + 1 : 1, tariff_schedule_id: schedules[index].id,
        grid_power: grid * 1000, load_power: 0, solar_power: 0, battery_power: 0,
    }));
    const historicalTariffs = options.versions || options.tariffNames
        ? balances.map((_, index) => ({ id: index + 1, site_id: site.id,
            name: options.tariffNames?.[index] ?? 'We energies', updated: new Date() }))
        : site.tariffs;
    if (options.tariffNames) site.tariffs[0].name = options.tariffNames[0];
    const todayRaw = options.today ? [{
        timestamp: new Date('2026-10-01T15:00:00Z'), site_id: site.id,
        tariff_id: 1, tariff_schedule_id: schedules[1].id,
        grid_power: balances[1] * 1000, load_power: 0, solar_power: 0,
        battery_power: 0, battery_soc: null,
    }] : [];
    const prior = options.today ? priorAggregates.slice(0, 1) : priorAggregates;
    const schedule = new Schedule(site.tariffs, site.timezone);
    const usage = EnergyRepo.aggregateUsageByTOU({
        siteId: site.id, start: new Date('2026-09-11T05:00:00Z'),
        priorAggregates: prior, todayRaw, schedule,
        tariffMap: new Map(historicalTariffs.map(t => [t.id, t])),
        scheduleMap: new Map(schedules.map(s => [s.id, s])),
    });
    const trmnl = aggregateUsage(site, prior, todayRaw, schedule, historicalTariffs, schedules);
    return { usage, trmnl };
}
