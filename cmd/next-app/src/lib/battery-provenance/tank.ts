const WH_PER_KWH = 1000;

export interface Tank {
    solarWh: number;
    gridWh: number;
    solarCost: number; // dollars
    gridCost: number;  // dollars
}

export interface DischargeDraw {
    solarWh: number;
    gridWh: number;
    solarCost: number;
    gridCost: number;
}

export const EMPTY_TANK: Tank = { solarWh: 0, gridWh: 0, solarCost: 0, gridCost: 0 };

/** Add charge to the tank, valued at charge time. Rates are $/kWh; energy is Wh. */
export function chargeTank(tank: Tank, solarWh: number, gridWh: number, buyRate: number, sellRate: number): Tank {
    return {
        solarWh: tank.solarWh + solarWh,
        gridWh: tank.gridWh + gridWh,
        // Solar's cost basis is its forgone export value (sell rate); grid's is cash paid (buy rate).
        solarCost: tank.solarCost + (solarWh / WH_PER_KWH) * sellRate,
        gridCost: tank.gridCost + (gridWh / WH_PER_KWH) * buyRate,
    };
}

/** Remove energy proportionally across both sources, preserving the blend. */
export function dischargeTank(tank: Tank, dischargeWh: number): { tank: Tank; draw: DischargeDraw } {
    const total = tank.solarWh + tank.gridWh;
    if (dischargeWh <= 0 || total <= 0) {
        return { tank, draw: { solarWh: 0, gridWh: 0, solarCost: 0, gridCost: 0 } };
    }
    const f = Math.min(dischargeWh, total) / total;
    const draw: DischargeDraw = {
        solarWh: tank.solarWh * f,
        gridWh: tank.gridWh * f,
        solarCost: tank.solarCost * f,
        gridCost: tank.gridCost * f,
    };
    return {
        tank: {
            solarWh: tank.solarWh - draw.solarWh,
            gridWh: tank.gridWh - draw.gridWh,
            solarCost: tank.solarCost - draw.solarCost,
            gridCost: tank.gridCost - draw.gridCost,
        },
        draw,
    };
}
