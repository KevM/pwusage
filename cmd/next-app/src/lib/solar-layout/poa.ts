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

/** Struct-of-arrays sun geometry for fast per-plane columns (one entry per row). */
export type SunArrays = {
    n: number;
    cosZ: Float64Array; sinZ: Float64Array; cosSaz: Float64Array; sinSaz: Float64Array;
    dni: Float64Array; ghi: Float64Array; dhi: Float64Array; anis: Float64Array; rbDen: Float64Array; tfac: Float64Array;
};

export function toSunArrays(suns: SunSample[]): SunArrays {
    const n = suns.length;
    const a = () => new Float64Array(n);
    const out: SunArrays = { n, cosZ: a(), sinZ: a(), cosSaz: a(), sinSaz: a(), dni: a(), ghi: a(), dhi: a(), anis: a(), rbDen: a(), tfac: a() };
    suns.forEach((s, i) => {
        const z = s.apparentZenith * RAD;
        out.cosZ[i] = Math.cos(z);
        out.sinZ[i] = Math.sin(z);
        out.cosSaz[i] = Math.cos(s.azimuth * RAD);
        out.sinSaz[i] = Math.sin(s.azimuth * RAD);
        out.dni[i] = s.dni;
        out.ghi[i] = s.ghi;
        out.dhi[i] = s.dhi;
        out.anis[i] = s.dniExtra > 0 ? s.dni / s.dniExtra : 0;
        out.rbDen[i] = Math.max(out.cosZ[i], 0.01745);
        out.tfac[i] = s.tfac;
    });
    return out;
}

/** diffuseIam linearly interpolated between 0.1° points, so the fit sees a smooth tilt response. */
export function diffuseIamSmooth(tilt: number): { sky: number; ground: number } {
    const lo = Math.floor(tilt * 10) / 10;
    const f = (tilt - lo) * 10;
    const a = diffuseIam(lo);
    if (f < 1e-9) return a;
    const b = diffuseIam(lo + 0.1);
    return { sky: a.sky + (b.sky - a.sky) * f, ground: a.ground + (b.ground - a.ground) * f };
}

/** poaEffective / 1000 for every row into `out` (kW per kW of effective size). */
export function poaColumn(sun: SunArrays, azimuth: number, tilt: number, out: Float64Array, smooth = false): Float64Array {
    const t = Math.min(Math.max(tilt, 0), 89);
    const ct = Math.cos(t * RAD);
    const st = Math.sin(t * RAD);
    const ca = Math.cos(azimuth * RAD);
    const sa = Math.sin(azimuth * RAD);
    const dif = smooth ? diffuseIamSmooth(t) : diffuseIam(t);
    const isoF = 0.5 * (1 + ct);
    const grdF = ALBEDO * (1 - ct) * 0.5 * dif.ground;
    const n = 1.526;
    const kl = 4 * 0.002;
    const r0 = ((1 - n) / (1 + n)) ** 2;
    const norm0 = 2 * (1 - r0) * Math.exp(-kl);
    for (let i = 0; i < sun.n; i++) {
        if (!(sun.ghi[i] > 0)) { out[i] = 0; continue; }
        let c = ct * sun.cosZ[i] + st * sun.sinZ[i] * (sun.cosSaz[i] * ca + sun.sinSaz[i] * sa);
        c = c > 1 ? 1 : c < -1 ? -1 : c;
        let beam = 0;
        if (c > 0) {
            const sin2 = Math.sqrt(1 - c * c) / n;
            const cos2 = Math.sqrt(1 - sin2 * sin2);
            const rs = ((c - n * cos2) / (c + n * cos2)) ** 2;
            const rp = ((cos2 - n * c) / (cos2 + n * c)) ** 2;
            beam = sun.dni[i] * c * ((2 - rs - rp) * Math.exp(-kl / cos2) / norm0);
        }
        const anis = sun.anis[i];
        const iso = sun.dhi[i] * (1 - anis) * isoF;
        const circ = c > 0 ? sun.dhi[i] * anis * c / sun.rbDen[i] : 0;
        let eff = beam + (Math.max(iso, 0) + Math.max(circ, 0)) * dif.sky + sun.ghi[i] * grdF;
        if (eff < 0) eff = 0;
        out[i] = eff * (1 - TEMP_C * eff / 1000) / (1 - TEMP_C) * sun.tfac[i] / 1000;
    }
    return out;
}
