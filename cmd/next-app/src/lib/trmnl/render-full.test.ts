import { describe, it, expect } from 'vitest';
import { TrmnlRenderer } from '../trmnl-renderer';
import type { RenderContext } from './types';
import type { TrmnlComponentConfig } from '../trmnl-component-config';
import type { EnergyData } from '../db';

function makeSeries(): EnergyData[] {
    const base = new Date('2026-05-19T07:00:00Z').getTime();
    return Array.from({ length: 6 }, (_, i) => ({
        timestamp: new Date(base + i * 3_600_000),
        site_id: 's1',
        tariff_id: 1,
        load_power: 1000 + i * 100,
        solar_power: 500 * i,
        grid_power: 200 - i * 50,
        battery_power: -100 + i * 20,
        battery_soc: 40 + i * 5,
        tariff_schedule_id: null
    })) as unknown as EnergyData[];
}

function makeCfg(overrides?: Partial<TrmnlComponentConfig>): TrmnlComponentConfig {
    return {
        showLiveGrid: false,
        showLiveSolar: false,
        showLiveBattery: false,
        showEnergyChart: false,
        showBatterySoc: false,
        showEstimatedBill: false,
        showLoadTiming: false,
        batterySocMode: 'glyph',
        ...overrides
    } as TrmnlComponentConfig;
}

function makeCtx(cfg: TrmnlComponentConfig): RenderContext {
    const loadTiming = cfg.showLoadTiming ? {
        hasTariff: true, hasCycleData: true, activeIsCheapest: false,
        periods: [
            { name: 'OFF_PEAK', marginalCost: 0.2, basis: 'buy' as const, cycleNetExportKwh: -12, isActive: true, nextStartPhrase: null },
            { name: 'ON_PEAK', marginalCost: 0.08, basis: 'sell' as const, cycleNetExportKwh: 9, isActive: false, nextStartPhrase: 'today at 4 PM' }
        ],
        nextCheaper: { name: 'ON_PEAK', marginalCost: 0.08, phrase: 'today at 4 PM' },
        nextCheaperPhrase: 'today at 4 PM', nextStartPhraseByKey: {}
    } : undefined;
    return {
        siteName: 'Test Site',
        dateRange: '5/1 - 6/1',
        tariffGroups: [{
            tariffId: 1,
            tariffName: 'TOU-D',
            periods: [
                { touName: 'OFF_PEAK', label: 'Off-Peak', home: 5000, grid: 2000, solar: 8000, battery: -500, cost: 1.23 },
                { touName: 'ON_PEAK', label: 'On-Peak', home: 3000, grid: -1000, solar: 1000, battery: 400, cost: -0.45 }
            ]
        }],
        totalCost: 0.78,
        currency: '$',
        displayCost: '$0.78',
        costLabel: 'Total Cost',
        currentTouName: 'OFF_PEAK',
        batterySoc: 65,
        batteryStatus: 'charging',
        todayHome: 12.3,
        todayGrid: 4.5,
        todaySolar: 9.8,
        seriesData: makeSeries(),
        componentConfig: cfg,
        loadTiming
    };
}

const MATRIX: Array<[string, Partial<TrmnlComponentConfig>]> = [
    ['all-off', {}],
    ['live-only', { showLiveGrid: true, showLiveSolar: true, showLiveBattery: true }],
    ['energy-only', { showEnergyChart: true }],
    ['soc-glyph-only', { showBatterySoc: true, batterySocMode: 'glyph' }],
    ['soc-chart-only', { showBatterySoc: true, batterySocMode: 'chart' }],
    ['bill-only', { showEstimatedBill: true }],
    ['live-energy-bill', { showLiveGrid: true, showEnergyChart: true, showEstimatedBill: true }],
    ['very-dense', {
        showLiveGrid: true, showLiveSolar: true, showLiveBattery: true,
        showEnergyChart: true, showBatterySoc: true, showEstimatedBill: true, batterySocMode: 'glyph'
    }],
    ['load-timing-only', { showLoadTiming: true }],
    ['bill-plus-load-timing', { showEstimatedBill: true, showLoadTiming: true }],
    ['live-chart-load-timing', { showLiveGrid: true, showLiveSolar: true, showLiveBattery: true, showEnergyChart: true, showLoadTiming: true }]
];

describe('renderFull characterization', () => {
    for (const [name, overrides] of MATRIX) {
        it(`snapshot: ${name}`, () => {
            const cfg = makeCfg(overrides);
            expect(TrmnlRenderer.renderFull(makeCtx(cfg))).toMatchSnapshot();
        });
    }

    it('renders energy-chart hour labels in the site timezone', () => {
        const start = Date.UTC(2024, 0, 1, 8, 0, 0);   // LA 2024-01-01 00:00
        const series = Array.from({ length: 24 }, (_, i) => ({
            timestamp: new Date(start + i * 3_600_000),
            site_id: 's1', tariff_id: 1,
            load_power: 1000, solar_power: 200, grid_power: 100, battery_power: -50,
            battery_soc: 50, tariff_schedule_id: null
        })) as unknown as EnergyData[];

        const base = makeCtx(makeCfg({ showEnergyChart: true }));

        const utc = TrmnlRenderer.renderFull({ ...base, seriesData: series, timezone: 'UTC' });
        const la = TrmnlRenderer.renderFull({ ...base, seriesData: series, timezone: 'America/Los_Angeles' });

        expect(la).not.toEqual(utc);
    });
});
