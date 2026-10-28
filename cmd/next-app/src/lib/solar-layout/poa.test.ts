import { describe, expect, it } from 'vitest';
import { sunAt } from './sun';
import { diffuseIam, modelKw, physicalIam, poaComponents } from './poa';
import { syntheticSeries } from './synthetic';

const LAT = 43.39;
const LON = -87.87;

describe('poaComponents (Hay-Davies, albedo 0.2)', () => {
    const cases = [
        { t: '2026-06-21T17:30:00Z', total: 1011.69 },
        { t: '2026-12-21T15:00:00Z', total: 308.14 },
        { t: '2026-03-20T22:00:00Z', total: 389.47 },
    ];
    for (const c of cases) {
        it(`matches pvlib total POA at ${c.t} for 180°/20°`, () => {
            const p = poaComponents(sunAt(new Date(c.t), LAT, LON), 180, 20);
            const total = p.direct + p.skyDiffuse + p.groundDiffuse;
            expect(Math.abs(total - c.total) / c.total).toBeLessThanOrEqual(0.02);
        });
    }
});

describe('physicalIam', () => {
    it('matches pvlib physical IAM', () => {
        expect(physicalIam(0)).toBeCloseTo(1.0, 3);
        expect(physicalIam(45)).toBeCloseTo(0.988, 3);
        expect(physicalIam(60)).toBeCloseTo(0.946, 3);
        expect(Math.abs(physicalIam(80) - 0.6341)).toBeLessThanOrEqual(0.001);
        expect(physicalIam(90)).toBeLessThan(1e-9);
    });

    it('matches pvlib marion_diffuse physical at tilt 20', () => {
        expect(diffuseIam(20).sky).toBeCloseTo(0.953918, 5);
        expect(diffuseIam(20).ground).toBeCloseTo(0.638714, 5);
    });
});

describe('modelKw', () => {
    it('caps smoothly at the clip limit', () => {
        const sun = sunAt(new Date('2026-06-21T17:30:00Z'), LAT, LON);
        const unclipped = modelKw(sun, [{ azimuth: 180, tilt: 30, effectiveKw: 10 }], null);
        expect(unclipped).toBeGreaterThan(8);
        const clipped = modelKw(sun, [{ azimuth: 180, tilt: 30, effectiveKw: 10 }], 5);
        expect(clipped).toBeLessThanOrEqual(5.05);
        expect(clipped).toBeGreaterThan(4.9);
    });

    it('is zero at night', () => {
        const sun = sunAt(new Date('2026-06-21T07:00:00Z'), LAT, LON);
        expect(modelKw(sun, [{ azimuth: 180, tilt: 30, effectiveKw: 10 }], null)).toBe(0);
    });
});

describe('syntheticSeries', () => {
    const opts = {
        latitude: 35, longitude: -118, timeZone: 'America/Los_Angeles', start: '2026-05-01', days: 5,
        planes: [{ azimuth: 180, tilt: 25, effectiveKw: 6 }], cloudyFraction: 0.4, seed: 1,
    };

    it('is deterministic for a seed', () => {
        expect(syntheticSeries(opts)).toEqual(syntheticSeries(opts));
        expect(syntheticSeries({ ...opts, seed: 2 })).not.toEqual(syntheticSeries(opts));
    });

    it('has 288 five-minute samples per normal local day in Wh', () => {
        const s = syntheticSeries(opts);
        expect(s).toHaveLength(5 * 288);
        expect(s[0].timestamp.toISOString()).toBe('2026-05-01T07:00:00.000Z');
        expect(s[1].timestamp.getTime() - s[0].timestamp.getTime()).toBe(300_000);
        const peakWh = Math.max(...s.map(x => x.solarWh));
        expect(peakWh).toBeGreaterThan(300);
        expect(peakWh).toBeLessThan(600);
    });
});
