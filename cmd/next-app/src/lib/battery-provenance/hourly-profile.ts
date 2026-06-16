import type { EnergyData } from '../db';
import { intervalFlows } from './interval-flows';
import { localDateKey, localHour } from './local-day';

export interface HourlyBucket {
    siteId: string;
    localDate: string; // 'YYYY-MM-DD'
    hour: number;      // 0..23
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

function emptyBucket(siteId: string, localDate: string, hour: number): HourlyBucket {
    return {
        siteId, localDate, hour,
        loadWh: 0, solarToHomeWh: 0, solarToBatteryWh: 0, solarToGridWh: 0,
        gridToHomeWh: 0, gridToBatteryWh: 0, batteryToHomeWh: 0, batteryToGridWh: 0,
        solarOnlyImportWh: 0, solarOnlyExportWh: 0,
    };
}

/** Aggregate 5-min EnergyData into plan-agnostic (site, local_date, hour) buckets.
 *  Reuses intervalFlows so the energy decomposition matches the period rollup exactly. */
export function aggregateHourly(rows: EnergyData[], timeZone: string): HourlyBucket[] {
    const byKey = new Map<string, HourlyBucket>();
    for (const row of rows) {
        const localDate = localDateKey(row.timestamp, timeZone);
        const hour = localHour(row.timestamp, timeZone);
        const key = `${localDate}|${hour}`;
        let b = byKey.get(key);
        if (!b) { b = emptyBucket(row.site_id, localDate, hour); byKey.set(key, b); }
        const f = intervalFlows(row);
        b.loadWh += f.loadWh;
        b.solarToHomeWh += f.solarToHomeWh;
        b.solarToBatteryWh += f.solarToBatteryWh;
        b.solarToGridWh += f.solarToGridWh;
        b.gridToHomeWh += f.gridToHomeWh;
        b.gridToBatteryWh += f.gridToBatteryWh;
        b.batteryToHomeWh += f.batteryToHomeWh;
        b.batteryToGridWh += f.batteryToGridWh;
        b.solarOnlyImportWh += f.solarOnlyImportWh;
        b.solarOnlyExportWh += f.solarOnlyExportWh;
    }
    return [...byKey.values()];
}
