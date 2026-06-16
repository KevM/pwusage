// roi-service.test.ts
import { describe, it, expect } from 'vitest';
import {
    priceColumn,
    computeMatrixTotals,
    buildRoiSummary,
    monthlyCumulative,
} from './roi-service';
import { flatTimeline } from './plan-timeline';
import type { EnergyHourlyRow } from '../db';

function hour(over: Partial<EnergyHourlyRow>): EnergyHourlyRow {
    return {
        site_id: 's1', local_date: '2026-01-01', hour: 0,
        load_wh: 0, solar_to_home_wh: 0, solar_to_battery_wh: 0, solar_to_grid_wh: 0,
        grid_to_home_wh: 0, grid_to_battery_wh: 0, battery_to_home_wh: 0, battery_to_grid_wh: 0,
        solar_only_import_wh: 0, solar_only_export_wh: 0, ...over,
    };
}

const fixed = flatTimeline(0.20, 0.05);
const metered = flatTimeline(0.24, 0.04);

describe('priceColumn', () => {
    it('prices the three configs for one column (Wh→kWh at $/kWh)', () => {
        const r = hour({
            load_wh: 10000, solar_only_import_wh: 4000, solar_only_export_wh: 1000,
            grid_to_home_wh: 1500, grid_to_battery_wh: 500, solar_to_grid_wh: 300, battery_to_grid_wh: 200,
        });
        const bills = priceColumn(metered, [r]);
        expect(bills.noSolar).toBeCloseTo((10000 / 1000) * 0.24, 6);
        expect(bills.solar).toBeCloseTo((4000 / 1000) * 0.24 - (1000 / 1000) * 0.04, 6);
        // actual import = grid_to_home + grid_to_battery = 2000; export = solar_to_grid + battery_to_grid = 500
        expect(bills.solarBattery).toBeCloseTo((2000 / 1000) * 0.24 - (500 / 1000) * 0.04, 6);
    });
});

describe('computeMatrixTotals', () => {
    it('maps Fixed→A,C,E and Metered→B,D,F', () => {
        const r = hour({
            load_wh: 10000, solar_only_import_wh: 4000, solar_only_export_wh: 1000,
            grid_to_home_wh: 1500, grid_to_battery_wh: 500, solar_to_grid_wh: 300, battery_to_grid_wh: 200,
        });
        const m = computeMatrixTotals([r], fixed, metered);
        expect(m.A).toBeCloseTo((10000 / 1000) * 0.20, 6);
        expect(m.B).toBeCloseTo((10000 / 1000) * 0.24, 6);
        expect(m.C).toBeCloseTo((4000 / 1000) * 0.20 - (1000 / 1000) * 0.05, 6);
        expect(m.D).toBeCloseTo((4000 / 1000) * 0.24 - (1000 / 1000) * 0.04, 6);
        expect(m.E).toBeCloseTo((2000 / 1000) * 0.20 - (500 / 1000) * 0.05, 6);
        expect(m.F).toBeCloseTo((2000 / 1000) * 0.24 - (500 / 1000) * 0.04, 6);
    });

    it('decompositions reconcile', () => {
        const r = hour({ load_wh: 10000, solar_only_import_wh: 4000, solar_only_export_wh: 1000,
            grid_to_home_wh: 1500, grid_to_battery_wh: 500, solar_to_grid_wh: 300, battery_to_grid_wh: 200 });
        const m = computeMatrixTotals([r], fixed, metered);
        expect(m.solarValue + m.batteryValue).toBeCloseTo(m.totalSaved, 6);
        expect(m.batteryHardwareValue + m.touPlanValue).toBeCloseTo(m.batteryValue, 6);
    });
});

describe('buildRoiSummary', () => {
    const config = { solarCost: 6500, batteryCost: 5900 };
    const rows = [
        hour({ local_date: '2026-01-01', load_wh: 10000, grid_to_home_wh: 10000 }),
        hour({ local_date: '2026-01-02', load_wh: 10000, grid_to_home_wh: 10000 }),
    ];

    it('flags low confidence under a year of data', () => {
        const s = buildRoiSummary(rows, fixed, metered, config, 'tou', new Date('2026-01-02T00:00:00Z'));
        expect(s.lowConfidence).toBe(true);
        expect(s.daysOfData).toBe(2);
    });

    it('recommends flat for a TOU user when E < F', () => {
        // load-only rows: F = load×0.24, E = load×0.20 → E < F → recommend flat
        const s = buildRoiSummary(rows, fixed, metered, config, 'tou', new Date('2026-01-02T00:00:00Z'));
        expect(s.recommendation?.switchTo).toBe('fixed');
        expect(s.recommendation?.annualSaving).toBeGreaterThan(0);
    });

    it('omits a component with no cost', () => {
        const s = buildRoiSummary(rows, fixed, metered, { solarCost: null, batteryCost: 5900 }, 'tou', new Date('2026-01-02T00:00:00Z'));
        expect(s.components.find(c => c.kind === 'solar')).toBeUndefined();
        expect(s.components.find(c => c.kind === 'battery')).toBeDefined();
    });
});

describe('monthlyCumulative', () => {
    it('buckets cumulative savings by month', () => {
        const rows = [ hour({ local_date: '2026-01-31', load_wh: 10000 }), hour({ local_date: '2026-02-15', load_wh: 10000 }) ];
        const series = monthlyCumulative(rows, fixed, metered);
        expect(series).toHaveLength(2);
        expect(series[1].cumulativeSaved).toBeGreaterThan(series[0].cumulativeSaved);
    });
});
