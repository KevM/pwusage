// arbitrage-service.ts
import type { EnergyRollupRow } from '../db';

const WH_PER_KWH = 1000;

export interface ArbitrageSummary {
    netPnl: number;          // dollars
    solarFraction: number;   // 0..1 of discharged energy that was solar-origin
    losingCycleCount: number;
    dischargedKwh: number;
}

/** Rows MUST be ordered by (local_date, tank_as_of). The prior row's tank is the entry tank. */
export function computeArbitrage(rows: EnergyRollupRow[]): ArbitrageSummary {
    let netPnl = 0, solarDischargeWh = 0, totalDischargeWh = 0, losing = 0;
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const dischargeWh = Number(row.battery_to_home_wh) + Number(row.battery_to_grid_wh);
        if (dischargeWh <= 0) continue;
        const entry = i > 0 ? rows[i - 1] : null;
        const entryWh = entry ? (Number(entry.tank_solar_wh) + Number(entry.tank_grid_wh)) : 0;
        const entryCost = entry ? (Number(entry.tank_solar_cost) + Number(entry.tank_grid_cost)) : 0;
        if (!entry || entryWh <= 0) continue; // can't attribute (genesis); skip
        const solarFrac = Number(entry.tank_solar_wh) / entryWh;
        const costPerKwh = entryCost / (entryWh / WH_PER_KWH); // $/kWh blended
        const dischargeKwh = dischargeWh / WH_PER_KWH;
        const benefit = (Number(row.battery_to_home_wh) / WH_PER_KWH) * Number(row.buy_rate)
                      + (Number(row.battery_to_grid_wh) / WH_PER_KWH) * Number(row.sell_rate);
        const costBasis = dischargeKwh * costPerKwh;
        const benefitPerKwh = dischargeKwh > 0 ? benefit / dischargeKwh : 0;
        netPnl += benefit - costBasis;
        solarDischargeWh += dischargeWh * solarFrac;
        totalDischargeWh += dischargeWh;
        if (costPerKwh >= benefitPerKwh) losing += 1;
    }
    return {
        netPnl,
        solarFraction: totalDischargeWh > 0 ? solarDischargeWh / totalDischargeWh : 0,
        losingCycleCount: losing,
        dischargedKwh: totalDischargeWh / WH_PER_KWH,
    };
}
