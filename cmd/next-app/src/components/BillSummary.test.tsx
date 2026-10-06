import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BillSummary } from './BillSummary';
import { UsageData } from '@/lib/energy-repo';
import { calculate } from '@/lib/test-support/bill-fixture';

describe('BillSummary', () => {
    it('groups and merges duplicate TOU period names into a single block with summed usage/cost', () => {
        const dummyTariff = {
            id: 1,
            site_id: 'site-1',
            updated: new Date(),
            name: 'We energies',
        };

        const usage: UsageData[] = [
            {
                start: new Date('2026-05-11T00:00:00Z'),
                homeUsage: 100000, // 100 kWh
                gridUsage: 50000,
                solarProduction: 80000,
                batteryChange: 5000,
                tariff: dummyTariff,
                touName: 'On-Peak',
                cost: 15.00,
                buyRate: 0.30,
                sellRate: 0.05
            },
            {
                start: new Date('2026-05-11T00:00:00Z'),
                homeUsage: 50000, // 50 kWh
                gridUsage: 25000,
                solarProduction: 40000,
                batteryChange: 2500,
                tariff: dummyTariff,
                touName: 'On-Peak',
                cost: 7.50,
                buyRate: 0.30,
                sellRate: 0.05
            },
            {
                start: new Date('2026-05-11T00:00:00Z'),
                homeUsage: 200000, // 200 kWh
                gridUsage: 100000,
                solarProduction: 160000,
                batteryChange: 10000,
                tariff: dummyTariff,
                touName: 'Off-Peak',
                cost: 20.00,
                buyRate: 0.20,
                sellRate: 0.05
            }
        ];

        const html = renderToStaticMarkup(
            <BillSummary
                usage={usage}
                activeTariffId={1}
                activeTouName="On-Peak"
                currencySymbol="$"
            />
        );

        // In mobile and desktop views combined, each unique TOU name should appear exactly twice (once in desktop table, once in mobile card list)
        const onPeakOccurrences = (html.match(/On-Peak/g) || []).length;
        expect(onPeakOccurrences).toBe(2);

        // Check the aggregated values
        // On-Peak Home: 100 + 50 = 150 kWh
        expect(html).toContain('150.00 kWh');
        // On-Peak Cost: 15.00 + 7.50 = 22.50
        expect(html).toContain('$22.50');
    });
});


it('renders the real seasonal netting credit in both web layouts', () => {
    const { usage } = calculate([-27.471, 18.243]);
    const html = renderToStaticMarkup(<BillSummary usage={usage} currencySymbol="$" />);
    expect(html).toContain('-9.23 kWh');
    expect(html).toContain('-$0.37');
    expect(html).toContain('Est. Credit');
    expect(html).not.toContain('$4.56');
    expect((html.match(/On-Peak/g) ?? []).length).toBe(2);
});
