
import { EnergyData } from '../db';
import { PowerData } from './types';

/**
 * Adapts Tesla EnergyData (where grid_power is in decawatts, i.e., 1 unit = 10W)
 * to normalized PowerData (Watts).
 */
export function adaptTeslaData(data: EnergyData[]): PowerData[] {
    return data.map(point => ({
        timestamp: point.timestamp,
        // Convert decawatts (10W) to Watts.
        // Using load_power (Total Home Load) as requested.
        powerWatts: point.load_power * 10,
        tariffId: point.tariff_id
    }));
}
