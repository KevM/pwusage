import { describe, expect, it } from 'vitest';
import { sunAt } from './sun';

// Reference values from pvlib 0.16.1 (SPA solar position, Spencer extraterrestrial,
// Kasten-Young airmass, Ineichen-Perez with Linke turbidity 3.0, altitude 0).
const LAT = 43.39;
const LON = -87.87;
const cases = [
    { t: '2026-06-21T17:30:00Z', zen: 20.520, az: 164.567, dniExtra: 1321.62, ghi: 949.18, dni: 901.95, dhi: 104.45 },
    { t: '2026-12-21T15:00:00Z', zen: 77.274, az: 140.647, dniExtra: 1412.71, ghi: 161.04, dni: 523.93, dhi: 45.62 },
    { t: '2026-03-20T22:00:00Z', zen: 68.770, az: 248.691, dniExtra: 1377.69, ghi: 314.88, dni: 695.21, dhi: 63.13 },
];

function rel(actual: number, expected: number) {
    return Math.abs(actual - expected) / expected;
}

describe('sunAt', () => {
    for (const c of cases) {
        it(`matches pvlib at ${c.t}`, () => {
            const s = sunAt(new Date(c.t), LAT, LON);
            expect(Math.abs(s.apparentZenith - c.zen)).toBeLessThanOrEqual(0.05);
            expect(Math.abs(s.azimuth - c.az)).toBeLessThanOrEqual(0.05);
            expect(s.elevation).toBeCloseTo(90 - s.apparentZenith, 9);
            expect(Math.abs(s.dniExtra - c.dniExtra)).toBeLessThanOrEqual(1);
            expect(rel(s.ghi, c.ghi)).toBeLessThanOrEqual(0.02);
            expect(rel(s.dni, c.dni)).toBeLessThanOrEqual(0.02);
            expect(rel(s.dhi, c.dhi)).toBeLessThanOrEqual(0.02);
        });
    }

    it('is dark at night', () => {
        const s = sunAt(new Date('2026-06-21T07:00:00Z'), LAT, LON);
        expect(s.elevation).toBeLessThan(0);
        expect(s.ghi).toBe(0);
        expect(s.dni).toBe(0);
        expect(s.dhi).toBe(0);
    });
});
