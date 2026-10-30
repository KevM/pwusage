// Writes stage-by-stage JSON fixtures from the TypeScript solar layout detector
// for the Swift port's parity tests (cmd/ios-app/PWUsageTests/Fixtures/SolarLayout).
// Inputs are seeded synthetic series (test-only, see src/lib/solar-layout/synthetic.ts),
// so the output is byte-identical across runs.
//
//   npx tsx scripts/solar-layout-fixtures.ts --out ../ios-app/PWUsageTests/Fixtures/SolarLayout
//
// Stage values come from the exported helpers. detectSolarLayout is monolithic, so
// the pipeline prefix (clear selection, shade learning, final rows, plane count) is
// replicated here in the same order (same RNG draws), and the final result is
// produced by detectSolarLayout itself. The asserts below catch any drift.
import { Buffer } from 'node:buffer';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { MIN_HISTORY_DAYS, detectSolarLayout, type SolarLayoutResult } from '../src/lib/solar-layout/detect';
import { modelKw, type Plane } from '../src/lib/solar-layout/poa';
import {
    fitFromGram, fitMaskGroup, fitRows, gridColumns, groupGrams, modelRows, planeCountFromRows,
    seededRng, subsetRows, toPlanes,
} from '../src/lib/solar-layout/fit';
import {
    detectClip, envelopeClear, flatRuns, learnShade, quantile, smoothness, toSeries, type Series, type ShadeMask, type ShadeSegment,
} from '../src/lib/solar-layout/selection';
import { type SunSample } from '../src/lib/solar-layout/sun';
import { syntheticSeries } from '../src/lib/solar-layout/synthetic';

const STEP_MS = 300_000;
const SLOTS = 48;
const LOCATION = { latitude: 43.4, longitude: -87.9, timeZone: 'America/Chicago' };
const POA_PLANES: Plane[] = [{ azimuth: 90, tilt: 20, effectiveKw: 5 }, { azimuth: 270, tilt: 20, effectiveKw: 4 }];
const EAST_WEST = [{ azimuth: 90, tilt: 20, effectiveKw: 5 }, { azimuth: 270, tilt: 20, effectiveKw: 4 }];

type Samples = { timestamp: Date; solarWh: number }[];

type Fit = { planeCount: 1 | 2 | 3; cvNrmse: Record<'1' | '2' | '3', number>; bestPlanes: Plane[] } | null;

export type SolarLayoutFixture = {
    name: string;
    input: { latitude: number; longitude: number; timeZone: string; start: string; stepMinutes: 5; solarWh: string };
    stages: {
        sun: { timestamp: string; apparentZenith: number; elevation: number; azimuth: number; dniExtra: number; ghi: number; dni: number; dhi: number; ambientFactor: number }[];
        poa: { planes: Plane[]; kw: number[] };
        selection: { producingDays: number; clearDays: number; selectedRows: number; clipKw: number | null; shading: ShadeSegment[] };
        fit: Fit;
    };
    result: SolarLayoutResult;
};

function arg(name: string): string | undefined {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
}

function encodeSolarWh(samples: Samples): string {
    const buf = Buffer.alloc(samples.length * 4);
    samples.forEach((s, i) => buf.writeFloatLE(s.solarWh, i * 4));
    return buf.toString('base64');
}

/** Decodes the Float32 payload back onto the sample grid, so the detector sees exactly what Swift will decode. */
function decodeSolarWh(b64: string, start: number): Samples {
    const buf = Buffer.from(b64, 'base64');
    const out: Samples = [];
    for (let i = 0; i < buf.length / 4; i++) out.push({ timestamp: new Date(start + i * STEP_MS), solarWh: buf.readFloatLE(i * 4) });
    return out;
}

function assertRegularGrid(samples: Samples): number {
    const start = samples[0].timestamp.getTime();
    samples.forEach((s, i) => {
        if (s.timestamp.getTime() !== start + i * STEP_MS) throw new Error(`sample ${i} is off the 5-minute grid`);
    });
    return start;
}

function assertFinite(value: unknown, where: string): void {
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new Error(`non-finite number at ${where}`);
    } else if (Array.isArray(value)) {
        value.forEach((v, i) => assertFinite(v, `${where}[${i}]`));
    } else if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) assertFinite(v, `${where}.${k}`);
    }
}

/** Daylight rows from the series, evenly spaced across the whole input. */
function sunRows(series: Series): { timestamp: Date; sun: SunSample }[] {
    const daylight = series.filter(p => p.sun.elevation > 0).map(p => ({ timestamp: new Date(p.time.getTime() + STEP_MS / 2), sun: p.sun }));
    if (daylight.length < SLOTS) throw new Error('not enough daylight slots');
    return Array.from({ length: SLOTS }, (_, k) => daylight[Math.round(k * (daylight.length - 1) / (SLOTS - 1))]);
}

/** Replicates the detectSolarLayout prefix, reporting each stage's values. */
function selectionAndFit(samples: Samples): { producingDays: number; selection: SolarLayoutFixture['stages']['selection']; fit: Fit; series: Series } {
    const series = toSeries(samples, LOCATION.latitude, LOCATION.longitude, LOCATION.timeZone);
    const producing = new Set<string>();
    for (const p of series) if (p.kw > 0) producing.add(p.localDay);
    const producingDays = producing.size;
    const selection: SolarLayoutFixture['stages']['selection'] = { producingDays, clearDays: 0, selectedRows: 0, clipKw: null, shading: [] };
    if (producingDays < MIN_HISTORY_DAYS) return { producingDays, selection, fit: null, series };

    const peak = quantile(series.filter(p => p.sun.elevation > 10).map(p => p.kw), 0.999);
    if (!(peak > 0)) return { producingDays, selection, fit: null, series };
    const clip = detectClip(series);
    const clipKw = clip?.limitKw ?? null;
    selection.clipKw = clipKw;

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
    if (rowsC.y.length < 200) return { producingDays, selection, fit: null, series };
    const colsC = gridColumns(rowsC);

    const fitTwo = (keep: boolean[]) => {
        const [gram] = groupGrams(colsC, rowsC.y, fitMaskGroup(rowsC, clipKw, r => (keep[r] ? 0 : -1)), 1);
        const sub = subsetRows(rowsC, r => keep[r]);
        return fitFromGram(sub, gram, clipKw, 2, 3).params;
    };

    const nC = rowsC.y.length;
    const saz = Float64Array.from(clearIdx, i => series[i].sun.azimuth);
    const sel = Float64Array.from(clearIdx, i => series[i].sun.elevation);
    const dayIds = clearIdx.map(i => series[i].localDay);
    let keep: boolean[] = new Array(nC).fill(true);
    let pars = fitTwo(keep);
    let shade: ShadeMask | null = null;
    for (let it = 0; it < 2; it++) {
        const m = modelRows(pars, rowsC, clipKw);
        const ratio = Float64Array.from(m, (v, r) => (v > 0.02 * peak ? rowsC.y[r] / v : NaN));
        shade = learnShade(saz, sel, ratio, dayIds);
        const flat = flatRuns(rowsC.y, m, clipKw);
        const mask = shade;
        keep = Array.from({ length: nC }, (_, r) => Math.abs(rowsC.y[r] - m[r]) < 0.15 * peak && !flat[r] && !mask.shaded(saz[r], sel[r]));
        pars = fitTwo(keep);
    }
    const shadeMask = shade!;

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
    const rows = subsetRows(rowsC, r => finalKeep[r]);
    selection.clearDays = clearDays.size;
    selection.shading = shadeMask.summary();
    selection.selectedRows = rows.y.length;
    if (rows.y.length < 200 || rows.days.length < 5) return { producingDays, selection, fit: null, series };

    const keptIdx: number[] = [];
    finalKeep.forEach((k, r) => { if (k) keptIdx.push(r); });
    const cols = colsC.map(c => Float32Array.from(keptIdx, r => c[r]));
    const pc = planeCountFromRows(rows, cols, clipKw, seededRng(0));
    const fit: Fit = { planeCount: pc.count, cvNrmse: pc.cvNrmse, bestPlanes: toPlanes(pc.fits[pc.count].params) };
    return { producingDays, selection, fit, series };
}

function buildFixture(name: string, rawSamples: Samples): SolarLayoutFixture {
    // Round-trip through Float32 first: the detector and the fixture see the same values.
    const start = assertRegularGrid(rawSamples);
    const solarWh = encodeSolarWh(rawSamples);
    const samples = decodeSolarWh(solarWh, start);
    const { selection, fit, series } = selectionAndFit(samples);
    const result = detectSolarLayout({ samples, ...LOCATION });

    if (result.historyDays !== selection.producingDays) throw new Error(`${name}: historyDays drifted from the stage replay`);
    if (result.clearDays !== selection.clearDays) throw new Error(`${name}: clearDays drifted from the stage replay`);
    if (fit && result.planes.length !== fit.planeCount) throw new Error(`${name}: plane count drifted from the stage replay`);
    if (result.acClipKw !== null && result.acClipKw !== selection.clipKw) throw new Error(`${name}: clip drifted from the stage replay`);

    const sun = sunRows(series);
    const kw = sun.map(s => modelKw(s.sun, POA_PLANES, null));
    const fixture: SolarLayoutFixture = {
        name,
        input: { ...LOCATION, start: samples[0].timestamp.toISOString(), stepMinutes: 5, solarWh },
        stages: {
            sun: sun.map(({ timestamp, sun: s }) => ({
                timestamp: timestamp.toISOString(), apparentZenith: s.apparentZenith, elevation: s.elevation, azimuth: s.azimuth,
                dniExtra: s.dniExtra, ghi: s.ghi, dni: s.dni, dhi: s.dhi, ambientFactor: s.tfac,
            })),
            poa: { planes: POA_PLANES.map(p => ({ ...p })), kw },
            selection,
            fit,
        },
        result,
    };
    assertFinite(fixture, name);
    return fixture;
}

const CASES: { name: string; build: () => Samples }[] = [
    {
        name: 'east-west-year',
        build: () => syntheticSeries({ ...LOCATION, start: '2025-11-01', days: 365, planes: EAST_WEST, cloudyFraction: 0.5, seed: 7 }),
    },
    {
        name: 'south-shaded-100d',
        build: () => syntheticSeries({
            ...LOCATION, start: '2026-06-01', days: 100, planes: [{ azimuth: 180, tilt: 30, effectiveKw: 6 }], cloudyFraction: 0.8, seed: 11,
            shade: [{ azimuthFrom: 0, azimuthTo: 360, belowElevation: 35 }],
        }),
    },
    {
        name: 'east-west-30d',
        build: () => syntheticSeries({ ...LOCATION, start: '2026-05-01', days: 30, planes: EAST_WEST, cloudyFraction: 0.3, seed: 3 }),
    },
    {
        // Single south plane whose DC size (6 kW effective) exceeds the 4.5 kW AC limit.
        name: 'south-clipped-year',
        build: () => syntheticSeries({
            ...LOCATION, start: '2025-11-01', days: 365, planes: [{ azimuth: 180, tilt: 30, effectiveKw: 6 }], clipKw: 4.5, cloudyFraction: 0.5, seed: 5,
        }),
    },
];

function main(): void {
    const out = arg('out');
    if (!out) {
        console.error('Usage: npx tsx scripts/solar-layout-fixtures.ts --out <folder>');
        process.exit(1);
    }
    mkdirSync(out, { recursive: true });
    for (const c of CASES) {
        const fixture = buildFixture(c.name, c.build());
        const file = path.join(out, `${c.name}.json`);
        writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`);
        console.log(`${c.name}: ${fixture.result.status} ${fixture.result.confidence ?? '-'} planes=${fixture.result.planes.length} fit=${fixture.stages.fit ? fixture.stages.fit.planeCount : 'null'}`);
    }
}

main();
