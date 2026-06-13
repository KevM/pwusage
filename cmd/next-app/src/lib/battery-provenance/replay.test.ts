import { describe, it, expect } from 'vitest';
import { replayRows } from './replay';
import { EMPTY_TANK } from './tank';
import { Schedule } from '../schedule';
import type { EnergyData } from '../db';

// One tariff (id 1) / season / schedule (id 10), flat rates, all hours.
const tariffs = [{
    id: 1, name: 't', site_id: 'S1',
    seasons: [{
        id: 1, tariff_id: 1, name: 's', from_month: 1, from_day: 1, to_month: 12, to_day: 31,
        buy_rate: 0.11, sell_rate: 0.04,
        schedules: [{
            id: 10, season_id: 1, name: 'flat',
            buy_rate: 0.11, sell_rate: 0.04,
            from_day_of_week: 0, to_day_of_week: 6,
            from_hour: null, from_minute: null, to_hour: null, to_minute: null,
        }],
    }],
}] as unknown as ConstructorParameters<typeof Schedule>[0];

function row(ts: string, fields: Partial<EnergyData>): EnergyData {
    return {
        timestamp: new Date(ts), site_id: 'S1', tariff_id: 1, tariff_schedule_id: 10,
        load_power: 0, solar_power: 0, grid_power: 0, battery_power: 0, battery_soc: null,
        battery_charge_from_solar: null, battery_charge_from_grid: null, ...fields,
    };
}

describe('replayRows', () => {
    it('charges from Tesla split, discharges at the blended ratio, and snapshots the tank', () => {
        const schedule = new Schedule(tariffs, 'UTC');
        const rows: EnergyData[] = [
            // Grid charge 4000 Wh (battery_power + = charge), Tesla says all grid.
            row('2026-01-01T02:00:00Z', { battery_power: 4000, grid_power: 4000, load_power: 0,
                battery_charge_from_solar: 0, battery_charge_from_grid: 4000 }),
            // Solar charge 5000 Wh from solar.
            row('2026-01-01T13:00:00Z', { battery_power: 5000, solar_power: 5000, load_power: 0,
                battery_charge_from_solar: 5000, battery_charge_from_grid: 0 }),
            // Discharge 4500 Wh to home (battery_power - = discharge).
            row('2026-01-01T19:00:00Z', { battery_power: -4500, load_power: 4500, battery_soc: 55 }),
        ];

        const { rollups, endTank } = replayRows(rows, schedule, 'UTC', EMPTY_TANK);

        expect(rollups).toHaveLength(1);
        const r = rollups[0];
        expect(r.localDate).toBe('2026-01-01');
        expect(r.tariffScheduleId).toBe(10);
        expect(r.solarToBatteryWh).toBeCloseTo(5000, 3);
        expect(r.gridToBatteryWh).toBeCloseTo(4000, 3);
        expect(r.batteryToHomeWh).toBeCloseTo(4500, 3);
        expect(r.buyRate).toBeCloseTo(0.11, 6);
        expect(r.sellRate).toBeCloseTo(0.04, 6);
        expect(r.batterySoc).toBe(55); // SOC of the last interval
        // After charging: 5000 solar + 4000 grid = 9000; discharge 4500 = half.
        expect(endTank.solarWh).toBeCloseTo(2500, 3);
        expect(endTank.gridWh).toBeCloseTo(2000, 3);
        expect(r.tank.solarWh).toBeCloseTo(2500, 3);
        expect(r.tankAsOf.toISOString()).toBe('2026-01-01T19:00:00.000Z');
    });

    it('falls back to sankey-derived charge split when Tesla values are null', () => {
        const schedule = new Schedule(tariffs, 'UTC');
        const rows: EnergyData[] = [
            // Solar 6000, load 1000 → 1000 solar-home, 5000 solar-battery (merit order).
            row('2026-01-01T12:00:00Z', { solar_power: 6000, load_power: 1000, battery_power: 5000 }),
        ];
        const { endTank } = replayRows(rows, schedule, 'UTC', EMPTY_TANK);
        expect(endTank.solarWh).toBeCloseTo(5000, 3);
        expect(endTank.gridWh).toBeCloseTo(0, 3);
    });
});
