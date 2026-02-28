export type BatteryActivity = 'charging' | 'discharging' | 'idle';

export function getBatteryActivity(powerWatts: number): BatteryActivity {
    if (powerWatts < -100) return 'charging';
    if (powerWatts > 100) return 'discharging';
    return 'idle';
}
