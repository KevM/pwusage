import { describe, expect, it } from 'vitest';
import type { Plane } from './poa';
import { syntheticSeries } from './synthetic';
import { envelopeClear, quantile, toSeries, type Series } from './selection';
import { azimuthRange90, bootstrap, choosePlaneCount, fitPlanes, seededRng } from './fit';

const year = { latitude: 43.4, longitude: -87.9, timeZone: 'America/Chicago', start: '2025-11-01', days: 365, cloudyFraction: 0.5, seed: 7 };

function prepared(planes: Plane[]): { series: Series; selected: boolean[] } {
    const series = toSeries(syntheticSeries({ ...year, planes }), year.latitude, year.longitude, year.timeZone);
    const peak = quantile(series.filter(s => s.sun.elevation > 10).map(s => s.kw), 0.999);
    return { series, selected: envelopeClear(series, peak) };
}

function angleDiff(a: number, b: number): number {
    return Math.abs(((a - b + 540) % 360) - 180);
}

describe('fitPlanes and choosePlaneCount', () => {
    it('recovers an east/west pair', () => {
        const started = Date.now();
        const { series, selected } = prepared([{ azimuth: 90, tilt: 20, effectiveKw: 5 }, { azimuth: 270, tilt: 20, effectiveKw: 4 }]);
        const choice = choosePlaneCount(series, selected, null, seededRng(1));
        expect(choice.count).toBe(2);
        const fit = fitPlanes(series, selected, null, 2);
        const planes = [...fit.planes].sort((a, b) => a.azimuth - b.azimuth);
        expect(angleDiff(planes[0].azimuth, 90)).toBeLessThanOrEqual(15);
        expect(angleDiff(planes[1].azimuth, 270)).toBeLessThanOrEqual(15);
        for (const p of planes) expect(Math.abs(p.tilt - 20)).toBeLessThanOrEqual(6);
        const total = planes.reduce((s, p) => s + p.effectiveKw, 0);
        expect(Math.abs(total - 9) / 9).toBeLessThanOrEqual(0.1);
        console.log(`east/west choosePlaneCount + fitPlanes: ${Date.now() - started} ms`);
    }, 120_000);

    it('recovers a single south face', () => {
        const { series, selected } = prepared([{ azimuth: 180, tilt: 30, effectiveKw: 6 }]);
        expect(choosePlaneCount(series, selected, null, seededRng(1)).count).toBe(1);
        const [plane] = fitPlanes(series, selected, null, 1).planes;
        expect(angleDiff(plane.azimuth, 180)).toBeLessThanOrEqual(5);
        expect(Math.abs(plane.tilt - 30)).toBeLessThanOrEqual(4);
    }, 120_000);

    it('reports a north-ish face across 0°/360° without wrapping to 180°', () => {
        const { series, selected } = prepared([{ azimuth: 355, tilt: 10, effectiveKw: 2 }]);
        const fit = fitPlanes(series, selected, null, 1);
        const az = fit.planes[0].azimuth;
        expect(az >= 340 || az < 10).toBe(true);
        const boots = bootstrap(series, selected, null, fit.planes, 5, seededRng(2));
        expect(boots).toHaveLength(5);
        for (const b of boots) expect(angleDiff(b[0].azimuth, az)).toBeLessThan(40);
    }, 120_000);
});

describe('azimuthRange90', () => {
    it('unwraps around the reference', () => {
        // numpy-style linear percentiles: 350.75 and 369.25 -> 9.25 after mod 360.
        const [lo, hi] = azimuthRange90([350, 355, 5, 10], 355);
        expect(Math.abs(lo - 350)).toBeLessThanOrEqual(1);
        expect(Math.abs(hi - 10)).toBeLessThanOrEqual(1);
        expect(azimuthRange90([170, 180, 190], 180).map(v => Math.round(v))).toEqual([171, 189]);
    });
});

describe('seededRng', () => {
    it('is deterministic', () => {
        const a = seededRng(5), b = seededRng(5);
        expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    });
});
