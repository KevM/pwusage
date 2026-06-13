// arbitrage-service.test.ts
import { describe, it, expect } from 'vitest';
import { computeArbitrage } from './arbitrage-service';
import type { EnergyRollupRow } from '../db';

function r(over: Partial<EnergyRollupRow>): EnergyRollupRow {
    return {
        site_id: 's1', local_date: '2026-01-01', tariff_schedule_id: 10,
        load_wh: 0, solar_to_home_wh: 0, solar_to_battery_wh: 0, solar_to_grid_wh: 0,
        grid_to_home_wh: 0, grid_to_battery_wh: 0, battery_to_home_wh: 0, battery_to_grid_wh: 0,
        tank_solar_wh: 0, tank_grid_wh: 0, tank_solar_cost: 0, tank_grid_cost: 0, tank_as_of: new Date('2026-01-01T00:00:00Z'),
        buy_rate: 0.24, sell_rate: 0.04, battery_soc: 50,
        solar_only_import_wh: 0, solar_only_export_wh: 0, ...over,
    };
}

describe('computeArbitrage', () => {
    it('scores a discharge against the entry tank blend', () => {
        // period 1: ends with tank 10kWh grid @ $1.10 (cost basis $0.11/kWh)
        // period 2: discharges 9kWh to home at buy 0.24 → benefit 9*0.24=2.16, cost basis 9*0.11=0.99
        const rows = [
            r({ tank_as_of: new Date('2026-01-01T06:00:00Z'), tank_grid_wh: 10000, tank_grid_cost: 1.10 }),
            r({ tank_as_of: new Date('2026-01-01T18:00:00Z'), battery_to_home_wh: 9000, buy_rate: 0.24,
                tank_grid_wh: 1000, tank_grid_cost: 0.11 }),
        ];
        const a = computeArbitrage(rows);
        expect(a.netPnl).toBeCloseTo(2.16 - 0.99, 2);
        expect(a.solarFraction).toBe(0); // all grid-origin
    });

    it('flags a losing cycle when cost basis per kWh exceeds benefit per kWh', () => {
        // entry tank expensive grid ($0.30/kWh), discharged into cheap period (buy 0.11)
        const rows = [
            r({ tank_as_of: new Date('2026-01-01T06:00:00Z'), tank_grid_wh: 1000, tank_grid_cost: 0.30 }),
            r({ tank_as_of: new Date('2026-01-01T07:00:00Z'), battery_to_home_wh: 1000, buy_rate: 0.11,
                tank_grid_wh: 0, tank_grid_cost: 0 }),
        ];
        const a = computeArbitrage(rows);
        expect(a.losingCycleCount).toBe(1);
    });
});
