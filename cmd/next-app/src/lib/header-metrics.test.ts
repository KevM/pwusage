import { describe, expect, it } from 'vitest';
import { buildHeaderMetricsModel } from './header-metrics';
import type { SiteLiveData } from './site-live-data-client';

describe('buildHeaderMetricsModel', () => {
    const defaultStats: SiteLiveData = {
        solarPower: 0,
        loadPower: 0,
        batteryPower: 0,
        gridPower: 0,
        percentageCharged: 50,
    };

    describe('Power formatting', () => {
        it('formats solar power as absolute kW with one decimal place', () => {
            const stats = { ...defaultStats, solarPower: 1900 };
            const model = buildHeaderMetricsModel(stats);
            expect(model.solarFormatted).toBe('1.9');
        });

        it('formats negative solar power as absolute positive kW', () => {
            const stats = { ...defaultStats, solarPower: -1200 };
            const model = buildHeaderMetricsModel(stats);
            expect(model.solarFormatted).toBe('1.2');
        });

        it('formats grid power as absolute kW with one decimal place', () => {
            const stats = { ...defaultStats, gridPower: -1500 };
            const model = buildHeaderMetricsModel(stats);
            expect(model.gridFormatted).toBe('1.5');
        });

        it('formats load power as absolute kW with one decimal place', () => {
            const stats = { ...defaultStats, loadPower: 2100 };
            const model = buildHeaderMetricsModel(stats);
            expect(model.loadFormatted).toBe('2.1');
        });
    });

    describe('Grid direction thresholds', () => {
        it('identifies import when gridPower is above threshold (100W)', () => {
            const stats = { ...defaultStats, gridPower: 150 };
            const model = buildHeaderMetricsModel(stats);
            expect(model.gridDirection).toBe('import');
        });

        it('identifies export when gridPower is below negative threshold (-100W)', () => {
            const stats = { ...defaultStats, gridPower: -150 };
            const model = buildHeaderMetricsModel(stats);
            expect(model.gridDirection).toBe('export');
        });

        it('identifies none when gridPower is within threshold boundaries', () => {
            expect(buildHeaderMetricsModel({ ...defaultStats, gridPower: 100 }).gridDirection).toBe('none');
            expect(buildHeaderMetricsModel({ ...defaultStats, gridPower: 0 }).gridDirection).toBe('none');
            expect(buildHeaderMetricsModel({ ...defaultStats, gridPower: -100 }).gridDirection).toBe('none');
        });
    });

    describe('Battery percentage and activity', () => {
        it('passes through percentageCharged correctly', () => {
            const stats = { ...defaultStats, percentageCharged: 82.4 };
            const model = buildHeaderMetricsModel(stats);
            expect(model.batteryPercentage).toBe(82.4);
        });

        it('determines battery activity correctly using getBatteryActivity logic', () => {
            expect(buildHeaderMetricsModel({ ...defaultStats, batteryPower: -250 }).batteryActivity).toBe('charging');
            expect(buildHeaderMetricsModel({ ...defaultStats, batteryPower: 250 }).batteryActivity).toBe('discharging');
            expect(buildHeaderMetricsModel({ ...defaultStats, batteryPower: 50 }).batteryActivity).toBe('idle');
        });
    });
});
