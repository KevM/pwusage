// Sun position and clear-sky irradiance for the solar layout detector. Ports
// the pieces of pvlib the Python reference (scripts/solar-layout-reference)
// uses: solar position (NOAA/Meeus with SPA's refraction), Spencer
// extraterrestrial DNI, Kasten-Young airmass and Ineichen-Perez clear sky with
// a climatological Linke turbidity of 3.0 at sea level.

export type SunSample = {
    apparentZenith: number;
    elevation: number;
    azimuth: number;
    dniExtra: number;
    ghi: number;
    dni: number;
    dhi: number;
    /** Relative efficiency from the generic ambient-temperature prior (reference `ambient_factor`). */
    tfac: number;
};

export const LINKE_TURBIDITY = 3.0;
const SOLAR_CONSTANT = 1366.1;
const AMB_SEASON = 8.0;
const AMB_DIURNAL = 4.0;
const GAMMA = -0.0037;

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

function mod(a: number, n: number): number {
    return ((a % n) + n) % n;
}

/** Day of year (1-366) in UTC, as pandas `dayofyear` on a UTC index. */
export function utcDayOfYear(time: Date): number {
    const start = Date.UTC(time.getUTCFullYear(), 0, 1);
    return Math.floor((time.getTime() - start) / 86_400_000) + 1;
}

/** Topocentric-ish solar position; returns true (unrefracted) zenith and azimuth in degrees. */
function solarPosition(time: Date, latitude: number, longitude: number): { zenith: number; azimuth: number } {
    const jd = time.getTime() / 86_400_000 + 2440587.5;
    const t = (jd - 2451545) / 36525;
    const l0 = mod(280.46646 + t * (36000.76983 + t * 0.0003032), 360);
    const m = 357.52911 + t * (35999.05029 - 0.0001537 * t);
    const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
    const mr = m * RAD;
    const c = Math.sin(mr) * (1.914602 - t * (0.004817 + 0.000014 * t))
        + Math.sin(2 * mr) * (0.019993 - 0.000101 * t)
        + Math.sin(3 * mr) * 0.000289;
    const trueLong = l0 + c;
    const omega = (125.04 - 1934.136 * t) * RAD;
    const appLong = (trueLong - 0.00569 - 0.00478 * Math.sin(omega)) * RAD;
    const eps0 = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
    const eps = (eps0 + 0.00256 * Math.cos(omega)) * RAD;
    const decl = Math.asin(Math.sin(eps) * Math.sin(appLong));
    const y = Math.tan(eps / 2) ** 2;
    const l0r = l0 * RAD;
    const eot = 4 * DEG * (y * Math.sin(2 * l0r) - 2 * e * Math.sin(mr)
        + 4 * e * y * Math.sin(mr) * Math.cos(2 * l0r)
        - 0.5 * y * y * Math.sin(4 * l0r) - 1.25 * e * e * Math.sin(2 * mr));
    const minutes = time.getUTCHours() * 60 + time.getUTCMinutes() + time.getUTCSeconds() / 60 + time.getUTCMilliseconds() / 60000;
    const tst = mod(minutes + eot + 4 * longitude, 1440);
    const ha = (tst / 4 - 180) * RAD;
    const lat = latitude * RAD;
    const cosZ = Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(ha);
    const zenith = Math.acos(Math.min(1, Math.max(-1, cosZ))) * DEG;
    const azimuth = mod(Math.atan2(Math.sin(ha), Math.cos(ha) * Math.sin(lat) - Math.tan(decl) * Math.cos(lat)) * DEG + 180, 360);
    return { zenith, azimuth };
}

/** SPA atmospheric refraction at 1013.25 mbar and 12 °C (pvlib defaults). */
function refraction(elevation: number): number {
    if (elevation < -(0.26667 + 0.5667)) return 0;
    return (1013.25 / 1010) * (283 / (273 + 12)) * 1.02 / (60 * Math.tan((elevation + 10.3 / (elevation + 5.11)) * RAD));
}

/** Spencer (1971) extraterrestrial normal irradiance, integer day of year as pvlib. */
export function extraterrestrialDni(time: Date): number {
    const b = (2 * Math.PI / 365) * (utcDayOfYear(time) - 1);
    const r = 1.00011 + 0.034221 * Math.cos(b) + 0.00128 * Math.sin(b) + 0.000719 * Math.cos(2 * b) + 0.000077 * Math.sin(2 * b);
    return SOLAR_CONSTANT * r;
}

/** Kasten-Young (1989) relative airmass; NaN below the horizon. */
function airmass(apparentZenith: number): number {
    if (apparentZenith > 90) return NaN;
    return 1 / (Math.cos(apparentZenith * RAD) + 0.50572 * (6.07995 + (90 - apparentZenith)) ** -1.6364);
}

/** Reference `ambient_factor`: seasonal ±8 °C peaking ~Jul 19, diurnal ±4 °C peaking 15 h solar. */
export function ambientFactor(time: Date, longitude: number): number {
    const doy = utcDayOfYear(time);
    const solarH = mod(time.getUTCHours() + time.getUTCMinutes() / 60 + longitude / 15, 24);
    const dT = AMB_SEASON * Math.cos(2 * Math.PI * (doy - 200) / 365) + AMB_DIURNAL * Math.cos(2 * Math.PI * (solarH - 15) / 24);
    return 1 + GAMMA * dT;
}

export function sunAt(time: Date, latitude: number, longitude: number): SunSample {
    const pos = solarPosition(time, latitude, longitude);
    const trueElevation = 90 - pos.zenith;
    const elevation = trueElevation + refraction(trueElevation);
    const apparentZenith = 90 - elevation;
    const dniExtra = extraterrestrialDni(time);
    const tfac = ambientFactor(time, longitude);

    const cosZ = Math.max(Math.cos(apparentZenith * RAD), 0);
    const am = airmass(apparentZenith);
    if (!(cosZ > 0) || !Number.isFinite(am)) {
        return { apparentZenith, elevation, azimuth: pos.azimuth, dniExtra, ghi: 0, dni: 0, dhi: 0, tfac };
    }
    // Ineichen-Perez at altitude 0 (fh1 = fh2 = 1).
    const tl = LINKE_TURBIDITY;
    const cg1 = 0.868;
    const cg2 = 0.0387;
    const ghi = Math.max(cg1 * dniExtra * cosZ * Math.exp(-cg2 * am * (1 + (tl - 1))), 0);
    const b = 0.664 + 0.163;
    const bnci = dniExtra * Math.max(b * Math.exp(-0.09 * am * (tl - 1)), 0);
    const bnci2 = ghi * Math.min(Math.max((1 - (0.1 - 0.2 * Math.exp(-tl)) / (0.1 + 0.882)) / cosZ, 0), 1e20);
    const dni = Math.min(bnci, bnci2);
    const dhi = ghi - dni * cosZ;
    return { apparentZenith, elevation, azimuth: pos.azimuth, dniExtra, ghi, dni, dhi, tfac };
}
