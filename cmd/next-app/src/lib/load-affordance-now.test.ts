import { describe, expect, it } from 'vitest';
import { buildLoadAffordanceNow } from './load-affordance-now';
import type { LoadTimingPeriod, LoadTimingView } from './load-timing';

function period(overrides: Partial<LoadTimingPeriod> = {}): LoadTimingPeriod {
    return {
        name: 'OFF_PEAK',
        marginalCost: 0.03,
        basis: 'sell',
        cycleNetExportKwh: 120,
        isActive: true,
        nextStartPhrase: null,
        buyRate: 0.15,
        sellRate: 0.03,
        ...overrides,
    };
}

function view(...pricingPeriods: LoadTimingPeriod[]): LoadTimingView {
    return {
        hasTariff: true,
        hasCycleData: true,
        activeIsCheapest: false,
        periods: pricingPeriods,
        pricingPeriods,
        nextCheaper: null,
        nextCheaperPhrase: null,
        nextStartPhraseByKey: {},
    };
}

describe('buildLoadAffordanceNow', () => {
    it('returns null without load timing', () => {
        expect(buildLoadAffordanceNow(null)).toBeNull();
    });

    it('returns null when no period is active', () => {
        expect(buildLoadAffordanceNow(view(period({ isActive: false })))).toBeNull();
    });

    it('names the biggest load the surplus affords, matching the header glyph', () => {
        const v = buildLoadAffordanceNow(view(period()))!;
        expect(v.glyph).toBe('car');
        expect(v.headline).toBe('Little car');
    });

    it('reports the period and rounded surplus like the header tooltip', () => {
        const v = buildLoadAffordanceNow(view(period({ cycleNetExportKwh: 119.6 })))!;
        expect(v.contextLabel).toBe('Off-Peak · 120 kWh surplus');
    });

    it('warns off large loads when nothing is affordable', () => {
        const v = buildLoadAffordanceNow(view(period({ cycleNetExportKwh: 1 })))!;
        expect(v.glyph).toBeNull();
        expect(v.headline).toBe('Avoid large loads');
    });

    it('says what the next load up still needs', () => {
        const v = buildLoadAffordanceNow(view(period({ cycleNetExportKwh: 120 })))!;
        expect(v.nextUpLabel).toBe('Big car needs 40 kWh more');
    });

    it('names the smallest unaffordable load when nothing is affordable', () => {
        const v = buildLoadAffordanceNow(view(period({ cycleNetExportKwh: 1 })))!;
        expect(v.nextUpLabel).toBe('Dishwasher needs 4 kWh more');
    });

    it('drops the next-up line once the largest load is covered', () => {
        const v = buildLoadAffordanceNow(view(period({ cycleNetExportKwh: 300 })))!;
        expect(v.headline).toBe('Big car');
        expect(v.nextUpLabel).toBeNull();
    });

    it('reads a deficit period as unaffordable rather than as surplus', () => {
        const v = buildLoadAffordanceNow(view(period({ cycleNetExportKwh: -30 })))!;
        expect(v.glyph).toBeNull();
        expect(v.contextLabel).toBe('Off-Peak · 30 kWh short');
    });

    it('picks the active period out of the full pricing set', () => {
        const v = buildLoadAffordanceNow(view(
            period({ name: 'ON_PEAK', isActive: false, cycleNetExportKwh: 300 }),
            period({ name: 'OFF_PEAK', isActive: true, cycleNetExportKwh: 10 }),
        ))!;
        expect(v.contextLabel).toBe('Off-Peak · 10 kWh surplus');
    });
});
