import { describe, expect, it } from 'vitest';

import {
    DEFAULT_TRMNL_COMPONENT_CONFIG,
    normalizeTrmnlComponentConfig,
    buildDefaultTrmnlComponentScreens
} from './trmnl-component-config';

describe('TRMNL component config defaults', () => {
    it('defaults to match Harrison site Screen 1 configuration', () => {
        expect(DEFAULT_TRMNL_COMPONENT_CONFIG.showBatterySoc).toBe(true);
        expect(DEFAULT_TRMNL_COMPONENT_CONFIG.showEstimatedBill).toBe(false);
        expect(DEFAULT_TRMNL_COMPONENT_CONFIG.showLoadTiming).toBe(false);
        expect(DEFAULT_TRMNL_COMPONENT_CONFIG.showLiveGrid).toBe(true);
        expect(DEFAULT_TRMNL_COMPONENT_CONFIG.showLiveSolar).toBe(true);
        expect(DEFAULT_TRMNL_COMPONENT_CONFIG.showLiveBattery).toBe(true);
        expect(DEFAULT_TRMNL_COMPONENT_CONFIG.showEnergyChart).toBe(true);
        expect(DEFAULT_TRMNL_COMPONENT_CONFIG.batterySocMode).toBe('chart');
    });

    it('builds two default screens matching Harrison site configurations', () => {
        const defaultScreens = buildDefaultTrmnlComponentScreens();
        expect(defaultScreens).toHaveLength(2);

        expect(defaultScreens[0]).toEqual({
            id: 'screen-1',
            name: 'Screen 1',
            componentConfig: {
                showLiveGrid: true,
                showLiveSolar: true,
                showLiveBattery: true,
                showEnergyChart: true,
                showBatterySoc: true,
                showEstimatedBill: false,
                showLoadTiming: false,
                showEnergyFlow: false,
                flowBasis: 'cumulative',
                batterySocMode: 'chart'
            }
        });

        expect(defaultScreens[1]).toEqual({
            id: 'screen-2',
            name: 'Screen 2',
            componentConfig: {
                showLiveGrid: true,
                showLiveSolar: true,
                showLiveBattery: true,
                showEnergyChart: false,
                showBatterySoc: false,
                showEstimatedBill: true,
                showLoadTiming: true,
                showEnergyFlow: false,
                flowBasis: 'cumulative',
                batterySocMode: 'chart'
            }
        });
    });

    it('defaults showEnergyFlow off and flowBasis to cumulative', () => {
        expect(DEFAULT_TRMNL_COMPONENT_CONFIG.showEnergyFlow).toBe(false);
        expect(DEFAULT_TRMNL_COMPONENT_CONFIG.flowBasis).toBe('cumulative');
    });

    it('reads showEnergyFlow / flowBasis from snake_case aliases', () => {
        const stored = { show_energy_flow: true, flow_basis: 'snapshot' };
        const cfg = normalizeTrmnlComponentConfig(stored);
        expect(cfg.showEnergyFlow).toBe(true);
        expect(cfg.flowBasis).toBe('snapshot');
    });

    it('falls back to default flowBasis (cumulative) for an invalid value', () => {
        const stored = { ...DEFAULT_TRMNL_COMPONENT_CONFIG, flowBasis: 'bogus' };
        expect(normalizeTrmnlComponentConfig(stored).flowBasis).toBe('cumulative');
    });

    it('falls back to default showEnergyFlow (false) when missing from stored config', () => {
        const legacyStored = { ...DEFAULT_TRMNL_COMPONENT_CONFIG } as Record<string, unknown>;
        delete legacyStored.showEnergyFlow;
        delete legacyStored.flowBasis;
        const cfg = normalizeTrmnlComponentConfig(legacyStored);
        expect(cfg.showEnergyFlow).toBe(false);
        expect(cfg.flowBasis).toBe('cumulative');
    });

    it('falls back to default showLoadTiming (false) when the key is missing from stored config', () => {
        const legacyStored = {
            showLiveGrid: true,
            showLiveSolar: true,
            showLiveBattery: true,
            showEnergyChart: true,
            showBatterySoc: true,
            showEstimatedBill: true,
            batterySocMode: 'chart'
            // no showLoadTiming — simulates installations saved before the field existed
        };

        expect(normalizeTrmnlComponentConfig(legacyStored).showLoadTiming).toBe(false);
    });

    it('preserves an explicit showLoadTiming=true that the user opted into', () => {
        const optedIn = { ...DEFAULT_TRMNL_COMPONENT_CONFIG, showLoadTiming: true };
        expect(normalizeTrmnlComponentConfig(optedIn).showLoadTiming).toBe(true);
    });
});
