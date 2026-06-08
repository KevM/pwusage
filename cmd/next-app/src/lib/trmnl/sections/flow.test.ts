import { describe, it, expect } from 'vitest';
import { flowSection } from './flow';
import type { RenderContext } from '../types';
import type { LayoutState } from '../layout-engine';

function makeLayout(overrides?: Partial<LayoutState>): LayoutState {
    return { hasFlowSection: true, flowMinHeight: 300, ...overrides } as unknown as LayoutState;
}

function makeCtx(overrides?: Partial<RenderContext>): RenderContext {
    return {
        siteName: 'Test Site',
        dateRange: '5/1 - 6/1',
        tariffGroups: [],
        totalCost: 0,
        currency: '$',
        displayCost: '$0.00',
        costLabel: 'Total Cost',
        flowSvg: '<svg id="flow"></svg>',
        ...overrides
    };
}

describe('flowSection', () => {
    it('has the showEnergyFlow config key', () => {
        expect(flowSection.id).toBe('flow');
        expect(flowSection.configKey).toBe('showEnergyFlow');
    });

    it('is enabled when the layout flags a flow section', () => {
        expect(flowSection.isEnabled(makeLayout())).toBe(true);
        expect(flowSection.isEnabled({ hasFlowSection: false } as unknown as LayoutState)).toBe(false);
    });

    it('renders the pre-rendered svg inside a height-bounded wrapper', () => {
        const html = flowSection.render(makeCtx(), makeLayout());
        expect(html).toContain('<svg id="flow"></svg>');
        expect(html).toContain('height: 300px');
    });

    it('no-ops when flowSvg is absent', () => {
        const html = flowSection.render(makeCtx({ flowSvg: undefined }), makeLayout());
        expect(html).toBe('');
    });
});
