import { describe, it, expect } from 'vitest';
import {
    buildHourLabelEntries,
    buildHourTicks,
    renderBatterySocGlyphStrip,
    buildSocSeriesForChart,
    buildSmoothedSocSeriesForChart
} from './charts';
import { SocSample } from '../soc-checkpoints';

describe('Trmnl Charts', () => {
    describe('buildHourTicks', () => {
        it('anchors hour ticks to the site-local day, not the process timezone', () => {
            // Realistic chart window: a full site-local day in Los Angeles.
            // LA is UTC-8 in January, so LA-local midnight 2024-01-01 == 08:00 UTC.
            const startTime = Date.UTC(2024, 0, 1, 8, 0, 0);   // LA 2024-01-01 00:00
            const endTime = Date.UTC(2024, 0, 2, 7, 55, 0);    // LA 2024-01-01 23:55

            const byLabel = Object.fromEntries(
                buildHourTicks(startTime, endTime, 'America/Los_Angeles').map((t) => [t.label, t.epochMs])
            );

            // 12am sits at LA midnight (08:00 UTC), NOT process/UTC midnight (00:00 UTC).
            expect(byLabel['12am']).toBe(Date.UTC(2024, 0, 1, 8, 0, 0));
            expect(byLabel['6am']).toBe(Date.UTC(2024, 0, 1, 14, 0, 0));
            expect(byLabel['12pm']).toBe(Date.UTC(2024, 0, 1, 20, 0, 0));
            expect(byLabel['6pm']).toBe(Date.UTC(2024, 0, 2, 2, 0, 0));
        });

        it('handles the DST spring-forward day without drift (America/Los_Angeles)', () => {
            // LA springs forward 2024-03-10 02:00 -> 03:00 (UTC-8 -> UTC-7).
            const startTime = Date.UTC(2024, 2, 10, 8, 0, 0);   // LA 2024-03-10 00:00 (PST)
            const endTime = Date.UTC(2024, 2, 11, 6, 55, 0);    // LA 2024-03-10 23:55 (PDT)

            const byLabel = Object.fromEntries(
                buildHourTicks(startTime, endTime, 'America/Los_Angeles').map((t) => [t.label, t.epochMs])
            );

            expect(byLabel['12am']).toBe(Date.UTC(2024, 2, 10, 8, 0, 0));   // PST
            expect(byLabel['6am']).toBe(Date.UTC(2024, 2, 10, 13, 0, 0));   // PDT (not 14:00)
            expect(byLabel['12pm']).toBe(Date.UTC(2024, 2, 10, 19, 0, 0));  // PDT
            expect(byLabel['6pm']).toBe(Date.UTC(2024, 2, 11, 1, 0, 0));    // PDT
        });

        it('defaults to UTC when no timezone is given', () => {
            const startTime = Date.UTC(2024, 0, 1, 0, 0, 0);
            const endTime = Date.UTC(2024, 0, 1, 23, 55, 0);
            const byLabel = Object.fromEntries(
                buildHourTicks(startTime, endTime).map((t) => [t.label, t.epochMs])
            );
            expect(byLabel['12am']).toBe(Date.UTC(2024, 0, 1, 0, 0, 0));
            expect(byLabel['12pm']).toBe(Date.UTC(2024, 0, 1, 12, 0, 0));
        });
    });

    describe('buildHourLabelEntries', () => {
        it('returns labels at 6-hour intervals within the time range', () => {
            const startTime = new Date('2024-01-01T00:00:00').getTime();
            const endTime = new Date('2024-01-01T23:55:00').getTime();
            const getX = (ts: number) => (ts - startTime) / (endTime - startTime) * 760;

            const entries = buildHourLabelEntries(startTime, endTime, getX);
            const labels = entries.map(e => e.label);
            expect(labels).toContain('12am');
            expect(labels).toContain('6am');
            expect(labels).toContain('12pm');
            expect(labels).toContain('6pm');
        });

        it('injects midnight label when it would be missing from a partial day', () => {
            // Simulate a day starting at 2am — midnight wouldn't naturally appear
            const startTime = new Date('2024-01-01T02:00:00').getTime();
            const endTime = new Date('2024-01-01T08:00:00').getTime();
            const getX = (ts: number) => (ts - startTime) / (endTime - startTime) * 760;

            const entries = buildHourLabelEntries(startTime, endTime, getX, 32);
            const labels = entries.map(e => e.label);
            expect(labels).toContain('12am');
        });

        it('places the 12am label at the site-local midnight position', () => {
            const startTime = Date.UTC(2024, 0, 1, 8, 0, 0);   // LA 2024-01-01 00:00
            const endTime = Date.UTC(2024, 0, 2, 7, 55, 0);    // LA 2024-01-01 23:55
            const getX = (ts: number) => (ts - startTime) / (endTime - startTime) * 760;

            const midnight = buildHourLabelEntries(startTime, endTime, getX, 0, 'America/Los_Angeles')
                .find((e) => e.label === '12am');
            expect(midnight).toBeDefined();
            expect(midnight!.x).toBeCloseTo(0, 5);   // chart starts at LA local midnight
        });
    });

    describe('buildSocSeriesForChart', () => {
        it('returns known samples when more than one is provided', () => {
            const samples: SocSample[] = [
                { timestamp: 100, soc: 50 },
                { timestamp: 200, soc: 60 }
            ];
            const result = buildSocSeriesForChart(samples, null, 0, 300);
            expect(result).toEqual(samples);
        });

        it('extends a single sample to fill the time range', () => {
            const samples: SocSample[] = [{ timestamp: 150, soc: 75 }];
            const result = buildSocSeriesForChart(samples, null, 0, 300);
            expect(result).toHaveLength(2);
            expect(result[0].soc).toBe(75);
            expect(result[1].soc).toBe(75);
        });

        it('falls back to latestBatterySoc when no samples exist', () => {
            const result = buildSocSeriesForChart([], 42, 0, 300);
            expect(result).toHaveLength(2);
            expect(result[0].soc).toBe(42);
        });

        it('returns empty array when no data and no fallback', () => {
            const result = buildSocSeriesForChart([], null, 0, 300);
            expect(result).toEqual([]);
        });
    });

    describe('buildSmoothedSocSeriesForChart', () => {
        it('returns an array of SocSample objects', () => {
            const data = [
                { timestamp: new Date('2024-01-01T00:00:00'), battery_soc: 80, load_power: 0, solar_power: 0, grid_power: 0, battery_power: 0 },
                { timestamp: new Date('2024-01-01T01:00:00'), battery_soc: 70, load_power: 0, solar_power: 0, grid_power: 0, battery_power: 0 },
                { timestamp: new Date('2024-01-01T02:00:00'), battery_soc: 60, load_power: 0, solar_power: 0, grid_power: 0, battery_power: 0 }
            ];
            const start = data[0].timestamp.getTime();
            const end = data[2].timestamp.getTime();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const result = buildSmoothedSocSeriesForChart(data as any[], null, start, end);
            expect(result.length).toBeGreaterThanOrEqual(2);
            result.forEach(point => {
                expect(typeof point.timestamp).toBe('number');
                expect(typeof point.soc).toBe('number');
            });
        });

        it('returns empty array when data has no SoC and no fallback', () => {
            const data = [
                { timestamp: new Date('2024-01-01T00:00:00'), battery_soc: null, load_power: 0, solar_power: 0, grid_power: 0, battery_power: 0 }
            ];
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const result = buildSmoothedSocSeriesForChart(data as any[], null, 0, 100);
            expect(result).toEqual([]);
        });
    });

    describe('renderBatterySocGlyphStrip timezone', () => {
        it('positions hour labels using the site timezone', () => {
            const start = Date.UTC(2024, 0, 1, 8, 0, 0);   // LA 2024-01-01 00:00
            const data = Array.from({ length: 24 }, (_, i) => ({
                timestamp: new Date(start + i * 3_600_000),
                site_id: 's1', tariff_id: 1,
                load_power: 100, solar_power: 0, grid_power: 0, battery_power: 0,
                battery_soc: 50, tariff_schedule_id: null
            }));
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const utc = renderBatterySocGlyphStrip(data as any[], 50, { showXAxis: true, timeZone: 'UTC' });
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const la = renderBatterySocGlyphStrip(data as any[], 50, { showXAxis: true, timeZone: 'America/Los_Angeles' });
            expect(la).not.toEqual(utc);
        });
    });
});
