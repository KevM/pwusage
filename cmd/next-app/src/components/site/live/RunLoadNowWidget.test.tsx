import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RunLoadNowWidget } from './RunLoadNowWidget';
import type { LoadTimingPeriod } from '@/lib/load-timing';

const periods: LoadTimingPeriod[] = [
    {
        name: 'ON_PEAK', marginalCost: 0.12, basis: 'sell', cycleNetExportKwh: 10,
        isActive: true, nextStartPhrase: null, buyRate: 0.48, sellRate: 0.12,
    },
    {
        name: 'OFF_PEAK', marginalCost: 0.03, basis: 'sell', cycleNetExportKwh: 120,
        isActive: false, nextStartPhrase: 'in 2h 10m', buyRate: 0.15, sellRate: 0.03,
    },
];

describe('RunLoadNowWidget', () => {
    it('renders a preset button for every configured profile', () => {
        const html = renderToStaticMarkup(<RunLoadNowWidget periods={periods} />);
        expect(html).toContain('Big car');
        expect(html).toContain('Little car');
        expect(html).toContain('Laundry');
        expect(html).toContain('Dishwasher');
    });

    it('prices every period for the initially selected load', () => {
        const html = renderToStaticMarkup(<RunLoadNowWidget periods={periods} />);
        expect(html).toContain('On-Peak');
        expect(html).toContain('Off-Peak');
        expect(html).toContain('in 2h 10m');
    });

    it('renders nothing when there are no periods', () => {
        expect(renderToStaticMarkup(<RunLoadNowWidget periods={[]} />)).toBe('');
    });
});
