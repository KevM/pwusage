import { describe, it, expect } from 'vitest';
import { RollupService, type RollupDeps } from './rollup-service';
import { Schedule } from '../schedule';
import type { EnergyData } from '../db';
import type { PeriodRollup } from './replay';

const tariffs = [{
    id: 1, name: 't', site_id: 'S1',
    seasons: [{ id: 1, tariff_id: 1, name: 's', from_month: 1, from_day: 1, to_month: 12, to_day: 31,
        buy_rate: 0.11, sell_rate: 0.04,
        schedules: [{ id: 10, season_id: 1, name: 'flat', buy_rate: 0.11, sell_rate: 0.04,
            from_day_of_week: 0, to_day_of_week: 6, from_hour: null, from_minute: null, to_hour: null, to_minute: null }] }],
}] as unknown as ConstructorParameters<typeof Schedule>[0];

function row(ts: string, fields: Partial<EnergyData>): EnergyData {
    return { timestamp: new Date(ts), site_id: 'S1', tariff_id: 1, tariff_schedule_id: 10,
        load_power: 0, solar_power: 0, grid_power: 0, battery_power: 0, battery_soc: null,
        battery_charge_from_solar: null, battery_charge_from_grid: null, ...fields };
}

describe('RollupService.rollupDay', () => {
    it('seeds from the prior tank, replays the day, and persists one row', async () => {
        const persisted: PeriodRollup[] = [];
        const deps: RollupDeps = {
            loadSite: async () => ({ id: 'S1', timezone: 'UTC', tariffs }) as never,
            loadEnergyData: async () => [
                row('2026-01-02T13:00:00Z', { battery_power: 5000, solar_power: 5000, battery_charge_from_solar: 5000, battery_charge_from_grid: 0 }),
                row('2026-01-02T19:00:00Z', { battery_power: -3000, load_power: 3000 }),
            ],
            getSeedTank: async () => ({ tank: { solarWh: 0, gridWh: 2000, solarCost: 0, gridCost: 0.22 }, tankAsOf: new Date('2026-01-01T23:55:00Z') }),
            hasAnyRollup: async () => true,
            upsertRollups: async (r) => { persisted.push(...r); },
        };
        const svc = new RollupService(deps);
        const result = await svc.rollupDay('S1', '2026-01-02');

        expect(result.rollupCount).toBe(1);
        expect(persisted).toHaveLength(1);
        // seed 2000 grid + 5000 solar charge = 7000; discharge 3000 leaves 4000.
        expect(persisted[0].tank.solarWh + persisted[0].tank.gridWh).toBeCloseTo(4000, 2);
        expect(persisted[0].localDate).toBe('2026-01-02');
    });

    it('runs genesis path when no prior rollups exist, seeding at anchor and replaying full day edges', async () => {
        const persisted: PeriodRollup[] = [];
        const deps: RollupDeps = {
            loadSite: async () => ({ id: 'S1', timezone: 'UTC', tariffs }) as never,
            loadEnergyData: async () => [
                row('2026-01-02T00:00:00Z', { battery_soc: 50, battery_power: 0 }),
                // Run-up inclusive of anchor
                row('2026-01-02T06:00:00Z', { battery_soc: 70, battery_power: 3000, grid_power: 3000, battery_charge_from_grid: 3000 }),
                row('2026-01-02T12:00:00Z', { battery_soc: 99, battery_power: 3000, solar_power: 3000, battery_charge_from_solar: 3000 }), // anchor
                // Discharge after anchor
                row('2026-01-02T18:00:00Z', { battery_soc: 60, battery_power: -3000, load_power: 3000 }),
            ],
            getSeedTank: async () => null,
            hasAnyRollup: async () => false,
            upsertRollups: async (r) => { persisted.push(...r); },
        };
        const svc = new RollupService(deps);
        const result = await svc.rollupDay('S1', '2026-01-02');

        expect(result.rollupCount).toBe(1);
        expect(persisted).toHaveLength(1);
        const rollup = persisted[0];

        // Seeding charges 3000 grid + 3000 solar = 6000 Wh.
        // Discharging after anchor draws 3000 Wh proportionally: half solar (1500 Wh), half grid (1500 Wh) drawn.
        // Final tank: 1500 solar, 1500 grid.
        expect(rollup.tank.solarWh).toBeCloseTo(1500, 2);
        expect(rollup.tank.gridWh).toBeCloseTo(1500, 2);

        // Edges should accumulate the entire day (not drop run-up edges)
        // solarToBatteryWh = 3000 (from anchor row at 12:00)
        // gridToBatteryWh = 3000 (from run-up row at 06:00)
        expect(rollup.solarToBatteryWh).toBeCloseTo(3000, 2);
        expect(rollup.gridToBatteryWh).toBeCloseTo(3000, 2);
    });
});
