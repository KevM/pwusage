import type { EnergyData, Tariff, TariffSchedule } from '../db-types';
import { Schedule } from '../schedule';

export interface BillingPeriodRollup {
    tariff_id: number; period_name: string; buy_rate: number; sell_rate: number;
    home_wh: number; solar_wh: number; grid_wh: number; battery_wh: number; sample_count: number;
}
export function auditTariffAttribution(rows: EnergyData[], timezone: string, tariffs: Tariff[], schedules: TariffSchedule[]) {
    const tariffMap = new Map(tariffs.map(t => [t.id, t]));
    const scheduleMap = new Map(schedules.map(s => [s.id, s]));
    const evaluators = new Map<number, Schedule>();
    const periods = new Map<string, BillingPeriodRollup>();
    const unresolvedRows: EnergyData[] = [];
    const unresolvedReasons: Record<string, number> = {};
    const markUnresolved = (row: EnergyData, reason: string) => {
        unresolvedSamples++; unresolvedRows.push(row); unresolvedReasons[reason] = (unresolvedReasons[reason] ?? 0) + 1;
        return { ...row };
    };
    let inferredSamples = 0; let unresolvedSamples = 0; let recordedPeriodDisagreements = 0;
    const repaired = rows.map(row => {
        const tariff = tariffMap.get(row.tariff_id);
        if (!tariff) return markUnresolved(row, 'missing historical tariff');
        let evaluator = evaluators.get(tariff.id);
        if (!evaluator) { evaluator = new Schedule([tariff], timezone); evaluators.set(tariff.id, evaluator); }
        const expected = evaluator.getTariffPeriod(row.timestamp);
        const selected = row.tariff_schedule_id === null ? expected?.schedule : scheduleMap.get(row.tariff_schedule_id);
        const season = selected && tariff.seasons?.find(s => s.id === selected.season_id);
        if (!selected || !season) return markUnresolved(row, !tariff.seasons?.length ? 'historical tariff has no seasons'
            : row.tariff_schedule_id === null ? 'no historical period matches timestamp' : !selected ? 'recorded schedule missing' : 'recorded schedule belongs to another tariff');
        if (row.tariff_schedule_id === null) inferredSamples++;
        else if (expected && expected.schedule.id !== selected.id) recordedPeriodDisagreements++;
        const name = selected.name ?? 'Standard';
        const buy = selected.buy_rate ?? season.buy_rate; const sell = selected.sell_rate ?? season.sell_rate;
        const key = JSON.stringify([tariff.id, name, buy, sell]);
        let period = periods.get(key);
        if (!period) {
            period = { tariff_id: tariff.id, period_name: name, buy_rate: buy, sell_rate: sell, home_wh: 0, solar_wh: 0, grid_wh: 0, battery_wh: 0, sample_count: 0 };
            periods.set(key, period);
        }
        period.home_wh += row.load_power; period.solar_wh += row.solar_power; period.grid_wh += row.grid_power; period.battery_wh += row.battery_power; period.sample_count++;
        return { ...row, tariff_schedule_id: selected.id };
    });
    return { rows: repaired, periods: [...periods.values()], unresolvedRows, unresolvedReasons, inferredSamples, unresolvedSamples, recordedPeriodDisagreements,
        uniquePeriodNames: new Set([...periods.values()].map(p => p.period_name)).size,
        uniquePrices: new Set([...periods.values()].map(p => JSON.stringify([p.buy_rate, p.sell_rate]))).size };
}
