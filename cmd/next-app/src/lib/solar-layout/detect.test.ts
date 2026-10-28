import { beforeAll, describe, expect, it } from 'vitest';
import { syntheticSeries } from './synthetic';
import { DetectionDeadlineError, detectSolarLayout, longitudeOffset } from './detect';

const loc = { latitude: 43.4, longitude: -87.9, timeZone: 'America/Chicago' };
const eastWest = [{ azimuth: 90, tilt: 20, effectiveKw: 5 }, { azimuth: 270, tilt: 20, effectiveKw: 4 }];

describe('detectSolarLayout', () => {
    let year: { timestamp: Date; solarWh: number }[];
    beforeAll(() => {
        year = syntheticSeries({ ...loc, start: '2025-11-01', days: 365, planes: eastWest, cloudyFraction: 0.5, seed: 7 });
    });

    it('needs six weeks of history', () => {
        const samples = syntheticSeries({ ...loc, start: '2026-05-01', days: 30, planes: eastWest, cloudyFraction: 0.3, seed: 3 });
        const r = detectSolarLayout({ samples, ...loc });
        expect(r.status).toBe('not-enough-history');
        expect(r.planes).toEqual([]);
        expect(r.confidence).toBeNull();
    });

    it('treats a year of zeros (dead inverter, PTO gap) as not enough history', () => {
        const r = detectSolarLayout({ samples: year.map(s => ({ timestamp: s.timestamp, solarWh: 0 })), ...loc });
        expect(r.status).toBe('not-enough-history');
        expect(r.planes).toEqual([]);
    });

    it('detects an east/west year with high confidence', () => {
        const r = detectSolarLayout({ samples: year, ...loc });
        expect(r.status).toBe('detected');
        expect(r.confidence).toBe('high');
        expect(r.planes).toHaveLength(2);
        const azimuths = r.planes.map(p => p.azimuth).sort((a, b) => a - b);
        expect(Math.abs(azimuths[0] - 90)).toBeLessThanOrEqual(15);
        expect(Math.abs(azimuths[1] - 270)).toBeLessThanOrEqual(15);
        for (const p of r.planes) {
            expect(p.dcKwp).toBeCloseTo(p.effectiveKw / 0.85, 1);
            expect(p.azimuthRange90).toHaveLength(2);
        }
        expect(r.historyDays).toBeGreaterThanOrEqual(360);
        expect(r.clearDays).toBeGreaterThanOrEqual(40);
        expect(r.firstDay).toBe('2025-11-01');
        expect(r.lastDay).toBe('2026-10-31');
        expect(r.acClipKw).toBeNull();
    }, 120_000);

    it('flags a location five degrees of longitude off', () => {
        const r = detectSolarLayout({ samples: year, ...loc, longitude: loc.longitude + 5 });
        expect(r.status).toBe('low-confidence');
        expect(r.confidence).toBe('low');
        expect(r.reasons).toContain('location-mismatch');
    }, 120_000);

    it('reports low confidence under heavy shade and short cloudy history', () => {
        const samples = syntheticSeries({
            ...loc, start: '2026-06-01', days: 100, planes: [{ azimuth: 180, tilt: 30, effectiveKw: 6 }], cloudyFraction: 0.8, seed: 11,
            shade: [{ azimuthFrom: 0, azimuthTo: 360, belowElevation: 35 }],
        });
        const r = detectSolarLayout({ samples, ...loc });
        expect(r.status).toBe('low-confidence');
        expect(r.confidence).toBe('low');
    }, 120_000);

    it('throws when the deadline has passed', () => {
        expect(() => detectSolarLayout({ samples: year, ...loc, deadline: Date.now() - 1 })).toThrow(DetectionDeadlineError);
    });
});

describe('longitudeOffset', () => {
    // A symmetric clear day: production rises at 06:00 and falls at 18:00 (minutes as ms).
    const t = Array.from({ length: 289 }, (_, i) => i * 300_000);
    const day = (shiftMin: number) => t.map(x => Math.max(0, Math.sin(Math.PI * (x / 60_000 - 360 - shiftMin) / 720)));

    it('converts a later production day into degrees west', () => {
        const offset = longitudeOffset([{ t, measured: day(12), model: day(0) }]);
        expect(offset).toBeCloseTo(3, 1);
    });

    it('returns null without usable days', () => {
        expect(longitudeOffset([])).toBeNull();
    });
});
