import { describe, expect, it } from 'vitest';
import type { EnergyData } from '@/lib/db';
import {
    DEFAULT_SPARKLINE_SCALE_WINDOW_HOURS,
    SPARKLINE_DISPLAY_WINDOW_HOURS,
    parseScaleWindowHours,
    toSparklinePayload,
} from './sparkline-utils';

function makeRow(timestamp: string, values: {
    solarWh: number;
    gridWh: number;
    loadWh: number;
}): EnergyData {
    return {
        id: 1,
        timestamp: new Date(timestamp),
        site_id: 'site-1',
        tariff_id: 1,
        load_power: values.loadWh,
        solar_power: values.solarWh,
        grid_power: values.gridWh,
        battery_power: 0,
        battery_soc: null,
    };
}

describe('parseScaleWindowHours', () => {
    it('uses default when env value is missing', () => {
        expect(parseScaleWindowHours(undefined)).toBe(DEFAULT_SPARKLINE_SCALE_WINDOW_HOURS);
    });

    it('uses default when env value is invalid', () => {
        expect(parseScaleWindowHours('abc')).toBe(DEFAULT_SPARKLINE_SCALE_WINDOW_HOURS);
        expect(parseScaleWindowHours('0')).toBe(DEFAULT_SPARKLINE_SCALE_WINDOW_HOURS);
        expect(parseScaleWindowHours('-2')).toBe(DEFAULT_SPARKLINE_SCALE_WINDOW_HOURS);
    });

    it('clamps configured window to at least display window', () => {
        expect(parseScaleWindowHours('1')).toBe(SPARKLINE_DISPLAY_WINDOW_HOURS);
        expect(parseScaleWindowHours('4')).toBe(SPARKLINE_DISPLAY_WINDOW_HOURS);
        expect(parseScaleWindowHours('18')).toBe(18);
    });
});

describe('toSparklinePayload', () => {
    it('uses full history for scale and display window for returned series', () => {
        const rows: EnergyData[] = [
            makeRow('2026-02-27T00:00:00.000Z', { solarWh: 0, gridWh: -10, loadWh: 25 }),
            makeRow('2026-02-27T08:00:00.000Z', { solarWh: 10, gridWh: -5, loadWh: 20 }),
            makeRow('2026-02-27T09:30:00.000Z', { solarWh: 20, gridWh: 5, loadWh: 30 }),
            makeRow('2026-02-27T11:45:00.000Z', { solarWh: 40, gridWh: 3, loadWh: 35 }),
        ];
        const liveTimestamp = new Date('2026-02-27T12:00:00.000Z');
        const displayStart = new Date('2026-02-27T08:00:00.000Z');

        const payload = toSparklinePayload(rows, liveTimestamp, {
            solar: 999,
            grid: -50,
            load: 600,
        }, displayStart);

        expect(payload.series.solar).toHaveLength(4);
        expect(payload.series.solar[0].timestamp).toBe('2026-02-27T08:00:00.000Z');
        expect(payload.series.solar.at(-1)).toEqual({
            timestamp: '2026-02-27T12:00:00.000Z',
            watts: 999,
        });

        expect(payload.scales.solar).toEqual({ minWatts: 0, maxWatts: 999 });
        expect(payload.scales.grid).toEqual({ minWatts: -120, maxWatts: 60 });
        expect(payload.scales.load).toEqual({ minWatts: 240, maxWatts: 600 });
    });

    it('replaces the last history point when it matches live timestamp', () => {
        const rows: EnergyData[] = [
            makeRow('2026-02-27T10:00:00.000Z', { solarWh: 10, gridWh: 0, loadWh: 15 }),
            makeRow('2026-02-27T12:00:00.000Z', { solarWh: 20, gridWh: 0, loadWh: 15 }),
        ];
        const liveTimestamp = new Date('2026-02-27T12:00:00.000Z');
        const displayStart = new Date('2026-02-27T09:00:00.000Z');

        const payload = toSparklinePayload(rows, liveTimestamp, {
            solar: 777,
            grid: 10,
            load: 20,
        }, displayStart);

        expect(payload.series.solar).toHaveLength(2);
        expect(payload.series.solar.at(-1)).toEqual({
            timestamp: '2026-02-27T12:00:00.000Z',
            watts: 777,
        });
        expect(payload.scales.solar.maxWatts).toBe(777);
    });
});
