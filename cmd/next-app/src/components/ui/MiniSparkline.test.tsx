import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MiniSparkline } from './MiniSparkline';

describe('MiniSparkline signed rendering', () => {
    it('uses positive stroke class for positive-only grid values', () => {
        const html = renderToStaticMarkup(
            <MiniSparkline
                series={[{ watts: 200 }, { watts: 450 }, { watts: 150 }]}
                includeZero
                positiveStrokeClassName="pos"
                negativeStrokeClassName="neg"
            />
        );

        expect(html).toContain('class="pos"');
        expect(html).not.toContain('class="neg"');
    });

    it('uses negative stroke class for negative-only grid values', () => {
        const html = renderToStaticMarkup(
            <MiniSparkline
                series={[{ watts: -200 }, { watts: -450 }, { watts: -150 }]}
                includeZero
                positiveStrokeClassName="pos"
                negativeStrokeClassName="neg"
            />
        );

        expect(html).toContain('class="neg"');
        expect(html).not.toContain('class="pos"');
    });

    it('renders both positive and negative strokes when values cross zero', () => {
        const html = renderToStaticMarkup(
            <MiniSparkline
                series={[{ watts: 240 }, { watts: -120 }, { watts: 180 }]}
                includeZero
                positiveStrokeClassName="pos"
                negativeStrokeClassName="neg"
            />
        );

        expect(html).toContain('class="pos"');
        expect(html).toContain('class="neg"');
    });
});
