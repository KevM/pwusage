import { describe, expect, it } from 'vitest';

import {
    DEFAULT_TRMNL_COMPONENT_CONFIG,
    extractTrmnlComponentConfig,
    normalizeTrmnlComponentConfig
} from './trmnl-component-config';

describe('TRMNL component config defaults', () => {
    // Load timing is intentionally opt-in: existing installations that predate
    // the feature must not silently start rendering it, and new installations
    // get a clean default without it. Users enable it from /trmnl/manage.
    it('defaults showLoadTiming to false', () => {
        expect(DEFAULT_TRMNL_COMPONENT_CONFIG.showLoadTiming).toBe(false);
    });

    it('falls back to showLoadTiming=false when the key is missing from stored config', () => {
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

        expect(normalizeTrmnlComponentConfig(legacyStored).showLoadTiming).toBe(false);
        expect(extractTrmnlComponentConfig(legacyStored).showLoadTiming).toBe(false);
    });

    it('preserves an explicit showLoadTiming=true that the user opted into', () => {
        const optedIn = { ...DEFAULT_TRMNL_COMPONENT_CONFIG, showLoadTiming: true };
        expect(normalizeTrmnlComponentConfig(optedIn).showLoadTiming).toBe(true);
    });
});
