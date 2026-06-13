// roi-service.test.ts
import { describe, it, expect } from 'vitest';
import {
    computeMatrixTotals,
    buildRoiSummary,
    monthlyCumulative,
    type RoiInputs
} from './roi-service';
import type { EnergyRollupRow } from '../db';

function rolllup(over: Partial<EnergyRollupRow>): EnergyRollupRow {
    return {
        site_id: 's1', local_date: '2026-01-01', tariff_schedule_id: 10,
        load_wh: 0, solar_to_home_wh: 0, solar_to_battery_wh: 0, solar_to_grid_wh: 0,
        grid_to_home_wh: 0, grid_to_battery_wh: 0, battery_to_home_wh: 0, battery_to_grid_wh: 0,
        tank_solar_wh: 0, tank_grid_wh: 0, tank_solar_cost: 0, tank_grid_cost: 0, tank_as_of: new Date(),
        buy_rate: 0.24, sell_rate: 0.04, battery_soc: 50,
        solar_only_import_wh: 0, solar_only_export_wh: 0, ...over,
    };
}

const inputs: RoiInputs = { fixedBuyRate: 0.20, fixedSellRate: 0.05 };

describe('computeMatrixTotals', () => {
    it('prices the six cells from a single row (Wh→kWh at $/kWh)', () => {
        // 10 kWh load, solar-only imports 4 kWh / exports 1 kWh, actual imports 2 kWh / exports 0.5 kWh
        const r = rolllup({
            load_wh: 10000, solar_only_import_wh: 4000, solar_only_export_wh: 1000,
            grid_to_home_wh: 1500, grid_to_battery_wh: 500, solar_to_grid_wh: 300, battery_to_grid_wh: 200,
        });
        const m = computeMatrixTotals([r], inputs);
        expect(m.A).toBeCloseTo((10000 / 1000) * 0.20, 6);                       // load × fixedBuy
        expect(m.B).toBeCloseTo((10000 / 1000) * 0.24, 6);                       // load × TOU buy
        expect(m.C).toBeCloseTo((4000 / 1000) * 0.20 - (1000 / 1000) * 0.05, 6); // solar-only × flat
        expect(m.D).toBeCloseTo((4000 / 1000) * 0.24 - (1000 / 1000) * 0.04, 6); // solar-only × TOU
        expect(m.E).toBeCloseTo((2000 / 1000) * 0.20 - (500 / 1000) * 0.05, 6);  // actual × flat
        expect(m.F).toBeCloseTo((2000 / 1000) * 0.24 - (500 / 1000) * 0.04, 6);  // actual × TOU
    });

    it('decompositions reconcile', () => {
        const r = rolllup({ load_wh: 10000, solar_only_import_wh: 4000, solar_only_export_wh: 1000,
            grid_to_home_wh: 1500, grid_to_battery_wh: 500, solar_to_grid_wh: 300, battery_to_grid_wh: 200 });
        const m = computeMatrixTotals([r], inputs);
        expect(m.solarValue + m.batteryValue).toBeCloseTo(m.totalSaved, 6);
        expect(m.batteryHardwareValue + m.touPlanValue).toBeCloseTo(m.batteryValue, 6);
    });
});

describe('buildRoiSummary', () => {
    const config = { solarCost: 6500, batteryCost: 5900 };
    // 2 rows, 2 days, totalSaved $2/day-ish; use simple numbers
    const rows = [
        rolllup({ local_date: '2026-01-01', load_wh: 10000, grid_to_home_wh: 10000 }),
        rolllup({ local_date: '2026-01-02', load_wh: 10000, grid_to_home_wh: 10000 }),
    ];

    it('flags low confidence under a year of data', () => {
        const s = buildRoiSummary(rows, inputs, config, 'tou', new Date('2026-01-02T00:00:00Z'));
        expect(s.lowConfidence).toBe(true);
        expect(s.daysOfData).toBe(2);
    });

    it('recommends flat for a TOU user when E < F', () => {
        // load-only rows: F = load×0.24, E = load×0.20 → E < F → recommend flat
        const s = buildRoiSummary(rows, inputs, config, 'tou', new Date('2026-01-02T00:00:00Z'));
        expect(s.recommendation?.switchTo).toBe('fixed');
        expect(s.recommendation?.annualSaving).toBeGreaterThan(0);
    });

    it('omits a component with no cost', () => {
        const s = buildRoiSummary(rows, inputs, { solarCost: null, batteryCost: 5900 }, 'tou', new Date('2026-01-02T00:00:00Z'));
        expect(s.components.find(c => c.kind === 'solar')).toBeUndefined();
        expect(s.components.find(c => c.kind === 'battery')).toBeDefined();
    });
});


describe('monthlyCumulative', () => {
    it('buckets cumulative savings by month', () => {
        const rows = [ rolllup({ local_date: '2026-01-31', load_wh: 10000 }), rolllup({ local_date: '2026-02-15', load_wh: 10000 }) ];
        const series = monthlyCumulative(rows, { fixedBuyRate: 0.20, fixedSellRate: 0.05 });
        expect(series).toHaveLength(2);
        expect(series[1].cumulativeSaved).toBeGreaterThan(series[0].cumulativeSaved);
    });
});
