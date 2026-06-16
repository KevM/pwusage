import type { EnergyData } from '../db';
import { allocateEdges, energyDataToInstant } from '../sankey/build-flow-model';
import type { EdgeCategory } from '../sankey/flow-model';
import { solarOnlyNet } from './counterfactual';

const WH_PER_KWH = 1000;

export interface IntervalFlows {
    loadWh: number;
    solarToHomeWh: number;
    solarToBatteryWh: number;
    solarToGridWh: number;
    gridToHomeWh: number;
    gridToBatteryWh: number;
    batteryToHomeWh: number;
    batteryToGridWh: number;
    solarOnlyImportWh: number;
    solarOnlyExportWh: number;
}

function edgeWh(edges: ReturnType<typeof allocateEdges>, category: EdgeCategory): number {
    const e = edges.find(x => x.category === category);
    return e ? e.energy * WH_PER_KWH : 0;
}

/** Per-interval energy decomposition (Wh), plan-agnostic (no rates, no tank).
 *  Single source of truth shared by the period rollup (replay.ts) and the hourly profile. */
export function intervalFlows(row: EnergyData): IntervalFlows {
    const edges = allocateEdges(energyDataToInstant(row), { buyRate: 0, sellRate: 0 });
    const solarToHomeWh = edgeWh(edges, 'solar-home');
    const gridToHomeWh = edgeWh(edges, 'grid-home');
    const batteryToHomeWh = edgeWh(edges, 'battery-home');
    const so = solarOnlyNet(row.load_power, row.solar_power);
    return {
        loadWh: solarToHomeWh + gridToHomeWh + batteryToHomeWh,
        solarToHomeWh,
        solarToBatteryWh: edgeWh(edges, 'solar-battery'),
        solarToGridWh: edgeWh(edges, 'solar-export'),
        gridToHomeWh,
        gridToBatteryWh: edgeWh(edges, 'grid-battery'),
        batteryToHomeWh,
        batteryToGridWh: edgeWh(edges, 'battery-export'), // allocator names battery→grid 'battery-export'
        solarOnlyImportWh: so.importWh,
        solarOnlyExportWh: so.exportWh,
    };
}
