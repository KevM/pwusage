import { describe, it, expect } from 'vitest';
import { buildHourLabelEntries, buildSocSeriesForChart, buildSmoothedSocSeriesForChart } from './charts';
import { SocSample } from '../soc-checkpoints';

describe('Trmnl Charts', () => {
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
});
