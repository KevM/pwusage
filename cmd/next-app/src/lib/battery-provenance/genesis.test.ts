import { describe, it, expect } from 'vitest';
import { computeGenesisSeed } from './genesis';
import { Schedule } from '../schedule';
import type { EnergyData } from '../db';

const tariffs = [{
    id: 1, name: 't', site_id: 'S1',
    seasons: [{
        id: 1, tariff_id: 1, name: 's', from_month: 1, from_day: 1, to_month: 12, to_day: 31,
        buy_rate: 0.11, sell_rate: 0.04,
        schedules: [{ id: 10, season_id: 1, name: 'flat', buy_rate: 0.11, sell_rate: 0.04,
            from_day_of_week: 0, to_day_of_week: 6, from_hour: null, from_minute: null, to_hour: null, to_minute: null }],
    }],
}] as unknown as ConstructorParameters<typeof Schedule>[0];

function row(ts: string, soc: number | null, fields: Partial<EnergyData>): EnergyData {
    return {
        timestamp: new Date(ts), site_id: 'S1', tariff_id: 1, tariff_schedule_id: 10,
        load_power: 0, solar_power: 0, grid_power: 0, battery_power: 0, battery_soc: soc,
        battery_charge_from_solar: null, battery_charge_from_grid: null, ...fields,
    };
}

describe('computeGenesisSeed', () => {
    it('seeds the tank from the charge run-up that fills the battery', () => {
        const schedule = new Schedule(tariffs, 'UTC');
        const rows: EnergyData[] = [
            row('2026-01-01T00:00:00Z', 50, {}),                                   // pre-charge, not full
            row('2026-01-01T01:00:00Z', 70, { battery_power: 3000, grid_power: 3000, battery_charge_from_grid: 3000, battery_charge_from_solar: 0 }),
            row('2026-01-01T02:00:00Z', 99, { battery_power: 3000, solar_power: 3000, battery_charge_from_solar: 3000, battery_charge_from_grid: 0 }), // full
        ];
        const result = computeGenesisSeed(rows, schedule, 'UTC', 98);
        expect(result).not.toBeNull();
        expect(result!.anchorIndex).toBe(2);
        expect(result!.seed.gridWh).toBeCloseTo(3000, 3);
        expect(result!.seed.solarWh).toBeCloseTo(3000, 3);
        expect(result!.seed.gridCost).toBeCloseTo(0.33, 6);  // 3 kWh * 0.11
        expect(result!.seed.solarCost).toBeCloseTo(0.12, 6); // 3 kWh * 0.04
    });

    it('returns null when the battery never reaches the full threshold', () => {
        const schedule = new Schedule(tariffs, 'UTC');
        const rows: EnergyData[] = [row('2026-01-01T00:00:00Z', 60, {})];
        expect(computeGenesisSeed(rows, schedule, 'UTC', 98)).toBeNull();
    });
});
