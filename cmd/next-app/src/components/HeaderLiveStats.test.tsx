import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HeaderMetricsStrip } from './HeaderLiveStats';
import type { HeaderMetricsModel } from '@/lib/header-metrics';

describe('HeaderMetricsStrip Component', () => {
    const mockModel: HeaderMetricsModel = {
        solarFormatted: '1.9',
        gridFormatted: '0.5',
        loadFormatted: '2.1',
        gridDirection: 'none',
        batteryPercentage: 78.5,
        batteryActivity: 'idle',
    };

    const defaultProps = {
        model: mockModel,
        solarSparkline: [],
        gridSparkline: [],
        loadSparkline: [],
        isExpanded: false,
    };

    it('renders the formatted values for Solar, Grid, and Load', () => {
        const html = renderToStaticMarkup(<HeaderMetricsStrip {...defaultProps} />);
        expect(html).toContain('1.9'); // Solar value
        expect(html).toContain('0.5'); // Grid value
        expect(html).toContain('2.1'); // Load value
        expect(html).toContain('kW'); // Shared unit
    });

    it('renders battery percentage text and glyph', () => {
        const html = renderToStaticMarkup(<HeaderMetricsStrip {...defaultProps} />);
        expect(html).toContain('79%'); // Rounds 78.5% -> 79%
    });

    it('renders grid direction import arrow with correct accessibility properties', () => {
        const props = {
            ...defaultProps,
            model: {
                ...mockModel,
                gridDirection: 'import' as const,
            },
        };
        const html = renderToStaticMarkup(<HeaderMetricsStrip {...props} />);
        expect(html).toContain('aria-label="Grid Import"');
        expect(html).toContain('↓');
    });

    it('renders grid direction export arrow with correct accessibility properties', () => {
        const props = {
            ...defaultProps,
            model: {
                ...mockModel,
                gridDirection: 'export' as const,
            },
        };
        const html = renderToStaticMarkup(<HeaderMetricsStrip {...props} />);
        expect(html).toContain('aria-label="Grid Export"');
        expect(html).toContain('↑');
    });

    it('does not render direction arrow when gridDirection is none', () => {
        const html = renderToStaticMarkup(<HeaderMetricsStrip {...defaultProps} />);
        expect(html).not.toContain('↓');
        expect(html).not.toContain('↑');
        expect(html).not.toContain('aria-label="Grid Import"');
        expect(html).not.toContain('aria-label="Grid Export"');
    });

    it('uses collapsed classes for responsive gating when isExpanded is false', () => {
        const html = renderToStaticMarkup(<HeaderMetricsStrip {...defaultProps} isExpanded={false} />);
        // Battery wrapper should have 'hidden sm:inline-flex'
        expect(html).toContain('hidden sm:inline-flex');
        // Solar label should have 'hidden sm:inline'
        expect(html).toContain('hidden sm:inline');
        // Solar sparkline should have 'hidden lg:inline-flex'
        expect(html).toContain('hidden lg:inline-flex');
    });

    it('uses expanded classes when isExpanded is true', () => {
        const html = renderToStaticMarkup(<HeaderMetricsStrip {...defaultProps} isExpanded={true} />);
        // Battery wrapper should just be 'inline-flex'
        expect(html).toContain('class="inline-flex items-center gap-1 shrink-0"');
        // Solar label should just be 'inline'
        expect(html).toContain('Solar');
        // Solar sparkline should be 'inline-flex'
        expect(html).toContain('inline-flex items-center ml-1');
    });

    it('renders detail view affordance on all states, applying hover transitions when collapsed', () => {
        const htmlCollapsed = renderToStaticMarkup(<HeaderMetricsStrip {...defaultProps} isExpanded={false} />);
        expect(htmlCollapsed).toContain('View details');
        expect(htmlCollapsed).toContain('hidden lg:inline-flex');
        expect(htmlCollapsed).toContain('opacity-0');
        expect(htmlCollapsed).toContain('lg:group-hover:opacity-100');

        const htmlExpanded = renderToStaticMarkup(<HeaderMetricsStrip {...defaultProps} isExpanded={true} />);
        expect(htmlExpanded).toContain('View details');
        expect(htmlExpanded).not.toContain('hidden lg:inline-flex');
        expect(htmlExpanded).toContain('opacity-100');
        expect(htmlExpanded).not.toContain('opacity-0');
    });
});
