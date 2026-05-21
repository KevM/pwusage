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
    period: string,
    requestedDurationHours: number,
    context: TransformContext
): EnergyDataRow[] {
    const socSamples = buildSocSamples(soeHistory);
    const results: EnergyDataRow[] = [];

    for (let i = 0; i < history.length; i++) {
        const h = history[i];
        const ts = new Date(h.timestamp);

        let durationHours = 24;
        if (i < history.length - 1) {
            const nextTs = new Date(history[i + 1].timestamp).getTime();
            durationHours = (nextTs - ts.getTime()) / (3600 * 1000);
        } else if (i > 0) {
            const prevTs = new Date(history[i - 1].timestamp).getTime();
            durationHours = (ts.getTime() - prevTs) / (3600 * 1000);
        }

        const shouldScaleDailyAggregate =
            period === 'day' && requestedDurationHours > 20 && durationHours > 20;
        const scale = shouldScaleDailyAggregate ? 1000 : 1;

        const hSolar = (h.total_solar_generation ?? h.solar_energy_exported) ?? 0;
        const hHome = h.total_home_usage ?? 0;

        const tariffId = context.getTariffId(ts);
        if (tariffId === null) continue;

        const tariffScheduleId = context.getTariffScheduleId(ts);

        const gridImported = h.grid_energy_imported ?? 0;
        const gridExported = h.total_grid_energy_exported ?? 0;
        const grid = gridImported !== 0 ? gridImported : -gridExported;

        const batteryCharge = h.total_battery_charge ?? 0;
        const batteryDischarge = h.total_battery_discharge ?? 0;
        const battery = batteryCharge !== 0 ? batteryCharge : -batteryDischarge;

        results.push({
            site_id: context.siteId,
            tariff_id: tariffId,
            tariff_schedule_id: tariffScheduleId,
            timestamp: ts,
            load_power: hHome * scale,
            solar_power: hSolar * scale,
            grid_power: grid * scale,
            battery_power: battery * scale,
            battery_soc: findNearestSoc(socSamples, ts.getTime()),
        });
    }

    return results;
}
