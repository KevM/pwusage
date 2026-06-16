import type { EnergyData } from '../db';
import { Schedule } from '../schedule';
import { resolveRates } from './rates';
import { chargeTank, dischargeTank, EMPTY_TANK, type Tank } from './tank';
import { localDateKey } from './local-day';
import { intervalFlows } from './interval-flows';

export interface PeriodRollup {
    siteId: string;
    localDate: string;
    tariffScheduleId: number;
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
    buyRate: number;          // resolved rate snapshot for this period

    sellRate: number;
    batterySoc: number | null; // SOC as of tankAsOf (end of period)
    tank: Tank;       // end-of-period snapshot of the continuous tank
    tankAsOf: Date;   // timestamp of the last interval folded into this row
}



function emptyRollup(siteId: string, localDate: string, scheduleId: number): PeriodRollup {
    return {
        siteId, localDate, tariffScheduleId: scheduleId,
        loadWh: 0, solarToHomeWh: 0, solarToBatteryWh: 0, solarToGridWh: 0,
        gridToHomeWh: 0, gridToBatteryWh: 0, batteryToHomeWh: 0, batteryToGridWh: 0,
        solarOnlyImportWh: 0, solarOnlyExportWh: 0,
        buyRate: 0, sellRate: 0, batterySoc: null,

        tank: EMPTY_TANK, tankAsOf: new Date(0),
    };
}

/**
 * Replay EnergyData rows (any span) in timestamp order through one continuous tank.
 * Emits one PeriodRollup per (localDate, tariff_schedule_id); each row snapshots the
 * continuous tank as of its last contributing interval. Returns the final tank.
 */
export function replayRows(
    rows: EnergyData[],
    schedule: Schedule,
    timeZone: string,
    seed: Tank,
    options?: {
        genesisAnchorTimestamp?: Date;
    }
): { rollups: PeriodRollup[]; endTank: Tank } {
    const ordered = [...rows].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    const byKey = new Map<string, PeriodRollup>();
    let tank = seed;

    for (const row of ordered) {
        const period = schedule.getTariffPeriod(row.timestamp);
        if (!period || row.tariff_schedule_id == null) continue; // unkeyable; skip
        const rates = resolveRates(period);
        const f = intervalFlows(row);

        // Prefer Tesla's measured charge source; fall back to sankey allocation.
        const chargeSolarWh = row.battery_charge_from_solar ?? f.solarToBatteryWh;
        const chargeGridWh = row.battery_charge_from_grid ?? f.gridToBatteryWh;

        const shouldSimulateTank = !options?.genesisAnchorTimestamp || row.timestamp.getTime() > options.genesisAnchorTimestamp.getTime();
        if (shouldSimulateTank) {
            tank = chargeTank(tank, chargeSolarWh, chargeGridWh, rates.buyRate, rates.sellRate);
            const dischargeWh = f.batteryToHomeWh + f.batteryToGridWh;
            if (dischargeWh > 0) {
                tank = dischargeTank(tank, dischargeWh).tank;
            }
        }

        const localDate = localDateKey(row.timestamp, timeZone);
        const key = `${localDate}|${row.tariff_schedule_id}`;
        let r = byKey.get(key);
        if (!r) {
            r = emptyRollup(row.site_id, localDate, row.tariff_schedule_id);
            byKey.set(key, r);
        }
        r.loadWh += f.loadWh;
        r.solarToHomeWh += f.solarToHomeWh;
        r.solarToBatteryWh += f.solarToBatteryWh;
        r.solarToGridWh += f.solarToGridWh;
        r.gridToHomeWh += f.gridToHomeWh;
        r.gridToBatteryWh += f.gridToBatteryWh;
        r.batteryToHomeWh += f.batteryToHomeWh;
        r.batteryToGridWh += f.batteryToGridWh;
        r.solarOnlyImportWh += f.solarOnlyImportWh;
        r.solarOnlyExportWh += f.solarOnlyExportWh;
        r.buyRate = rates.buyRate;   // constant across the period (one schedule)

        r.sellRate = rates.sellRate;
        r.batterySoc = row.battery_soc; // SOC of the latest interval = end of period
        r.tank = tank;            // continuous tank as of this interval
        r.tankAsOf = row.timestamp;
    }

    return { rollups: [...byKey.values()], endTank: tank };
}
