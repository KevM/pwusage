// Clear-interval selection, AC clip detection and learned shading (reference
// `detect` preamble, `detect_clip`, `envelope_clear`, `smoothness`,
// `flat_runs`, `learn_shade`). Series are on a regular 5-minute UTC grid;
// missing samples are NaN, as the reference's reindexed pandas Series.
import { sunAt, type SunSample } from './sun';

export type SeriesPoint = { time: Date; kw: number; sun: SunSample; localDay: string };
export type Series = SeriesPoint[];
export type ShadeSegment = { azimuthFrom: number; azimuthTo: number; belowElevation: number };

const STEP_MS = 300_000;

/** numpy-style linear-interpolated quantile of finite values; NaN when empty. */
export function quantile(values: ArrayLike<number>, q: number): number {
    const v: number[] = [];
    for (let i = 0; i < values.length; i++) if (Number.isFinite(values[i])) v.push(values[i]);
    if (v.length === 0) return NaN;
    v.sort((a, b) => a - b);
    const pos = q * (v.length - 1);
    const lo = Math.floor(pos);
    const hi = Math.min(lo + 1, v.length - 1);
    return v[lo] + (v[hi] - v[lo]) * (pos - lo);
}

export function median(values: ArrayLike<number>): number {
    return quantile(values, 0.5);
}

function localDayFormatter(timeZone: string): (d: Date) => string {
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    // Offsets change at most on the hour, so cache per UTC hour.
    const cache = new Map<number, string>();
    return d => {
        const key = Math.floor(d.getTime() / 3_600_000);
        let hit = cache.get(key);
        if (hit === undefined) {
            hit = fmt.format(d);
            cache.set(key, hit);
        }
        return hit;
    };
}

/** Regular 5-minute series with midpoint sun and the night baseline removed (reference `detect` lines 426-432). */
export function toSeries(samples: { timestamp: Date; solarWh: number }[], latitude: number, longitude: number, timeZone: string): Series {
    if (samples.length === 0) return [];
    const byTime = new Map<number, number>();
    for (const s of samples) {
        // Snap to the nearest 5-minute boundary: day records allow irregular
        // timestamps, and one off-grid sample must not shift the whole grid.
        const t = Math.round(s.timestamp.getTime() / STEP_MS) * STEP_MS;
        if (!byTime.has(t)) byTime.set(t, s.solarWh * 12 / 1000);
    }
    const times = [...byTime.keys()].sort((a, b) => a - b);
    const first = times[0];
    const last = times[times.length - 1];
    const dayOf = localDayFormatter(timeZone);
    const out: Series = [];
    for (let t = first; t <= last; t += STEP_MS) {
        const time = new Date(t);
        const kw = byTime.get(t);
        out.push({ time, kw: kw === undefined || !Number.isFinite(kw) ? NaN : kw, sun: sunAt(new Date(t + STEP_MS / 2), latitude, longitude), localDay: dayOf(time) });
    }
    const night: number[] = [];
    for (const p of out) if (p.sun.elevation < -6 && Number.isFinite(p.kw)) night.push(p.kw);
    const baseline = Math.max(night.length ? median(night) : 0, 0);
    for (const p of out) if (Number.isFinite(p.kw)) p.kw = Math.max(p.kw - baseline, 0);
    return out;
}

function utcDayKey(time: Date): number {
    return Math.floor(time.getTime() / 86_400_000);
}

/** AC clip plateau: many daylight intervals at the same maximum, in runs of 3+ on 5+ days. */
export function detectClip(series: Series): { limitKw: number; intervals: number; days: number } | null {
    const n = series.length;
    const day = series.map(p => p.sun.elevation > 10 && Number.isFinite(p.kw));
    const vals: number[] = [];
    for (let i = 0; i < n; i++) if (day[i]) vals.push(series[i].kw);
    if (vals.length < 500) return null;
    const hi = quantile(vals, 0.9999);
    const cand = [...new Set(vals.filter(v => v > 0.85 * hi).map(v => Math.round(v * 1000) / 1000))].sort((a, b) => b - a).slice(0, 60);
    let best: { limitKw: number; intervals: number; days: number } | null = null;
    for (const c of cand) {
        const tol = Math.max(0.004 * c, 0.013);
        const near = series.map((p, i) => day[i] && Math.abs(p.kw - c) <= tol);
        const count = near.reduce((a, b) => a + (b ? 1 : 0), 0);
        if (count < 30) continue;
        const runDays = new Set<number>();
        for (let i = 0; i < n;) {
            if (!near[i]) { i++; continue; }
            let j = i;
            while (j < n && near[j]) j++;
            if (j - i >= 3) for (let k = i; k < j; k++) runDays.add(utcDayKey(series[k].time));
            i = j;
        }
        const frac = count / vals.length;
        const above = vals.filter(v => v > c * 1.015 + 0.013).length;
        if (runDays.size >= 5 && frac > 0.003 && above < 0.05 * count) {
            if (!best || count > best.intervals) best = { limitKw: c, intervals: count, days: runDays.size };
        }
    }
    if (!best) return null;
    const limit = best.limitKw;
    const tol = Math.max(0.004 * limit, 0.013);
    const band: number[] = [];
    for (let i = 0; i < n; i++) if (day[i] && Math.abs(series[i].kw - limit) <= tol) band.push(series[i].kw);
    best.limitKw = Math.round(median(band) * 1000) / 1000;
    return best;
}

/** Rolling max (window 7, centred, min 5 finite) of the scaled second difference. */
export function smoothness(kw: ArrayLike<number>, scale: number): Float64Array {
    const n = kw.length;
    const d2 = new Float64Array(n).fill(NaN);
    for (let i = 1; i < n - 1; i++) d2[i] = Math.abs(kw[i - 1] - 2 * kw[i] + kw[i + 1]) / scale;
    const out = new Float64Array(n).fill(NaN);
    for (let i = 0; i < n; i++) {
        let count = 0;
        let mx = -Infinity;
        for (let j = Math.max(0, i - 3); j <= Math.min(n - 1, i + 3); j++) {
            if (Number.isFinite(d2[j])) { count++; if (d2[j] > mx) mx = d2[j]; }
        }
        if (count >= 5) out[i] = mx;
    }
    return out;
}

/**
 * Model-free clear mask: output normalised by clear-sky GHI, within a band of
 * its rolling (±7 day) upper envelope at the same UTC slot, and locally smooth.
 */
export function envelopeClear(series: Series, peakKw: number): boolean[] {
    const n = series.length;
    if (n === 0) return [];
    const day0 = utcDayKey(series[0].time);
    const nDays = utcDayKey(series[n - 1].time) - day0 + 1;
    const slots = 288;
    const grid = new Float64Array(nDays * slots).fill(NaN);
    const norm = new Float64Array(n).fill(NaN);
    for (let i = 0; i < n; i++) {
        const p = series[i];
        if (!(p.sun.elevation > 2)) continue;
        const x = p.kw / Math.max(p.sun.ghi, 30);
        norm[i] = x;
        const d = utcDayKey(p.time) - day0;
        const slot = Math.floor((p.time.getTime() % 86_400_000) / STEP_MS);
        if (Number.isNaN(grid[d * slots + slot])) grid[d * slots + slot] = x;
    }
    // Rolling 0.85 quantile over 15 days (centred, min 4 finite), then a 3-slot mean.
    const env = new Float64Array(nDays * slots).fill(NaN);
    const buf: number[] = [];
    for (let s = 0; s < slots; s++) {
        for (let d = 0; d < nDays; d++) {
            buf.length = 0;
            for (let k = Math.max(0, d - 7); k <= Math.min(nDays - 1, d + 7); k++) {
                const v = grid[k * slots + s];
                if (Number.isFinite(v)) buf.push(v);
            }
            if (buf.length >= 4) env[d * slots + s] = quantile(buf, 0.85);
        }
    }
    const smooth = new Float64Array(nDays * slots).fill(NaN);
    for (let d = 0; d < nDays; d++) {
        for (let s = 0; s < slots; s++) {
            let sum = 0, count = 0;
            for (let k = Math.max(0, s - 1); k <= Math.min(slots - 1, s + 1); k++) {
                const v = env[d * slots + k];
                if (Number.isFinite(v)) { sum += v; count++; }
            }
            if (count > 0) smooth[d * slots + s] = sum / count;
        }
    }
    const sm = smoothness(series.map(p => p.kw), peakKw);
    const out: boolean[] = new Array(n).fill(false);
    for (let i = 0; i < n; i++) {
        const p = series[i];
        if (!(p.sun.elevation > 5) || !Number.isFinite(norm[i])) continue;
        const d = utcDayKey(p.time) - day0;
        const slot = Math.floor((p.time.getTime() % 86_400_000) / STEP_MS);
        const e = smooth[d * slots + slot];
        const ratio = norm[i] / e;
        out[i] = ratio > 0.92 && ratio < 1.06 && sm[i] < 0.03 && e * Math.max(p.sun.ghi, 30) > 0.03 * peakKw;
    }
    return out;
}

/** Curtailment-like flat runs: measured constant (and below model) while the model moves. */
export function flatRuns(kw: ArrayLike<number>, model: ArrayLike<number>, clipKw: number | null): boolean[] {
    const n = kw.length;
    let maxP = -Infinity, maxM = -Infinity;
    for (let i = 0; i < n; i++) {
        if (kw[i] > maxP) maxP = kw[i];
        if (model[i] > maxM) maxM = model[i];
    }
    const flat = new Uint8Array(n);
    for (let i = 1; i < n; i++) {
        const dp = Math.abs(kw[i] - kw[i - 1]);
        const dm = Math.abs(model[i] - model[i - 1]);
        let f = dp < 0.004 * maxP && dm > 0.01 * maxM && kw[i] > 0.1 * maxP && kw[i] < 0.97 * model[i];
        if (clipKw) f = f && kw[i] < 0.98 * clipKw;
        flat[i] = f ? 1 : 0;
    }
    const out: boolean[] = new Array(n).fill(false);
    for (let i = 0; i < n; i++) {
        let sum = 0;
        for (let j = Math.max(0, i - 2); j <= Math.min(n - 1, i + 2); j++) sum += flat[j];
        out[i] = sum >= 3;
    }
    return out;
}

const AZ_EDGES = Array.from({ length: 37 }, (_, i) => i * 10);

export class ShadeMask {
    constructor(readonly horizon: number[], readonly hotBins: [number, number][]) {}

    shaded(azimuth: number, elevation: number): boolean {
        const i = Math.min(Math.max(Math.floor(azimuth / 10), 0), this.horizon.length - 1);
        if (elevation <= this.horizon[i]) return true;
        return this.hotBins.some(([a0, e0]) => azimuth >= a0 && azimuth < a0 + 10 && elevation >= e0 && elevation < e0 + 5);
    }

    /** Horizon profile merged into contiguous segments (reference `summary` / `_merge_segments`). */
    summary(): ShadeSegment[] {
        const out: ShadeSegment[] = [];
        this.horizon.forEach((h, i) => {
            if (!Number.isFinite(h)) return;
            const prev = out[out.length - 1];
            if (prev && prev.azimuthTo === AZ_EDGES[i] && Math.abs(prev.belowElevation - h) <= 5) {
                prev.azimuthTo = AZ_EDGES[i + 1];
                prev.belowElevation = Math.max(prev.belowElevation, h);
            } else {
                out.push({ azimuthFrom: AZ_EDGES[i], azimuthTo: AZ_EDGES[i + 1], belowElevation: h });
            }
        });
        return out;
    }
}

/**
 * Horizon profile: for each 10° sun-azimuth bin, the lowest elevation above
 * which the 80th-percentile measured/model ratio is >= thr in every populated
 * 2.5° bin, plus isolated strong-deficit bins above it (chimney, vent, pole).
 */
export function learnShade(saz: ArrayLike<number>, sel: ArrayLike<number>, ratio: ArrayLike<number>, dayIds: ArrayLike<string>, thr = 0.85): ShadeMask {
    const n = saz.length;
    const azBins: number[][] = Array.from({ length: 36 }, () => []);
    for (let k = 0; k < n; k++) {
        if (!Number.isFinite(ratio[k]) || !(saz[k] >= 0 && saz[k] < 360)) continue;
        azBins[Math.floor(saz[k] / 10)].push(k);
    }
    const horizon: number[] = new Array(36).fill(-Infinity);
    for (let i = 0; i < 36; i++) {
        const idx = azBins[i];
        if (idx.length < 20) continue;
        const elBins: number[][] = Array.from({ length: 36 }, () => []);
        for (const k of idx) {
            const j = Math.floor(sel[k] / 2.5);
            if (j >= 0 && j < 36) elBins[j].push(k);
        }
        let h = -Infinity;
        for (let j = 0; j < 36; j++) {
            const b = elBins[j];
            if (b.length < 8 || new Set(b.map(k => dayIds[k])).size < 3) continue;
            if (quantile(b.map(k => ratio[k]), 0.8) < thr) h = (j + 1) * 2.5;
            else break;
        }
        horizon[i] = Math.min(h, 45);
    }
    const hot: [number, number][] = [];
    for (let i = 0; i < 36; i++) {
        const idx = azBins[i];
        for (let e0 = 0; e0 < 90; e0 += 5) {
            const b = idx.filter(k => sel[k] >= e0 && sel[k] < e0 + 5 && sel[k] > horizon[i]);
            if (b.length >= 12 && new Set(b.map(k => dayIds[k])).size >= 4 && quantile(b.map(k => ratio[k]), 0.8) < 0.75) hot.push([i * 10, e0]);
        }
    }
    return new ShadeMask(horizon, hot);
}
