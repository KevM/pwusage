
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
            // Manually construct ISO-like string from LOCAL components to preserve Wall Clock time
            // (e.g. 20:20 in DB -> 20:20 in string, regardless of UTC shift)
            const d = point.timestamp;
            const pad = (n: number) => n.toString().padStart(2, '0');
            tsStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
        } else {
            tsStr = String(point.timestamp);
        }

        return {
            timestamp: tsStr,
            // Convert decawatts (10W) to Watts.
            // Using load_power (Total Home Load) as requested.
            powerWatts: point.load_power * 10,
            tariffId: point.tariff_id
        };
    });
}
