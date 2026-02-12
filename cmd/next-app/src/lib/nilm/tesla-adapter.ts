
import { EnergyData } from '../db';
import { PowerData } from './types';

/**
 * Adapts Tesla EnergyData (where grid_power is in decawatts, i.e., 1 unit = 10W)
 * to normalized PowerData (Watts).
 */
export function adaptTeslaData(data: EnergyData[]): PowerData[] {
    return data.map(point => {
        let tsStr: string;
        if (point.timestamp instanceof Date) {
            tsStr = point.timestamp.toISOString();
        } else {
            tsStr = String(point.timestamp);
        }

        return {
            timestamp: tsStr,
            // Convert decawatts (10W) to Watts.
            // Using load_power (Total Home Load) as requested.
            powerWatts: point.load_power * 10,
            solarWatts: point.solar_power * 10,
            batteryWatts: point.battery_power * 10,
            gridWatts: point.grid_power * 10,
            tariffId: point.tariff_id
        };
    });
}
