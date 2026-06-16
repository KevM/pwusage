import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect } from 'vitest';
import { ExtendedGrid } from './ExtendedGrid';
import type { ExtendedGridModel } from '@/lib/roi/extended-grid';

const grid: ExtendedGridModel = {
    columns: [{ name: 'Your TOU', type: 'metered' }, { name: 'Cheap Flat', type: 'fixed' }],
    rows: [
        { config: 'noSolar', label: 'No Solar', cells: [
            { value: 2000, cheapest: false, here: false }, { value: 1000, cheapest: true, here: false }] },
        { config: 'solar', label: 'Solar', cells: [
            { value: 800, cheapest: false, here: false }, { value: 400, cheapest: true, here: false }] },
        { config: 'solarBattery', label: 'Solar+Batt', cells: [
            { value: 1200, cheapest: false, here: true }, { value: 600, cheapest: true, here: false }] },
    ],
};

describe('ExtendedGrid', () => {
    it('renders every plan name and config label', () => {
        const html = renderToStaticMarkup(<ExtendedGrid grid={grid} />);
        expect(html).toContain('Your TOU');
        expect(html).toContain('Cheap Flat');
        expect(html).toContain('No Solar');
        expect(html).toContain('Solar+Batt');
    });

    it('formats cell values as whole-dollar USD', () => {
        const html = renderToStaticMarkup(<ExtendedGrid grid={grid} />);
        expect(html).toContain('$2,000');
        expect(html).toContain('$600');
    });

    it('marks the metered column as "you are here" and shows type labels', () => {
        const html = renderToStaticMarkup(<ExtendedGrid grid={grid} />);
        expect(html).toMatch(/you are here/i);
        expect(html).toContain('metered');
        expect(html).toContain('Fixed');
    });

    it('renders both a desktop grid and mobile cards (responsive blocks)', () => {
        const html = renderToStaticMarkup(<ExtendedGrid grid={grid} />);
        expect(html).toContain('md:hidden');     // mobile cards block
        expect(html).toContain('hidden md:block'); // desktop grid block
    });
});
