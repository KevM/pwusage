// arbitrage-service.test.ts
import { describe, it, expect } from 'vitest';
import { computeArbitrage } from './arbitrage-service';
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

// Off-peak (hour < 16) cheap; peak (hour >= 16) expensive — drives charge vs discharge valuation.
const peaky = (offBuy: number, peakBuy: number): PlanTimeline => ({
    rateAt: (_d, h) => (h >= 16 ? { buy: peakBuy, sell: 0.04 } : { buy: offBuy, sell: 0.04 }),
});

describe('computeArbitrage', () => {
    it('scores a discharge against the tank blend (charge valued at its hour rate)', () => {
        // hour 6: charge 10 kWh grid @ buy 0.11 → cost basis $0.11/kWh.
        // hour 18: discharge 9 kWh to home @ buy 0.24 → benefit 9×0.24=2.16, cost 9×0.11=0.99.
        const rows = [
            hour({ hour: 6, grid_to_battery_wh: 10000 }),
            hour({ hour: 18, battery_to_home_wh: 9000 }),
        ];
        const a = computeArbitrage(rows, peaky(0.11, 0.24));
        expect(a.netPnl).toBeCloseTo(2.16 - 0.99, 2);
        expect(a.solarFraction).toBe(0); // all grid-origin
        expect(a.dischargedKwh).toBeCloseTo(9, 6);
    });

    it('attributes the solar fraction of discharged energy', () => {
        const rows = [
            hour({ hour: 6, solar_to_battery_wh: 5000, grid_to_battery_wh: 5000 }),
            hour({ hour: 18, battery_to_home_wh: 5000 }),
        ];
        const a = computeArbitrage(rows, peaky(0.11, 0.24));
        expect(a.solarFraction).toBeCloseTo(0.5, 6);
    });

    it('flags a losing cycle when cost basis per kWh exceeds benefit per kWh', () => {
        // charge expensive (0.30), discharge into cheap (0.11).
        const rows = [
            hour({ hour: 6, grid_to_battery_wh: 1000 }),
            hour({ hour: 18, battery_to_home_wh: 1000 }),
        ];
        const a = computeArbitrage(rows, peaky(0.30, 0.11));
        expect(a.losingCycleCount).toBe(1);
    });

    it('skips discharge before the tank holds attributable energy (no genesis seed)', () => {
        const rows = [ hour({ hour: 0, battery_to_home_wh: 5000 }) ];
        const a = computeArbitrage(rows, peaky(0.11, 0.24));
        expect(a.netPnl).toBe(0);
        expect(a.dischargedKwh).toBe(0);
    });

    it('returns zeros for no rows', () => {
        const a = computeArbitrage([], peaky(0.11, 0.24));
        expect(a).toEqual({ netPnl: 0, solarFraction: 0, losingCycleCount: 0, dischargedKwh: 0 });
    });
});
