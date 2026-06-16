import { describe, it, expect } from 'vitest';
import { buildExtendedGrid, type GridColumnInput } from './extended-grid';
import type { PlanTimeline } from './plan-timeline';
import type { EnergyHourlyRow } from '../db';

function hour(over: Partial<EnergyHourlyRow>): EnergyHourlyRow {
    return {
        site_id: 's1', local_date: '2026-01-01', hour: 0,
        load_wh: 0, solar_to_home_wh: 0, solar_to_battery_wh: 0, solar_to_grid_wh: 0,
        grid_to_home_wh: 0, grid_to_battery_wh: 0, battery_to_home_wh: 0, battery_to_grid_wh: 0,
        solar_only_import_wh: 0, solar_only_export_wh: 0, ...over,
    };
}
const flat = (buy: number, sell: number): PlanTimeline => ({ rateAt: () => ({ buy, sell }) });

// One hour: 10 kWh load, 4 kWh solar-only import, 6 kWh actual import (grid_to_home).
const rows = [hour({ load_wh: 10000, solar_only_import_wh: 4000, grid_to_home_wh: 6000 })];

const cols: GridColumnInput[] = [
    { name: 'Your TOU', type: 'metered', isMetered: true, timeline: flat(0.20, 0) },
    { name: 'Cheap Flat', type: 'fixed', isMetered: false, timeline: flat(0.10, 0) },
];

describe('buildExtendedGrid', () => {
    it('prices each config row against each column', () => {
        const g = buildExtendedGrid(rows, cols);
        expect(g.columns).toEqual([{ name: 'Your TOU', type: 'metered' }, { name: 'Cheap Flat', type: 'fixed' }]);
        const noSolar = g.rows.find(r => r.config === 'noSolar')!;
        expect(noSolar.cells[0].value).toBeCloseTo(10 * 0.20, 6); // metered
        expect(noSolar.cells[1].value).toBeCloseTo(10 * 0.10, 6); // flat
        const solar = g.rows.find(r => r.config === 'solar')!;
        expect(solar.cells[0].value).toBeCloseTo(4 * 0.20, 6);
        const solarBattery = g.rows.find(r => r.config === 'solarBattery')!;
        expect(solarBattery.cells[0].value).toBeCloseTo(6 * 0.20, 6);
    });

    it('flags the cheapest cell per row', () => {
        const g = buildExtendedGrid(rows, cols);
        const noSolar = g.rows.find(r => r.config === 'noSolar')!;
        expect(noSolar.cells[0].cheapest).toBe(false); // metered 2.00
        expect(noSolar.cells[1].cheapest).toBe(true);  // flat 1.00 is cheaper
    });

    it('flags "here" only on the metered column × Solar+Batt', () => {
        const g = buildExtendedGrid(rows, cols);
        for (const r of g.rows) {
            for (let i = 0; i < r.cells.length; i++) {
                const expected = r.config === 'solarBattery' && cols[i].isMetered;
                expect(r.cells[i].here).toBe(expected);
            }
        }
    });

    it('never flags cheapest with a single column', () => {
        const g = buildExtendedGrid(rows, [cols[0]]);
        expect(g.rows.every(r => r.cells.every(c => !c.cheapest))).toBe(true);
    });

    it('returns three config rows with stable labels', () => {
        const g = buildExtendedGrid(rows, cols);
        expect(g.rows.map(r => r.config)).toEqual(['noSolar', 'solar', 'solarBattery']);
        expect(g.rows.map(r => r.label)).toEqual(['No Solar', 'Solar', 'Solar+Batt']);
    });
});
