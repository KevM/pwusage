import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LoadHeadroomGlyph } from './LoadHeadroomGlyph';

describe('LoadHeadroomGlyph', () => {
    it('renders nothing when headroom is unavailable', () => {
        expect(renderToStaticMarkup(<LoadHeadroomGlyph headroom={null} />)).toBe('');
        expect(renderToStaticMarkup(<LoadHeadroomGlyph headroom={undefined} />)).toBe('');
    });

    it('names the selected profile and surplus in the tooltip', () => {
        const html = renderToStaticMarkup(
            <LoadHeadroomGlyph headroom={{
                surplusKwh: 120.4, periodName: 'OFF_PEAK', glyph: 'car', profileLabel: 'Little car',
            }} />
        );
        expect(html).toContain('Off-Peak');
        expect(html).toContain('120 kWh');
        expect(html).toContain('Little car');
    });

    it('uses a danger tone when nothing clears the smallest threshold', () => {
        const html = renderToStaticMarkup(
            <LoadHeadroomGlyph headroom={{
                surplusKwh: -8, periodName: 'ON_PEAK', glyph: null, profileLabel: null,
            }} />
        );
        expect(html).toContain('red');
        expect(html).toContain('avoid large loads');
    });

    it('tones the small tier as a warning and larger tiers as success', () => {
        const small = renderToStaticMarkup(
            <LoadHeadroomGlyph headroom={{
                surplusKwh: 6, periodName: 'ON_PEAK', glyph: 'small', profileLabel: 'Dishwasher',
            }} />
        );
        const large = renderToStaticMarkup(
            <LoadHeadroomGlyph headroom={{
                surplusKwh: 200, periodName: 'OFF_PEAK', glyph: 'car', profileLabel: 'Big car',
            }} />
        );
        expect(small).toContain('amber');
        expect(large).toContain('green');
    });

    it('is hidden from assistive tech only via the icon, not the label', () => {
        const html = renderToStaticMarkup(
            <LoadHeadroomGlyph headroom={{
                surplusKwh: 30, periodName: 'OFF_PEAK', glyph: 'appliance', profileLabel: 'Laundry',
            }} />
        );
        expect(html).toContain('aria-hidden="true"');
        expect(html).toContain('sr-only');
    });
});
