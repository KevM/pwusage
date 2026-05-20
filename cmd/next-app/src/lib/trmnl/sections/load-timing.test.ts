import { describe, it, expect } from 'vitest';
import { loadTimingSection } from './load-timing';
import type { RenderContext } from '../types';
import type { LayoutState } from '../layout-engine';
import type { LoadTimingView } from '../../load-timing';

function layout(overrides?: Partial<LayoutState>): LayoutState {
    return {
        hasLoadTimingSection: true,
        loadTimingMinHeight: 168,
        loadTimingCompactLevel: 0,
        showEstimatedBill: false,
        ...overrides
    } as unknown as LayoutState;
}

function view(overrides?: Partial<LoadTimingView>): LoadTimingView {
    return {
        hasTariff: true,
        hasCycleData: true,
        activeIsCheapest: false,
        periods: [
            { name: 'OFF_PEAK', marginalCost: 0.20, basis: 'buy', cycleNetExportKwh: -12, isActive: true, nextStartPhrase: null },
            { name: 'ON_PEAK', marginalCost: 0.08, basis: 'sell', cycleNetExportKwh: 9, isActive: false, nextStartPhrase: 'today at 4 PM' }
        ],
        nextCheaper: { name: 'ON_PEAK', marginalCost: 0.08, phrase: 'today at 4 PM' },
        nextCheaperPhrase: 'today at 4 PM',
        nextStartPhraseByKey: {},
        ...overrides
    };
}

function ctx(v: LoadTimingView | undefined): RenderContext {
    return { siteName: 'S', dateRange: 'r', tariffGroups: [], totalCost: 0, currency: '$', displayCost: '$0', costLabel: 'C', loadTiming: v } as RenderContext;
}

describe('loadTimingSection', () => {
    it('is disabled when layout has no load-timing section', () => {
        expect(loadTimingSection.isEnabled({ hasLoadTimingSection: false } as unknown as LayoutState)).toBe(false);
    });

    it('is enabled when layout has load-timing section', () => {
        expect(loadTimingSection.isEnabled(layout())).toBe(true);
    });

    it('marks the active period with a prominent ACTIVE NOW badge and bold name, no color', () => {
        const html = loadTimingSection.render(ctx(view()), layout());
        expect(html).toContain('ACTIVE NOW');
        expect(html).toContain('<strong>Off-Peak</strong>');
        expect(html).not.toMatch(/text-(green|red)/);
    });

    it('renders surplus/deficit as words', () => {
        const html = loadTimingSection.render(ctx(view()), layout());
        expect(html).toContain('Surplus');
        expect(html).toContain('Deficit');
    });

    it('renders the next-cheaper banner', () => {
        const html = loadTimingSection.render(ctx(view()), layout());
        expect(html).toContain('Cheaper');
        expect(html).toContain('today at 4 PM');
    });

    it('shows "You are in the Cheapest period" when active is cheapest and no cheaper ahead', () => {
        const html = loadTimingSection.render(
            ctx(view({ nextCheaper: null, nextCheaperPhrase: null, activeIsCheapest: true })),
            layout()
        );
        expect(html).toContain('You are in the Cheapest period');
    });

    it('renders a no-data message when cycle is empty', () => {
        const html = loadTimingSection.render(ctx(view({ hasCycleData: false, periods: [] })), layout());
        expect(html).toContain('No cycle data');
    });

    it('renders a configure-tariff message when no tariff', () => {
        const html = loadTimingSection.render(ctx(view({ hasTariff: false, hasCycleData: false, periods: [] })), layout());
        expect(html).toContain('Configure a tariff');
    });

    it('renders nothing when loadTiming is absent from context', () => {
        expect(loadTimingSection.render(ctx(undefined), layout())).toBe('');
    });
});
