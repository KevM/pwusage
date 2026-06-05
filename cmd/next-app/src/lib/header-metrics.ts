import type { SiteLiveData } from './site-live-data-client';
import { getBatteryActivity, type BatteryActivity } from './live-indicators';

export interface HeaderMetricsModel {
    solarFormatted: string;
    gridFormatted: string;
    loadFormatted: string;
    gridDirection: 'import' | 'export' | 'none';
    batteryPercentage: number;
    batteryActivity: BatteryActivity;
}

export function buildHeaderMetricsModel(stats: SiteLiveData): HeaderMetricsModel {
    const threshold = 100; // 100 Watts threshold

    const solarFormatted = (Math.abs(stats.solarPower) / 1000).toFixed(1);
    const gridFormatted = (Math.abs(stats.gridPower) / 1000).toFixed(1);
    const loadFormatted = (Math.abs(stats.loadPower) / 1000).toFixed(1);

    let gridDirection: 'import' | 'export' | 'none' = 'none';
    if (stats.gridPower > threshold) {
        gridDirection = 'import';
    } else if (stats.gridPower < -threshold) {
        gridDirection = 'export';
    }

    const batteryActivity = getBatteryActivity(stats.batteryPower);

    return {
        solarFormatted,
        gridFormatted,
        loadFormatted,
        gridDirection,
        batteryPercentage: stats.percentageCharged,
        batteryActivity,
    };
}
