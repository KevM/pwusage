
export interface PowerData {
    timestamp: Date | string;
    powerWatts: number;
    tariffId?: number;
    touName?: string;
    solarWatts?: number;
    batteryWatts?: number;
    gridWatts?: number;
}
