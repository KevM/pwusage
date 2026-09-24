import { describe, expect, it } from 'vitest';
import {
    EGRESS_SENSITIVITY_SCENARIOS,
    estimateMonthlyEgress,
    estimateJsMappedValueRowBytes,
    measuredBundlePollingProfiles,
    parseMeasurementArgs,
} from './mobile-egress';

describe('estimateJsMappedValueRowBytes', () => {
    it('counts UTF-8 lengths for mapped strings, numbers, nulls, and dates', () => {
        const row = {
            label: 'café',
            count: 42,
            missing: null,
            timestamp: new Date('2026-09-23T12:34:56.000Z'),
        };

        expect(estimateJsMappedValueRowBytes(row)).toBe(
            Buffer.byteLength('café', 'utf8') + Buffer.byteLength('42', 'utf8') +
            Buffer.byteLength('2026-09-23T12:34:56.000Z', 'utf8')
        );
    });

    it('counts null values as zero value bytes', () => {
        expect(estimateJsMappedValueRowBytes({ value: null })).toBe(0);
    });
});

describe('estimateMonthlyEgress', () => {
    it('scales query bytes by visible interval, active hours, and phone count', () => {
        const fiveMinute = estimateMonthlyEgress({
            bytesPerPoll: 12_000,
            intervalMinutes: 5,
            activeHoursPerDay: 1,
            phones: 1,
        });
        const thirtyMinute = estimateMonthlyEgress({
            bytesPerPoll: 12_000,
            intervalMinutes: 30,
            activeHoursPerDay: 1,
            phones: 1,
        });

        expect(fiveMinute.requestsPerMonth).toBe(360);
        expect(fiveMinute.bytesPerMonth).toBe(4_320_000);
        expect(thirtyMinute.requestsPerMonth).toBe(60);
        expect(thirtyMinute.bytesPerMonth).toBe(720_000);
    });

    it('scales linearly for 8 and 24 active hours and multiple phones', () => {
        const scenario = estimateMonthlyEgress({
            bytesPerPoll: 1_000,
            intervalMinutes: 5,
            activeHoursPerDay: 8,
            phones: 2,
        });

        expect(scenario.requestsPerMonth).toBe(5_760);
        expect(scenario.bytesPerMonth).toBe(5_760_000);
    });
});

describe('measured bundle polling profiles', () => {
    it('keeps the products, header, detail, and mobile cadences distinct', () => {
        expect(measuredBundlePollingProfiles.map(profile => [profile.name, profile.intervalMinutes])).toEqual([
            ['Products page', 1],
            ['Web header', 5],
            ['Live detail refresh', 30],
            ['iOS visible poll', 5],
            ['iOS visible poll', 30],
        ]);
    });
});

describe('parseMeasurementArgs', () => {
    const now = new Date('2026-09-23T12:00:00.000Z');

    it('rejects a missing site value and a timestamp without an explicit timezone', () => {
        expect(parseMeasurementArgs(['--site', '--at'], now)).toMatchObject({ ok: false });
        expect(parseMeasurementArgs(['--site', 'site-1', '--at'], now)).toMatchObject({ ok: false });
        expect(parseMeasurementArgs(['--site', 'site-1', '--at', '2026-08-27T22:25:00'], now)).toMatchObject({ ok: false });
    });

    it('accepts a timestamp with UTC offset and preserves its instant', () => {
        const result = parseMeasurementArgs(['--site', 'site-1', '--at', '2026-08-27T17:25:00-05:00'], now);

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.siteId).toBe('site-1');
            expect(result.asOf.toISOString()).toBe('2026-08-27T22:25:00.000Z');
            expect(result.historical).toBe(true);
        }
    });
});

describe('egress sensitivity scenarios', () => {
    it('exposes the base proxy and two transparent safety margins', () => {
        expect(EGRESS_SENSITIVITY_SCENARIOS).toEqual([
            { label: 'proxy', multiplier: 1 },
            { label: '+50%', multiplier: 1.5 },
            { label: '+100%', multiplier: 2 },
        ]);
    });
});
