// Solar layout detection from a site's own 5-minute production history
// (reference `detect` in scripts/solar-layout-reference/detector.py), plus the
// confidence rule and a solar-noon location check.
import { MAX_TILT, modelKw, type Plane } from './poa';
import { detectClip, envelopeClear, flatRuns, learnShade, median, quantile, smoothness, toSeries, type ShadeMask, type ShadeSegment } from './selection';
import {
    azimuthRange90, bootstrapRows, fitFromGram, fitMaskGroup, fitRows, gridColumns, groupGrams, modelRows,
    planeCountFromRows, seededRng, subsetRows, toPlanes, type FitRows,
} from './fit';

export const SOLAR_LAYOUT_DETECTOR_VERSION = 1;
export const DERATE = 0.85;
export const MIN_HISTORY_DAYS = 42;

export type SolarLayoutPlane = {
    azimuth: number; tilt: number; dcKwp: number; effectiveKw: number;
    azimuthRange90: [number, number]; tiltRange90: [number, number];
};

export type SolarLayoutResult = {
    status: 'detected' | 'low-confidence' | 'not-enough-history' | 'failed';
    confidence: 'high' | 'medium' | 'low' | null;
    reasons: string[];
    planes: SolarLayoutPlane[];
    acClipKw: number | null;
    historyDays: number;
    clearDays: number;
    firstDay: string | null;
    lastDay: string | null;
    shading: ShadeSegment[];
};

export class DetectionDeadlineError extends Error {
    constructor() {
        super('Solar layout detection ran past its deadline');
        this.name = 'DetectionDeadlineError';
    }
}

const round = (v: number, digits: number) => Math.round(v * 10 ** digits) / 10 ** digits;

function rangeWidth([lo, hi]: [number, number]): number {
    return ((hi - lo) % 360 + 360) % 360;
}

/** Longitude error (degrees) above which the stored location is treated as another place. */
export const LOCATION_MISMATCH_DEGREES = 3;

/**
 * Solar-noon check: on each clear day, the midpoint between the interpolated
 * times production first rises above and last falls below 2% of the day's
 * peak, measured against the same midpoint of the fitted layout's model.
 * Production later than the model means the site is further west (4 minutes
 * per degree). Returns the median over clear days, or null without any.
 *
 * Comparing whole-day production centroids misses a wrong location because
 * the fitted planes absorb most of a timing error; the low-sun edges of the
 * day are set by the sun, not the panels. Terrain still shifts them (a hill to
 * the east delays the morning edge by up to ~2.4° at one research site), hence
 * the 3° threshold rather than a tighter one.
 */
export function longitudeOffset(days: { t: number[]; measured: number[]; model: number[] }[]): number | null {
    const crossingMid = (t: number[], v: number[]): number | null => {
        let peak = 0;
        for (const x of v) if (x > peak) peak = x;
        if (!(peak > 0)) return null;
        const th = 0.02 * peak;
        let first = -1, last = -1;
        for (let i = 0; i < v.length; i++) if (v[i] > th) { if (first < 0) first = i; last = i; }
        if (first < 1 || last >= v.length - 1) return null;
        const up = t[first - 1] + (t[first] - t[first - 1]) * (th - v[first - 1]) / (v[first] - v[first - 1]);
        const down = t[last] + (t[last + 1] - t[last]) * (v[last] - th) / (v[last] - v[last + 1]);
        return (up + down) / 2;
    };
    const offsets: number[] = [];
    for (const d of days) {
        const m = crossingMid(d.t, d.measured);
        const k = crossingMid(d.t, d.model);
        if (m !== null && k !== null) offsets.push((m - k) / 60_000 / 4);
    }
    return offsets.length ? median(offsets) : null;
}

export function detectSolarLayout(input: {
    samples: { timestamp: Date; solarWh: number }[]; latitude: number; longitude: number; timeZone: string;
    deadline?: number; seed?: number; bootstrapRounds?: number;
}): SolarLayoutResult {
    const checkDeadline = () => { if (input.deadline !== undefined && Date.now() > input.deadline) throw new DetectionDeadlineError(); };
    checkDeadline();
    const rng = seededRng(input.seed ?? 0);
    const series = toSeries(input.samples, input.latitude, input.longitude, input.timeZone);

    const producing = new Set<string>();
    for (const p of series) if (p.kw > 0) producing.add(p.localDay);
    const producingDays = [...producing].sort();
    const empty: SolarLayoutResult = {
        status: 'not-enough-history', confidence: null, reasons: [], planes: [], acClipKw: null,
        historyDays: producingDays.length, clearDays: 0,
        firstDay: producingDays[0] ?? null, lastDay: producingDays[producingDays.length - 1] ?? null, shading: [],
    };
    if (producingDays.length < MIN_HISTORY_DAYS) return empty;

    const peak = quantile(series.filter(p => p.sun.elevation > 10).map(p => p.kw), 0.999);
    if (!(peak > 0)) return empty;
    const clip = detectClip(series);
    const clipKw = clip?.limitKw ?? null;
    checkDeadline();

    // Model-free clear selection (envelope + smoothness); smooth points on a clip plateau also count.
    const clear0 = envelopeClear(series, peak);
    if (clipKw) {
        const sm = smoothness(series.map(p => p.kw), peak);
        series.forEach((p, i) => {
            if (Math.abs(p.kw - clipKw) < 0.01 * clipKw && sm[i] < 0.03 && p.sun.elevation > 5) clear0[i] = true;
        });
    }
    const clearIdx: number[] = [];
    series.forEach((p, i) => { if (clear0[i] && p.sun.elevation > 3 && Number.isFinite(p.kw)) clearIdx.push(i); });
    const clearMask = series.map(() => false);
    for (const i of clearIdx) clearMask[i] = true;
    const rowsC = fitRows(series, clearMask);
    const lowEvidence = (): SolarLayoutResult => ({ ...empty, status: 'low-confidence', confidence: 'low', reasons: ['few-clear-days'] });
    if (rowsC.y.length < 200) return lowEvidence();
    const colsC = gridColumns(rowsC);
    checkDeadline();

    const fitTwo = (keep: boolean[]) => {
        const [gram] = groupGrams(colsC, rowsC.y, fitMaskGroup(rowsC, clipKw, r => (keep[r] ? 0 : -1)), 1);
        const sub = subsetRows(rowsC, r => keep[r]);
        return fitFromGram(sub, gram, clipKw, 2, 3).params;
    };

    // The model only learns a persistent-deficit shade mask and drops gross outliers
    // (snow, curtailment); a tight model-ratio band would hide real extra planes.
    const nC = rowsC.y.length;
    const saz = Float64Array.from(clearIdx, i => series[i].sun.azimuth);
    const sel = Float64Array.from(clearIdx, i => series[i].sun.elevation);
    const dayIds = clearIdx.map(i => series[i].localDay);
    let keep: boolean[] = new Array(nC).fill(true);
    let pars = fitTwo(keep);
    checkDeadline();
    let shade: ShadeMask | null = null;
    for (let it = 0; it < 2; it++) {
        const m = modelRows(pars, rowsC, clipKw);
        const ratio = Float64Array.from(m, (v, r) => (v > 0.02 * peak ? rowsC.y[r] / v : NaN));
        shade = learnShade(saz, sel, ratio, dayIds);
        const flat = flatRuns(rowsC.y, m, clipKw);
        const mask = shade;
        keep = Array.from({ length: nC }, (_, r) => Math.abs(rowsC.y[r] - m[r]) < 0.15 * peak && !flat[r] && !mask.shaded(saz[r], sel[r]));
        pars = fitTwo(keep);
        checkDeadline();
    }
    const shadeMask = shade!;

    // Clear days: >= 60% of unshaded elevation > 10° rows selected; partly clear (>= 25%) days contribute.
    const e10 = new Map<string, number>();
    const s10 = new Map<string, number>();
    series.forEach(p => {
        if (p.sun.elevation > 10 && Number.isFinite(p.kw) && !shadeMask.shaded(p.sun.azimuth, p.sun.elevation)) e10.set(p.localDay, (e10.get(p.localDay) ?? 0) + 1);
    });
    clearIdx.forEach((i, r) => {
        const p = series[i];
        if (keep[r] && p.sun.elevation > 10 && !shadeMask.shaded(p.sun.azimuth, p.sun.elevation)) s10.set(p.localDay, (s10.get(p.localDay) ?? 0) + 1);
    });
    const clearDays = new Set<string>();
    const useDays = new Set<string>();
    for (const [day, total] of e10) {
        const frac = (s10.get(day) ?? 0) / total;
        if (frac >= 0.6) clearDays.add(day);
        if (frac >= 0.25) useDays.add(day);
    }
    const finalKeep = keep.map((k, r) => k && useDays.has(dayIds[r]));
    const rows: FitRows = subsetRows(rowsC, r => finalKeep[r]);
    if (rows.y.length < 200 || rows.days.length < 5) {
        return { ...lowEvidence(), acClipKw: clipKw, clearDays: clearDays.size, shading: shadeMask.summary() };
    }
    const keptIdx: number[] = [];
    finalKeep.forEach((k, r) => { if (k) keptIdx.push(r); });
    const cols = colsC.map(c => Float32Array.from(keptIdx, r => c[r]));
    checkDeadline();

    const choice = planeCountFromRows(rows, cols, clipKw, rng, checkDeadline);
    const best = toPlanes(choice.fits[choice.count].params);
    const boots = bootstrapRows(rows, clipKw, best, input.bootstrapRounds ?? 20, rng, checkDeadline);

    const planes: SolarLayoutPlane[] = best.map((p, i) => {
        const bAz = boots.map(b => b[i].azimuth);
        const bTilt = boots.map(b => b[i].tilt);
        const [alo, ahi] = boots.length ? azimuthRange90(bAz, p.azimuth) : [p.azimuth, p.azimuth];
        return {
            azimuth: round(p.azimuth, 1),
            tilt: round(p.tilt, 1),
            dcKwp: round(p.effectiveKw / DERATE, 2),
            effectiveKw: round(p.effectiveKw, 2),
            azimuthRange90: [round(alo, 1), round(ahi, 1)],
            tiltRange90: boots.length ? [round(quantile(bTilt, 0.05), 1), round(quantile(bTilt, 0.95), 1)] : [round(p.tilt, 1), round(p.tilt, 1)],
        };
    });

    const noonDays = new Map<string, { t: number[]; measured: number[]; model: number[] }>();
    for (const p of series) {
        if (!clearDays.has(p.localDay) || !(p.sun.elevation > -2)) continue;
        let d = noonDays.get(p.localDay);
        if (!d) noonDays.set(p.localDay, (d = { t: [], measured: [], model: [] }));
        d.t.push(p.time.getTime() + 150_000);
        d.measured.push(Number.isFinite(p.kw) ? p.kw : 0);
        d.model.push(modelKw(p.sun, best, clipKw));
    }
    const lonOffset = longitudeOffset([...noonDays.values()]);

    const reasons: string[] = [];
    if (clearDays.size < 15) reasons.push('few-clear-days');
    if (best.some(p => p.tilt >= MAX_TILT - 2)) reasons.push('plane-at-tilt-limit');
    const largest = planes.reduce((a, b) => (b.effectiveKw > a.effectiveKw ? b : a), planes[0]);
    const azWidth = rangeWidth(largest.azimuthRange90);
    if (azWidth > 60) reasons.push('azimuth-uncertain');
    if (lonOffset !== null && Math.abs(lonOffset) > LOCATION_MISMATCH_DEGREES) reasons.push('location-mismatch');
    const confidence = reasons.length > 0 ? 'low'
        : clearDays.size >= 40 && producingDays.length >= 180 && azWidth <= 30 ? 'high' : 'medium';
    return {
        status: confidence === 'low' ? 'low-confidence' : 'detected',
        confidence, reasons, planes, acClipKw: clipKw,
        historyDays: producingDays.length, clearDays: clearDays.size,
        firstDay: empty.firstDay, lastDay: empty.lastDay, shading: shadeMask.summary(),
    };
}
