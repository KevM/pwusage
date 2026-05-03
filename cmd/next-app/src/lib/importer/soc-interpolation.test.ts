import { describe, it, expect } from 'vitest';
import { buildSocSamples, findNearestSoc, SocSample } from './soc-interpolation';

describe('findNearestSoc', () => {
    it('returns null for empty samples', () => {
        expect(findNearestSoc([], 1000)).toBeNull();
    });

    it('returns exact match', () => {
        const samples: SocSample[] = [{ timestampMs: 1000, soc: 80 }];
        expect(findNearestSoc(samples, 1000)).toBe(80);
    });

    it('returns nearest sample before target', () => {
        const samples: SocSample[] = [
            { timestampMs: 1000, soc: 70 },
            { timestampMs: 3000, soc: 90 },
        ];
        expect(findNearestSoc(samples, 1500)).toBe(70);
    });

    it('returns nearest sample after target', () => {
        const samples: SocSample[] = [
            { timestampMs: 1000, soc: 70 },
            { timestampMs: 3000, soc: 90 },
        ];
        expect(findNearestSoc(samples, 2600)).toBe(90);
    });

    it('returns null when nearest is beyond default maxGapMs (5 min)', () => {
        const samples: SocSample[] = [{ timestampMs: 0, soc: 50 }];
        const sixMinutesMs = 6 * 60 * 1000;
        expect(findNearestSoc(samples, sixMinutesMs)).toBeNull();
    });

    it('returns value when nearest is within custom maxGapMs', () => {
        const samples: SocSample[] = [{ timestampMs: 0, soc: 50 }];
        const twoMinutesMs = 2 * 60 * 1000;
        expect(findNearestSoc(samples, twoMinutesMs, 3 * 60 * 1000)).toBe(50);
    });

    it('returns null when bestTimestamp is null', () => {
        const samples: SocSample[] = [{ timestampMs: 1000, soc: 50 }];
        expect(findNearestSoc(samples, 1000 + 10 * 60 * 1000)).toBeNull();
    });
});

describe('buildSocSamples', () => {
    it('maps entries to SocSample objects', () => {
        const entries = [{ timestamp: '2026-01-01T00:00:00.000Z', percentage_charged: 80 }];
        const samples = buildSocSamples(entries);
        expect(samples[0].soc).toBe(80);
        expect(samples[0].timestampMs).toBe(new Date('2026-01-01T00:00:00.000Z').getTime());
    });

    it('sorts entries by timestamp ascending', () => {
        const entries = [
            { timestamp: '2026-01-01T00:10:00.000Z', percentage_charged: 90 },
            { timestamp: '2026-01-01T00:00:00.000Z', percentage_charged: 80 },
        ];
        const samples = buildSocSamples(entries);
        expect(samples[0].soc).toBe(80);
        expect(samples[1].soc).toBe(90);
    });

    it('filters out entries with invalid timestamps', () => {
        const entries = [
            { timestamp: 'not-a-date', percentage_charged: 50 },
            { timestamp: '2026-01-01T00:00:00.000Z', percentage_charged: 80 },
        ];
        expect(buildSocSamples(entries)).toHaveLength(1);
    });

    it('deduplicates entries with the same timestamp (last write wins)', () => {
        const entries = [
            { timestamp: '2026-01-01T00:00:00.000Z', percentage_charged: 80 },
            { timestamp: '2026-01-01T00:00:00.000Z', percentage_charged: 85 }, // Same timestamp, different SoC
            { timestamp: '2026-01-01T00:10:00.000Z', percentage_charged: 90 },
        ];
        const samples = buildSocSamples(entries);
        expect(samples).toHaveLength(2);
        expect(samples[0].soc).toBe(85);
        expect(samples[0].timestampMs).toBe(new Date('2026-01-01T00:00:00.000Z').getTime());
        expect(samples[1].soc).toBe(90);
    });
});
