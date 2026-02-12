/**
 * Utility functions for energy and power conversions.
 * Note: Throughout this codebase, 'Average Power' refers to the average rate
 * of energy usage (Watts) over a specific time interval.
 */

/**
 * Converts Energy (Watt-hours) over a given interval to Average Power (Watts).
 * Formula: Power (W) = Energy (Wh) * (60 / intervalMinutes)
 * 
 * Common usage: 5-minute Tesla data (Wh) * 12 = Average Watts
 */
export function energyToAveragePower(wh: number, intervalMinutes: number = 5): number {
    if (intervalMinutes === 0) return 0;
    return wh * (60 / intervalMinutes);
}

/**
 * Converts Watts to Kilowatts.
 */
export function wattsToKilowatts(watts: number): number {
    return watts / 1000;
}

/**
 * Converts Kilowatts to Watts.
 */
export function kilowattsToWatts(kw: number): number {
    return kw * 1000;
}

/**
 * Converts Energy (Wh) directly to Kilowatts (Average Power) for a 5-minute interval.
 */
export function whToKilowatts(wh: number): number {
    return wattsToKilowatts(energyToAveragePower(wh, 5));
}
