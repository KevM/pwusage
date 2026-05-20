import { describe, expect, it } from 'vitest';

import {
    DEFAULT_TRMNL_COMPONENT_CONFIG,
    extractTrmnlComponentConfig,
    normalizeTrmnlComponentConfig
} from './trmnl-component-config';

describe('TRMNL component config defaults', () => {
    it('defaults to match Harrison site configuration', () => {
        expect(DEFAULT_TRMNL_COMPONENT_CONFIG.showBatterySoc).toBe(false);
        expect(DEFAULT_TRMNL_COMPONENT_CONFIG.showEstimatedBill).toBe(false);
        expect(DEFAULT_TRMNL_COMPONENT_CONFIG.showLoadTiming).toBe(true);
        expect(DEFAULT_TRMNL_COMPONENT_CONFIG.showLiveGrid).toBe(true);
        expect(DEFAULT_TRMNL_COMPONENT_CONFIG.showLiveSolar).toBe(true);
        expect(DEFAULT_TRMNL_COMPONENT_CONFIG.showLiveBattery).toBe(true);
        expect(DEFAULT_TRMNL_COMPONENT_CONFIG.showEnergyChart).toBe(true);
        expect(DEFAULT_TRMNL_COMPONENT_CONFIG.batterySocMode).toBe('glyph');
    });

    it('falls back to default showLoadTiming (true) when the key is missing from stored config', () => {
        const legacyStored = {
            showLiveGrid: true,
            showLiveSolar: true,
            showLiveBattery: true,
            showEnergyChart: true,
            showBatterySoc: true,
            showEstimatedBill: true,
            batterySocMode: 'glyph'
            // no showLoadTiming — simulates installations saved before the field existed
        };

        expect(normalizeTrmnlComponentConfig(legacyStored).showLoadTiming).toBe(true);
        expect(extractTrmnlComponentConfig(legacyStored).showLoadTiming).toBe(true);
    });

    it('preserves an explicit showLoadTiming=false that the user opted out of', () => {
        const optedOut = { ...DEFAULT_TRMNL_COMPONENT_CONFIG, showLoadTiming: false };
        expect(normalizeTrmnlComponentConfig(optedOut).showLoadTiming).toBe(false);
    });
});
