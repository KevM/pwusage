// arbitrage-service.ts
import type { EnergyHourlyRow } from '../db';
import type { PlanTimeline } from './plan-timeline';
import { chargeTank, dischargeTank, EMPTY_TANK, type Tank } from '../battery-provenance/tank';

const WH_PER_KWH = 1000;

export interface ArbitrageSummary {
    netPnl: number;          // dollars
    solarFraction: number;   // 0..1 of discharged energy that was solar-origin
    losingCycleCount: number;
    dischargedKwh: number;
}

/** On-read battery arbitrage P&L. Replays the cost-basis tank over hourly buckets in
 *  chronological order, valuing each hour's charge at the date-resolved metered rate and
 *  scoring that hour's discharge against the tank blend (after the hour's charge).
 *  Rows MUST be ordered by (local_date, hour) — HourlyRepo.getAllForSite already is.
 *  Starts from an empty tank: discharges before the tank holds attributable energy are
 *  skipped (matching the prior genesis-skip), a one-time startup gap within tolerance. */
export function computeArbitrage(rows: EnergyHourlyRow[], metered: PlanTimeline): ArbitrageSummary {
    let tank: Tank = EMPTY_TANK;
    let netPnl = 0, solarDischargeWh = 0, totalDischargeWh = 0, losing = 0;
    for (const r of rows) {
        const { buy, sell } = metered.rateAt(r.local_date, r.hour);
        tank = chargeTank(tank, Number(r.solar_to_battery_wh), Number(r.grid_to_battery_wh), buy, sell);

        const dischargeHomeWh = Number(r.battery_to_home_wh);
        const dischargeGridWh = Number(r.battery_to_grid_wh);
        const dischargeWh = dischargeHomeWh + dischargeGridWh;
        if (dischargeWh <= 0) continue;

        const tankWh = tank.solarWh + tank.gridWh;
        if (tankWh <= 0) continue; // nothing to attribute yet

        const solarFrac = tank.solarWh / tankWh;
        const costPerKwh = (tank.solarCost + tank.gridCost) / (tankWh / WH_PER_KWH); // $/kWh blended
        const dischargeKwh = dischargeWh / WH_PER_KWH;
        const benefit = (dischargeHomeWh / WH_PER_KWH) * buy + (dischargeGridWh / WH_PER_KWH) * sell;
        const costBasis = dischargeKwh * costPerKwh;
        const benefitPerKwh = benefit / dischargeKwh;

        tank = dischargeTank(tank, dischargeWh).tank;

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
