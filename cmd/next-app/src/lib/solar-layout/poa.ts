// Plane-of-array model (reference `poa_eff`, `model_power`, `_softmin`):
// Hay-Davies sky diffuse + ground diffuse (albedo 0.2) + beam with physical IAM,
// Marion-integrated diffuse IAM, then the irradiance-dependent temperature
// prior and the ambient-temperature factor.
import type { SunSample } from './sun';

export type Plane = { azimuth: number; tilt: number; effectiveKw: number };

export const ALBEDO = 0.2;
export const MAX_TILT = 50;
const TEMP_C = 0.10;
const RAD = Math.PI / 180;

/** pvlib.iam.physical with n = 1.526, K = 4, L = 0.002 (no AR coating). */
export function physicalIam(aoi: number): number {
    const n = 1.526;
    const kl = 4 * 0.002;
    const cos1 = Math.max(0, Math.cos(aoi * RAD));
    const sin1 = Math.sqrt(1 - cos1 * cos1);
    const sin2 = sin1 / n;
    const cos2 = Math.sqrt(1 - sin2 * sin2);
    const rs = ((cos1 - n * cos2) / (cos1 + n * cos2)) ** 2;
    const rp = ((cos2 - n * cos1) / (cos2 + n * cos1)) ** 2;
    const r0 = ((1 - n) / (1 + n)) ** 2;
    if (!(cos1 > 0)) return 0;
    const att = Math.exp(-kl / cos2);
    return ((1 - rs) * att + (1 - rp) * att) / 2 / ((1 - r0) * Math.exp(-kl));
}

const diffuseCache = new Map<number, { sky: number; ground: number }>();

/** pvlib.iam.marion_diffuse('physical', tilt) sky and ground terms, cached by tilt to 0.1°. */
export function diffuseIam(tilt: number): { sky: number; ground: number } {
    const key = Math.round(tilt * 10) / 10;
    let hit = diffuseCache.get(key);
    if (!hit) {
        hit = { sky: marionIntegrate(key, 'sky'), ground: marionIntegrate(key, 'ground') };
        diffuseCache.set(key, hit);
    }
    return hit;
}

function marionIntegrate(tilt: number, region: 'sky' | 'ground'): number {
    const num = 180;
    const beta = tilt * RAD;
    const ai = Math.PI / num;
    const cb = Math.cos(beta);
    const sb = Math.sin(beta);
    const cosPsi: number[] = [];
    for (let j = 0; j < 2 * num; j++) cosPsi.push(Math.cos(j * ai + 0.5 * ai));
    let numer = 0;
    let denom = 0;
    for (let i = 0; i < num; i++) {
        const phi1 = i * ai;
        if (region === 'sky' ? phi1 + ai > Math.PI / 2 + 1e-12 : phi1 < Math.PI / 2) continue;
        const phiAvg = phi1 + 0.5 * ai;
        const dAs = ai * (Math.cos(phi1) - Math.cos(phi1 + ai));
        const t1 = cb * Math.cos(phiAvg);
        const t2 = sb * Math.sin(phiAvg);
        for (let j = 0; j < 2 * num; j++) {
            const cosAoi = t1 + t2 * cosPsi[j];
            if (!(cosAoi > 0)) continue;
            const w = cosAoi * dAs;
            numer += physicalIam(Math.acos(Math.min(1, cosAoi)) / RAD) * w;
            denom += w;
        }
    }
    return denom !== 0 ? numer / denom : 0;
}

function cosAoi(sun: SunSample, azimuth: number, tilt: number): number {
    const z = sun.apparentZenith * RAD;
    const t = tilt * RAD;
    const proj = Math.cos(t) * Math.cos(z) + Math.sin(t) * Math.sin(z) * Math.cos((sun.azimuth - azimuth) * RAD);
    return Math.min(1, Math.max(-1, proj));
}

/** Hay-Davies POA components before IAM and temperature (pvlib get_total_irradiance). */
export function poaComponents(sun: SunSample, azimuth: number, tilt: number): { direct: number; skyDiffuse: number; groundDiffuse: number } {
    const ca = cosAoi(sun, azimuth, tilt);
    const direct = Math.max(sun.dni * ca, 0);
    const rb = Math.max(ca, 0) / Math.max(Math.cos(sun.apparentZenith * RAD), 0.01745);
    const anis = sun.dniExtra > 0 ? sun.dni / sun.dniExtra : 0;
    const iso = Math.max(sun.dhi * (1 - anis) * 0.5 * (1 + Math.cos(tilt * RAD)), 0);
    const circ = Math.max(sun.dhi * anis * rb, 0);
    const groundDiffuse = sun.ghi * ALBEDO * (1 - Math.cos(tilt * RAD)) * 0.5;
    return { direct, skyDiffuse: iso + circ, groundDiffuse };
}

/** Effective (post-IAM, temperature-adjusted) POA irradiance in W/m² for one plane. */
export function poaEffective(sun: SunSample, azimuth: number, tilt: number): number {
    if (!(sun.ghi > 0)) return 0;
    const t = Math.min(Math.max(tilt, 0), 89);
    const c = poaComponents(sun, azimuth, t);
    const aoi = Math.acos(cosAoi(sun, azimuth, t)) / RAD;
    const dif = diffuseIam(t);
    let eff = c.direct * physicalIam(aoi) + c.skyDiffuse * dif.sky + c.groundDiffuse * dif.ground;
    eff = Math.max(eff, 0);
    eff = eff * (1 - TEMP_C * eff / 1000) / (1 - TEMP_C);
    return eff * sun.tfac;
}

/** Smooth min(x, 1) (reference `_softmin`, s = 0.01). */
export function softmin(x: number, s = 0.01): number {
    const z = (x - 1) / s;
    const logAddExp = z > 0 ? z + Math.log1p(Math.exp(-z)) : Math.log1p(Math.exp(z));
    return x - s * logAddExp;
}

export function modelKw(sun: SunSample, planes: Plane[], clipKw: number | null): number {
    let total = 0;
    for (const p of planes) total += p.effectiveKw * poaEffective(sun, ((p.azimuth % 360) + 360) % 360, p.tilt) / 1000;
    return clipKw ? clipKw * softmin(total / clipKw) : total;
}
