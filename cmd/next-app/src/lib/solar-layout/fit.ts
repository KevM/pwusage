// Plane fitting (reference `build_grid`, `grid_search`, `refine`, `fit_n`,
// `choose_n`, `distinct`, `align`, `unwrap_rel`). The exhaustive azimuth x tilt
// grid is solved linearly through Gram matrices; the best candidates are then
// refined continuously with a robust (soft-L1) Levenberg-Marquardt fit, clipping
// included as a smooth cap. Gram matrices are accumulated per CV fold so the
// cross-validation reuses one pass over the rows.
import { MAX_TILT, poaColumn, softmin, toSunArrays, type Plane, type SunArrays } from './poa';
import { quantile, type Series } from './selection';

export const GRID_AZ = Array.from({ length: 36 }, (_, i) => i * 10);
export const GRID_TILT = Array.from({ length: 11 }, (_, i) => i * 5);
export const COMBOS: [number, number][] = GRID_TILT.flatMap(t => (t > 0 ? GRID_AZ : [180]).map(a => [a, t] as [number, number]));

export function seededRng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Rows used for fitting: geometry, measured kW, day index and a weight (bootstrap counts). */
export type FitRows = { sun: SunArrays; y: Float64Array; day: Int32Array; days: string[]; weight: Float64Array };

export function fitRows(series: Series, selected: boolean[]): FitRows {
    const idx: number[] = [];
    series.forEach((p, i) => { if (selected[i] && Number.isFinite(p.kw)) idx.push(i); });
    const days: string[] = [];
    const dayIndex = new Map<string, number>();
    const day = new Int32Array(idx.length);
    idx.forEach((i, r) => {
        const d = series[i].localDay;
        let k = dayIndex.get(d);
        if (k === undefined) { k = days.length; days.push(d); dayIndex.set(d, k); }
        day[r] = k;
    });
    return {
        sun: toSunArrays(idx.map(i => series[i].sun)),
        y: Float64Array.from(idx.map(i => series[i].kw)),
        day, days, weight: new Float64Array(idx.length).fill(1),
    };
}

export function subsetRows(rows: FitRows, keep: (r: number) => boolean): FitRows {
    const idx: number[] = [];
    for (let r = 0; r < rows.y.length; r++) if (keep(r)) idx.push(r);
    const pick = (a: Float64Array) => Float64Array.from(idx, r => a[r]);
    const s = rows.sun;
    return {
        sun: { n: idx.length, cosZ: pick(s.cosZ), sinZ: pick(s.sinZ), cosSaz: pick(s.cosSaz), sinSaz: pick(s.sinSaz), dni: pick(s.dni), ghi: pick(s.ghi), dhi: pick(s.dhi), anis: pick(s.anis), rbDen: pick(s.rbDen), tfac: pick(s.tfac) },
        y: pick(rows.y), day: Int32Array.from(idx, r => rows.day[r]), days: rows.days, weight: pick(rows.weight),
    };
}

/** Grid columns (poa / 1000 for every combo) for a set of rows, computed once. */
export function gridColumns(rows: FitRows): Float32Array[] {
    const tmp = new Float64Array(rows.y.length);
    return COMBOS.map(([a, t]) => Float32Array.from(poaColumn(rows.sun, a, t, tmp)));
}

export type Gram = { G: Float64Array; b: Float64Array; yy: number };

/**
 * Gram matrices per group (group[r] in 0..groups-1, -1 = excluded): the upper
 * triangle of the sum of outer products of each row's grid values, mirrored.
 * Rows are processed in cache-sized blocks laid out row-major.
 */
export function groupGrams(cols: Float32Array[], y: Float64Array, group: Int8Array, groups: number): Gram[] {
    const m = cols.length;
    const out: Gram[] = Array.from({ length: groups }, () => ({ G: new Float64Array(m * m), b: new Float64Array(m), yy: 0 }));
    const BLOCK = 256;
    const block = new Float64Array(BLOCK * m);
    const rowsIn: number[] = [];
    const flush = (g: number) => {
        const { G, b } = out[g];
        for (let k = 0; k < rowsIn.length; k++) {
            const off = k * m;
            const yr = y[rowsIn[k]];
            out[g].yy += yr * yr;
            for (let i = 0; i < m; i++) {
                const ai = block[off + i];
                if (ai === 0) continue;
                b[i] += ai * yr;
                const gi = i * m;
                for (let j = i; j < m; j++) G[gi + j] += ai * block[off + j];
            }
        }
        rowsIn.length = 0;
    };
    for (let g = 0; g < groups; g++) {
        for (let r = 0; r < y.length; r++) {
            if (group[r] !== g) continue;
            const off = rowsIn.length * m;
            for (let i = 0; i < m; i++) block[off + i] = cols[i][r];
            rowsIn.push(r);
            if (rowsIn.length === BLOCK) flush(g);
        }
        flush(g);
        const G = out[g].G;
        for (let i = 0; i < m; i++) for (let j = i + 1; j < m; j++) G[j * m + i] = G[i * m + j];
    }
    return out;
}

export function sumGrams(grams: Gram[], skip = -1): Gram {
    const m = grams[0].b.length;
    const out: Gram = { G: new Float64Array(m * m), b: new Float64Array(m), yy: 0 };
    grams.forEach((g, k) => {
        if (k === skip) return;
        for (let i = 0; i < m * m; i++) out.G[i] += g.G[i];
        for (let i = 0; i < m; i++) out.b[i] += g.b[i];
        out.yy += g.yy;
    });
    return out;
}

type Candidate = { sse: number; idx: number[]; k: number[] };

function solve3(a: number[], rhs: number[]): number[] | null {
    const [a00, a01, a02, a10, a11, a12, a20, a21, a22] = a;
    const det = a00 * (a11 * a22 - a12 * a21) - a01 * (a10 * a22 - a12 * a20) + a02 * (a10 * a21 - a11 * a20);
    if (!Number.isFinite(det) || det === 0) return null;
    const [b0, b1, b2] = rhs;
    return [
        (b0 * (a11 * a22 - a12 * a21) - a01 * (b1 * a22 - a12 * b2) + a02 * (b1 * a21 - a11 * b2)) / det,
        (a00 * (b1 * a22 - a12 * b2) - b0 * (a10 * a22 - a12 * a20) + a02 * (a10 * b2 - b1 * a20)) / det,
        (a00 * (a11 * b2 - b1 * a21) - a01 * (a10 * b2 - b1 * a20) + b0 * (a10 * a21 - a11 * a20)) / det,
    ];
}

/** Best grid candidates for 1-3 planes with non-negative linear sizes (reference `grid_search`). */
export function gridSearch(gram: Gram, planes: 1 | 2 | 3, top = 20): Candidate[] {
    const { G, b, yy } = gram;
    const m = b.length;
    const d = (i: number) => G[i * m + i];
    if (planes === 1) {
        const c: Candidate[] = [];
        for (let i = 0; i < m; i++) {
            const k = Math.max(d(i) > 0 ? b[i] / d(i) : 0, 0);
            c.push({ sse: yy - 2 * k * b[i] + k * k * d(i), idx: [i], k: [k] });
        }
        return c.sort((x, y) => x.sse - y.sse).slice(0, top);
    }
    const pairs: Candidate[] = [];
    for (let i = 0; i < m; i++) {
        for (let j = i + 1; j < m; j++) {
            const gii = d(i), gjj = d(j), gij = G[i * m + j];
            const det = gii * gjj - gij * gij;
            const ki = (gjj * b[i] - gij * b[j]) / det;
            const kj = (gii * b[j] - gij * b[i]) / det;
            const sse = yy - 2 * (ki * b[i] + kj * b[j]) + ki * ki * gii + 2 * ki * kj * gij + kj * kj * gjj;
            if (ki < 0 || kj < 0 || !Number.isFinite(sse) || det < 1e-9 * gii * gjj) continue;
            pairs.push({ sse, idx: [i, j], k: [ki, kj] });
        }
    }
    pairs.sort((x, y) => x.sse - y.sse);
    if (planes === 2) return pairs.slice(0, top);
    // Three planes: extend the best 60 pairs with every third column.
    const res: Candidate[] = [];
    for (const p of pairs.slice(0, 60)) {
        const [i, j] = p.idx;
        let best: Candidate | null = null;
        for (let l = 0; l < m; l++) {
            if (l === i || l === j) continue;
            const ids = [i, j, l];
            const a = ids.flatMap(r => ids.map(c => G[r * m + c] + (r === c ? 1e-12 : 0)));
            const rhs = ids.map(r => b[r]);
            const k = solve3(a, rhs);
            if (!k || k.some(v => v < 0)) continue;
            let quad = 0;
            for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) quad += k[r] * a[r * 3 + c] * k[c];
            const sse = yy - 2 * (k[0] * rhs[0] + k[1] * rhs[1] + k[2] * rhs[2]) + quad;
            if (Number.isFinite(sse) && (!best || sse < best.sse)) best = { sse, idx: ids, k };
        }
        if (best) {
            const order = [0, 1, 2].sort((x, y) => best!.idx[x] - best!.idx[y]);
            res.push({ sse: best.sse, idx: order.map(o => best!.idx[o]), k: order.map(o => best!.k[o]) });
        }
    }
    res.sort((x, y) => x.sse - y.sse);
    const seen = new Set<string>();
    return res.filter(r => { const key = r.idx.join(','); if (seen.has(key)) return false; seen.add(key); return true; }).slice(0, top);
}

/** Model kW for packed params [az, tilt, k, ...] over the rows. */
export function modelRows(params: ArrayLike<number>, rows: FitRows, clipKw: number | null): Float64Array {
    const n = rows.y.length;
    const tot = new Float64Array(n);
    const col = new Float64Array(n);
    for (let p = 0; p < params.length; p += 3) {
        poaColumn(rows.sun, ((params[p] % 360) + 360) % 360, params[p + 1], col, true);
        const k = params[p + 2];
        for (let r = 0; r < n; r++) tot[r] += k * col[r];
    }
    if (clipKw) for (let r = 0; r < n; r++) tot[r] = clipKw * softmin(tot[r] / clipKw);
    return tot;
}

function solveLinear(a: Float64Array, b: Float64Array, n: number): Float64Array | null {
    const m = Float64Array.from(a);
    const x = Float64Array.from(b);
    for (let c = 0; c < n; c++) {
        let piv = c;
        for (let r = c + 1; r < n; r++) if (Math.abs(m[r * n + c]) > Math.abs(m[piv * n + c])) piv = r;
        if (Math.abs(m[piv * n + c]) < 1e-300) return null;
        if (piv !== c) {
            for (let k = 0; k < n; k++) { const t = m[c * n + k]; m[c * n + k] = m[piv * n + k]; m[piv * n + k] = t; }
            const t = x[c]; x[c] = x[piv]; x[piv] = t;
        }
        for (let r = c + 1; r < n; r++) {
            const f = m[r * n + c] / m[c * n + c];
            if (f === 0) continue;
            for (let k = c; k < n; k++) m[r * n + k] -= f * m[c * n + k];
            x[r] -= f * x[c];
        }
    }
    for (let c = n - 1; c >= 0; c--) {
        let s = x[c];
        for (let k = c + 1; k < n; k++) s -= m[c * n + k] * x[k];
        x[c] = s / m[c * n + c];
    }
    return x;
}

const F_SCALE = 0.08;
const H_AZ = 0.5;
const H_TILT = 0.25;

/**
 * Robust continuous refinement (reference `refine`: soft-L1, f_scale 0.08,
 * bounds az ±720, tilt 0-50, k 0-50). Levenberg-Marquardt on iteratively
 * reweighted residuals; sizes have analytic derivatives, angles finite ones.
 */
export function refine(params0: ArrayLike<number>, rows: FitRows, clipKw: number | null, maxNfev = 200): number[] {
    const np = params0.length;
    const planes = np / 3;
    const n = rows.y.length;
    const p = Array.from(params0);
    for (let i = 1; i < np; i += 3) p[i] = Math.min(Math.max(p[i], 0.5), MAX_TILT - 0.5);
    if (n === 0) return p.map((v, i) => (i % 3 === 0 ? ((v % 360) + 360) % 360 : v));
    let ymax = 1e-3;
    for (let r = 0; r < n; r++) if (rows.y[r] > ymax) ymax = rows.y[r];
    const lo = [-720, 0, 0];
    const hi = [720, MAX_TILT, 50];
    const clamp = (v: number, i: number) => Math.min(Math.max(v, lo[i % 3]), hi[i % 3]);

    const cols = Array.from({ length: planes }, () => new Float64Array(n));
    const evaluate = (q: number[], into: Float64Array[]) => {
        const tot = new Float64Array(n);
        for (let k = 0; k < planes; k++) {
            poaColumn(rows.sun, ((q[3 * k] % 360) + 360) % 360, q[3 * k + 1], into[k], true);
            const size = q[3 * k + 2];
            const c = into[k];
            for (let r = 0; r < n; r++) tot[r] += size * c[r];
        }
        return tot;
    };
    const cost = (tot: Float64Array) => {
        let s = 0;
        for (let r = 0; r < n; r++) {
            const m = clipKw ? clipKw * softmin(tot[r] / clipKw) : tot[r];
            const z = ((m - rows.y[r]) / ymax / F_SCALE) ** 2;
            s += rows.weight[r] * 2 * (Math.sqrt(1 + z) - 1);
        }
        return 0.5 * F_SCALE * F_SCALE * s;
    };

    let tot = evaluate(p, cols);
    let c0 = cost(tot);
    let nfev = 1;
    let lambda = 1e-3;
    const fd = new Float64Array(n);
    const J = Array.from({ length: np }, () => new Float64Array(n));
    while (nfev < maxNfev) {
        // Residuals, IRLS weights and the Jacobian at p.
        const res = new Float64Array(n);
        const w = new Float64Array(n);
        const dsoft = new Float64Array(n);
        for (let r = 0; r < n; r++) {
            let m = tot[r];
            let ds = 1;
            if (clipKw) {
                const x = tot[r] / clipKw;
                m = clipKw * softmin(x);
                ds = 1 / (1 + Math.exp(-(1 - x) / 0.01));
            }
            res[r] = (m - rows.y[r]) / ymax;
            dsoft[r] = ds / ymax;
            w[r] = rows.weight[r] / Math.sqrt(1 + (res[r] / F_SCALE) ** 2);
        }
        for (let k = 0; k < planes; k++) {
            const az = p[3 * k], tilt = p[3 * k + 1], size = p[3 * k + 2];
            const c = cols[k];
            const jk = J[3 * k + 2];
            for (let r = 0; r < n; r++) jk[r] = c[r] * dsoft[r];
            poaColumn(rows.sun, (((az + H_AZ) % 360) + 360) % 360, tilt, fd, true);
            const ja = J[3 * k];
            for (let r = 0; r < n; r++) ja[r] = size * (fd[r] - c[r]) / H_AZ * dsoft[r];
            const ht = tilt + H_TILT > MAX_TILT ? -H_TILT : H_TILT;
            poaColumn(rows.sun, ((az % 360) + 360) % 360, tilt + ht, fd, true);
            const jt = J[3 * k + 1];
            for (let r = 0; r < n; r++) jt[r] = size * (fd[r] - c[r]) / ht * dsoft[r];
        }
        const H = new Float64Array(np * np);
        const g = new Float64Array(np);
        for (let a = 0; a < np; a++) {
            const ja = J[a];
            let ga = 0;
            for (let r = 0; r < n; r++) ga += ja[r] * w[r] * res[r];
            g[a] = ga;
            for (let b = a; b < np; b++) {
                const jb = J[b];
                let s = 0;
                for (let r = 0; r < n; r++) s += ja[r] * w[r] * jb[r];
                H[a * np + b] = s;
                H[b * np + a] = s;
            }
        }
        let accepted = false;
        let converged = false;
        while (nfev < maxNfev) {
            const A = Float64Array.from(H);
            for (let a = 0; a < np; a++) A[a * np + a] += lambda * Math.max(H[a * np + a], 1e-12);
            const step = solveLinear(A, g.map(v => -v), np);
            if (!step) { lambda *= 10; if (lambda > 1e12) { converged = true; break; } continue; }
            const q = p.map((v, i) => clamp(v + step[i], i));
            const trialCols = Array.from({ length: planes }, () => new Float64Array(n));
            const trialTot = evaluate(q, trialCols);
            nfev++;
            const c1 = cost(trialTot);
            if (c1 < c0) {
                const rel = (c0 - c1) / Math.max(c0, 1e-300);
                const moved = q.reduce((s, v, i) => Math.max(s, Math.abs(v - p[i]) / (i % 3 === 2 ? 1 : 10)), 0);
                for (let i = 0; i < np; i++) p[i] = q[i];
                for (let k = 0; k < planes; k++) cols[k].set(trialCols[k]);
                tot = trialTot;
                c0 = c1;
                lambda = Math.max(lambda / 3, 1e-9);
                accepted = true;
                if (rel < 1e-8 || moved < 1e-6) converged = true;
                break;
            }
            lambda *= 4;
            if (lambda > 1e12) { converged = true; break; }
        }
        if (!accepted || converged) break;
    }
    return p.map((v, i) => (i % 3 === 0 ? ((v % 360) + 360) % 360 : v));
}

export function rmse(model: Float64Array, y: Float64Array): number {
    let s = 0;
    for (let r = 0; r < y.length; r++) s += (model[r] - y[r]) ** 2;
    return Math.sqrt(s / Math.max(y.length, 1));
}

export function toPlanes(params: ArrayLike<number>): Plane[] {
    const out: Plane[] = [];
    for (let i = 0; i < params.length; i += 3) out.push({ azimuth: ((params[i] % 360) + 360) % 360, tilt: params[i + 1], effectiveKw: params[i + 2] });
    return out;
}

export function packPlanes(planes: Plane[]): number[] {
    return planes.flatMap(p => [p.azimuth, p.tilt, p.effectiveKw]);
}

/** Refine the best `starts` grid candidates and keep the lowest RMSE (reference `fit_n`). */
export function fitFromGram(rows: FitRows, gram: Gram, clipKw: number | null, planes: 1 | 2 | 3, starts: number): { params: number[]; rmseKw: number; candidates: Candidate[] } {
    const cands = gridSearch(gram, planes);
    let best: { params: number[]; rmseKw: number } | null = null;
    for (const c of cands.slice(0, starts)) {
        const p0 = c.idx.flatMap((ii, j) => [COMBOS[ii][0], COMBOS[ii][1], c.k[j]]);
        const p = refine(p0, rows, clipKw);
        const rm = rmse(modelRows(p, rows, clipKw), rows.y);
        if (!best || rm < best.rmseKw) best = { params: p, rmseKw: rm };
    }
    if (!best) {
        // No feasible candidate (e.g. no rows): a zero-size plane.
        best = { params: Array.from({ length: planes }, (_, i) => [180 + 90 * i, 20, 0]).flat(), rmseKw: rmse(new Float64Array(rows.y.length), rows.y) };
    }
    return { ...best, candidates: cands };
}

/** Grid-search mask: rows below 97% of the clip (reference `fitmask`). */
export function fitMaskGroup(rows: FitRows, clipKw: number | null, groupOf: (r: number) => number): Int8Array {
    const g = new Int8Array(rows.y.length);
    for (let r = 0; r < rows.y.length; r++) g[r] = clipKw && !(rows.y[r] < 0.97 * clipKw) ? -1 : groupOf(r);
    return g;
}

export function fitPlanes(series: Series, selected: boolean[], clipKw: number | null, planeCount: 1 | 2 | 3, opts?: { starts?: number }): { planes: Plane[]; rmseKw: number; candidates: Plane[][] } {
    const rows = fitRows(series, selected);
    const cols = gridColumns(rows);
    const [gram] = groupGrams(cols, rows.y, fitMaskGroup(rows, clipKw, () => 0), 1);
    const fit = fitFromGram(rows, gram, clipKw, planeCount, opts?.starts ?? (planeCount > 1 ? 4 : 3));
    return {
        planes: toPlanes(fit.params),
        rmseKw: fit.rmseKw,
        candidates: fit.candidates.map(c => c.idx.map((ii, j) => ({ azimuth: COMBOS[ii][0], tilt: COMBOS[ii][1], effectiveKw: c.k[j] }))),
    };
}

export function angleDiff(a: number, b: number): number {
    return Math.abs(((a - b + 180) % 360 + 360) % 360 - 180);
}

/** Planes too similar to be told apart (reference `distinct`: within 25° azimuth and 10° tilt). */
export function distinct(planes: Plane[]): boolean {
    for (let i = 0; i < planes.length; i++) {
        for (let j = i + 1; j < planes.length; j++) {
            if (angleDiff(planes[i].azimuth, planes[j].azimuth) < 25 && Math.abs(planes[i].tilt - planes[j].tilt) < 10) return false;
        }
    }
    return true;
}

/** Reference `choose_n`: add a plane only for a > 8% held-out gain and a plausible, distinct, sizeable plane. */
export function choosePlaneCountFrom(fits: Record<1 | 2 | 3, Plane[]>, cv: Record<1 | 2 | 3, number>): 1 | 2 | 3 {
    let n: 1 | 2 | 3 = 1;
    for (const m of [2, 3] as const) {
        const gain = (cv[n] - cv[m]) / cv[n];
        const planes = fits[m];
        const total = planes.reduce((s, p) => s + p.effectiveKw, 0);
        const artefact = planes.some(p => p.tilt >= MAX_TILT - 2 && p.effectiveKw < 0.25 * total);
        const minK = Math.min(...planes.map(p => p.effectiveKw));
        if (gain > 0.08 && minK > 0.08 * total && distinct(planes) && !artefact) n = m;
        else break;
    }
    return n;
}

/** Folds by day: a seeded permutation of the days, mod 5 (reference). */
export function dayFolds(dayCount: number, rng: () => number): Int8Array {
    const perm = Array.from({ length: dayCount }, (_, i) => i);
    for (let i = dayCount - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [perm[i], perm[j]] = [perm[j], perm[i]];
    }
    const folds = new Int8Array(dayCount);
    perm.forEach((p, i) => { folds[i] = p % 5; });
    return folds;
}

export type PlaneCountResult = { count: 1 | 2 | 3; cvNrmse: Record<1 | 2 | 3, number>; fits: Record<1 | 2 | 3, { params: number[]; rmseKw: number; candidates: Candidate[] }> };

/** Fits for 1-3 planes on all rows plus 5-fold day-blocked CV, from one pass of fold Grams. */
export function planeCountFromRows(rows: FitRows, cols: Float32Array[], clipKw: number | null, rng: () => number, checkDeadline: () => void = () => {}): PlaneCountResult {
    const folds = dayFolds(rows.days.length, rng);
    const grams = groupGrams(cols, rows.y, fitMaskGroup(rows, clipKw, r => folds[rows.day[r]]), 5);
    checkDeadline();
    const all = sumGrams(grams);
    const fits = {} as PlaneCountResult['fits'];
    for (const n of [1, 2, 3] as const) {
        fits[n] = fitFromGram(rows, all, clipKw, n, n > 1 ? 4 : 3);
        checkDeadline();
    }
    const acc: Record<1 | 2 | 3, [number, number, number]> = { 1: [0, 0, 0], 2: [0, 0, 0], 3: [0, 0, 0] };
    for (let f = 0; f < 5; f++) {
        const isTest = (r: number) => folds[rows.day[r]] === f;
        let testCount = 0;
        for (let r = 0; r < rows.y.length; r++) if (isTest(r)) testCount++;
        if (testCount < 50) continue;
        const train = subsetRows(rows, r => !isTest(r));
        const test = subsetRows(rows, isTest);
        const trainGram = sumGrams(grams, f);
        for (const n of [1, 2, 3] as const) {
            const fit = fitFromGram(train, trainGram, clipKw, n, 2);
            const pred = modelRows(fit.params, test, clipKw);
            let sse = 0, sy = 0;
            for (let r = 0; r < test.y.length; r++) { sse += (pred[r] - test.y[r]) ** 2; sy += test.y[r]; }
            acc[n][0] += sse; acc[n][1] += test.y.length; acc[n][2] += sy;
        }
        checkDeadline();
    }
    const cvNrmse = {} as Record<1 | 2 | 3, number>;
    for (const n of [1, 2, 3] as const) {
        const [sse, count, sy] = acc[n];
        cvNrmse[n] = Math.sqrt(sse / count) / (sy / count);
    }
    const count = choosePlaneCountFrom({ 1: toPlanes(fits[1].params), 2: toPlanes(fits[2].params), 3: toPlanes(fits[3].params) }, cvNrmse);
    return { count, cvNrmse, fits };
}

export function choosePlaneCount(series: Series, selected: boolean[], clipKw: number | null, rng: () => number): { count: 1 | 2 | 3; cvNrmse: Record<1 | 2 | 3, number> } {
    const rows = fitRows(series, selected);
    const { count, cvNrmse } = planeCountFromRows(rows, gridColumns(rows), clipKw, rng);
    return { count, cvNrmse };
}

/** Reorder bootstrap planes to match `best` by azimuth/tilt distance (reference `align`). */
export function align(boot: Plane[], best: Plane[]): Plane[] {
    if (best.length === 1) return boot;
    const perms = best.length === 2 ? [[0, 1], [1, 0]] : [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
    const d = (i: number, j: number) => angleDiff(boot[i].azimuth, best[j].azimuth) + 2 * Math.abs(boot[i].tilt - best[j].tilt);
    let bestPerm = perms[0];
    let bestCost = Infinity;
    for (const perm of perms) {
        const c = perm.reduce((s, pi, j) => s + d(pi, j), 0);
        if (c < bestCost) { bestCost = c; bestPerm = perm; }
    }
    return bestPerm.map(i => boot[i]);
}

/** Day bootstrap: resample days with replacement (as row weights) and refine from `best`. */
export function bootstrapRows(rows: FitRows, clipKw: number | null, best: Plane[], rounds: number, rng: () => number, checkDeadline: () => void = () => {}): Plane[][] {
    const nDays = rows.days.length;
    const out: Plane[][] = [];
    for (let b = 0; b < rounds; b++) {
        const counts = new Float64Array(nDays);
        for (let i = 0; i < nDays; i++) counts[Math.floor(rng() * nDays)]++;
        const weighted: FitRows = { ...rows, weight: Float64Array.from(rows.day, d => counts[d]) };
        const sub = subsetRows(weighted, r => weighted.weight[r] > 0);
        out.push(align(toPlanes(refine(packPlanes(best), sub, clipKw, 80)), best));
        checkDeadline();
    }
    return out;
}

export function bootstrap(series: Series, selected: boolean[], clipKw: number | null, best: Plane[], rounds: number, rng: () => number): Plane[][] {
    return bootstrapRows(fitRows(series, selected), clipKw, best, rounds, rng);
}

/** 5th/95th percentile azimuth after unwrapping around `reference`, mod 360. */
export function azimuthRange90(samples: number[], reference: number): [number, number] {
    const unwrapped = samples.map(a => reference + ((((a - reference + 180) % 360) + 360) % 360) - 180);
    const lo = quantile(unwrapped, 0.05);
    const hi = quantile(unwrapped, 0.95);
    return [((lo % 360) + 360) % 360, ((hi % 360) + 360) % 360];
}
