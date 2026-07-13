import { EnergyHistoryEntry, SoeHistoryEntry } from '../tesla-client';
import { buildSocSamples, findNearestSoc, SocSample } from './soc-interpolation';

export type { SocSample };

export interface EnergyDataRow {
    site_id: string;
    tariff_id: number;
    tariff_schedule_id: number | null;
    timestamp: Date;
    load_power: number;
    solar_power: number;
    grid_power: number;
    battery_power: number;
    battery_soc: number | null;
}

export interface TransformContext {
    siteId: string;
    getTariffId: (ts: Date) => number | null;
    getTariffScheduleId: (ts: Date) => number | null;
}

export function transformEnergyPoints(
    history: EnergyHistoryEntry[],
    soeHistory: SoeHistoryEntry[],
    context: TransformContext
): EnergyDataRow[] {
    const socSamples = buildSocSamples(soeHistory);
    const results: EnergyDataRow[] = [];

    for (let i = 0; i < history.length; i++) {
        const h = history[i];
        const ts = new Date(h.timestamp);

        const hSolar = (h.total_solar_generation ?? h.solar_energy_exported) ?? 0;
        const hHome = h.total_home_usage ?? 0;

        const tariffId = context.getTariffId(ts);
        if (tariffId === null) continue;

        const tariffScheduleId = context.getTariffScheduleId(ts);

        // Net rather than either-or: a single interval can have both import and
        // export (or charge and discharge), and the schema stores one signed value.
        const gridImported = h.grid_energy_imported ?? 0;
        const gridExported = h.total_grid_energy_exported ?? 0;
        const grid = gridImported - gridExported;

        const batteryCharge = h.total_battery_charge ?? 0;
        const batteryDischarge = h.total_battery_discharge ?? 0;
        const battery = batteryCharge - batteryDischarge;

        results.push({
            site_id: context.siteId,
            tariff_id: tariffId,
            tariff_schedule_id: tariffScheduleId,
            timestamp: ts,
            load_power: hHome,
            solar_power: hSolar,
            grid_power: grid,
            battery_power: battery,
            battery_soc: findNearestSoc(socSamples, ts.getTime()),
        });
    }

    return results;
}
