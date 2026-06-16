import { describe, it, expect } from 'vitest';
import { intervalFlows } from './interval-flows';
import type { EnergyData } from '../db';

function row(over: Partial<EnergyData>): EnergyData {
    return {
        id: 1, timestamp: new Date('2026-01-07T03:00:00Z'), site_id: 's1', tariff_id: 1,
        load_power: 0, solar_power: 0, grid_power: 0, battery_power: 0,
        battery_soc: 50, tariff_schedule_id: 10,
        battery_charge_from_solar: null, battery_charge_from_grid: null,
        ...over,
    } as EnergyData;
}

describe('intervalFlows', () => {
    it('computes the solar-only counterfactual: surplus exports, deficit imports', () => {
        expect(intervalFlows(row({ load_power: 1000, solar_power: 3000 })).solarOnlyExportWh).toBeCloseTo(2000, 6);
        expect(intervalFlows(row({ load_power: 1000, solar_power: 3000 })).solarOnlyImportWh).toBe(0);
        expect(intervalFlows(row({ load_power: 3000, solar_power: 1000 })).solarOnlyImportWh).toBeCloseTo(2000, 6);
    });

    it('returns non-negative flow fields for a representative interval', () => {
        const f = intervalFlows(row({ load_power: 2000, solar_power: 1000, grid_power: 1000, battery_power: 0 }));
        for (const v of Object.values(f)) expect(v).toBeGreaterThanOrEqual(0);
        expect(f.loadWh).toBeGreaterThan(0);
    });
});
