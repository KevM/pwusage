import { expect, it } from 'vitest';
import type { EnergyData, Tariff, TariffSchedule } from '../db-types';
import { auditTariffAttribution } from './compact-tariff-audit';
const schedule: TariffSchedule = { id: 10, season_id: 2, name: 'OFF_PEAK', buy_rate: 0.2, sell_rate: 0.04,
    from_day_of_week: 0, to_day_of_week: 6, from_hour: 0, to_hour: 24, from_minute: 0, to_minute: 0 };
const tariff: Tariff = { id: 1, site_id: 'site', name: 'Utility', updated: new Date(), seasons: [{ id: 2, tariff_id: 1, name: 'All year', from_month: 1, from_day: 1, to_month: 12, to_day: 31, buy_rate: 0.2, sell_rate: 0.04, schedules: [schedule] }] };
const row: EnergyData = { site_id: 'site', timestamp: new Date('2026-10-01T12:00:00Z'), tariff_id: 1, tariff_schedule_id: null, load_power: 10, solar_power: 2, grid_power: 8, battery_power: 0, battery_soc: null };
it('infers missing period from the referenced historical version and leaves source samples unchanged', () => {
    const result = auditTariffAttribution([row], 'America/Chicago', [tariff], [schedule]);
    expect(result.inferredSamples).toBe(1);
    expect(result.rows[0].tariff_schedule_id).toBe(10);
    expect(row.tariff_schedule_id).toBeNull();
});
it('does not use a current replacement tariff for a missing historical version', () => {
    const result = auditTariffAttribution([row], 'America/Chicago', [{ ...tariff, id: 99 }], [schedule]);
    expect(result.unresolvedSamples).toBe(1);
    expect(result.periods).toEqual([]);
});
it('keeps differing historical prices separate while consolidating equivalent schedule IDs', () => {
    const schedules = [schedule, { ...schedule, id: 11 }, { ...schedule, id: 12, buy_rate: 0.3 }];
    const result = auditTariffAttribution(schedules.map(s => ({ ...row, tariff_schedule_id: s.id })), 'America/Chicago', [tariff], schedules);
    expect(result.periods).toHaveLength(2);
    expect(result.periods[0].grid_wh).toBe(16);
    expect(result.periods[1].grid_wh).toBe(8);
});
it('rejects a schedule belonging to another tariff rather than accepting its price', () => {
    const other = { ...schedule, id: 11, season_id: 99 };
    const result = auditTariffAttribution([{ ...row, tariff_schedule_id: 11 }], 'America/Chicago', [tariff], [other]);
    expect(result.unresolvedSamples).toBe(1);
    expect(result.periods).toEqual([]);
});
