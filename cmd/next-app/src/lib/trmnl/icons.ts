/**
 * Static SVG icon generators for the TRMNL e-ink display.
 *
 * Each function accepts a `size` parameter so callers can request
 * arbitrary dimensions without maintaining separate "LARGE" variants.
 */

export const CHARGING_PATH = "M13 2L3 14h9l-1 8 10-12h-9l1-8z";
export const DISCHARGING_PATH = "M12 2v10M3 12h18M7 16h10M10 20h4";
export const ICON_ROTATION = "rotate(-90, 12, 12)";

export function getSunIcon(size: number): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="black" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5" fill="black" stroke="none"/><line x1="12" y1="1" x2="12" y2="4" /><line x1="12" y1="20" x2="12" y2="23" /><line x1="4.22" y1="4.22" x2="6.34" y2="6.34" /><line x1="17.66" y1="17.66" x2="19.78" y2="19.78" /><line x1="1" y1="12" x2="4" y2="12" /><line x1="20" y1="12" x2="23" y2="12" /><line x1="4.22" y1="19.78" x2="6.34" y2="17.66" /><line x1="17.66" y1="6.34" x2="19.78" y2="4.22" /></svg>`;
}

export function getGridIcon(size: number): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="6 0 12 24" width="${size}" height="${size}"><path d="M7 2v11h3v9l7-12h-4l4-8z" fill="black"/></svg>`;
}

export function getChargingIcon(size: number): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}" fill="black"><path d="${CHARGING_PATH}" transform="${ICON_ROTATION}"/></svg>`;
}

export function getDischargingIcon(size: number): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="black" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="${DISCHARGING_PATH}" transform="${ICON_ROTATION}" /></svg>`;
}


/* Pre-sized constants kept for backwards compatibility with existing callers. */
export const SUN_ICON = getSunIcon(40);
export const SUN_ICON_LARGE = getSunIcon(48);
export const GRID_ICON = getGridIcon(40);
export const GRID_ICON_LARGE = getGridIcon(48);
export const CHARGING_ICON = getChargingIcon(32);
export const CHARGING_ICON_LARGE = getChargingIcon(40);
export const DISCHARGING_ICON = getDischargingIcon(32);
export const DISCHARGING_ICON_LARGE = getDischargingIcon(40);
