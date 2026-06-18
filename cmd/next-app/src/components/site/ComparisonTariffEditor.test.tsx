import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ toast: () => {} }) }));

import { ComparisonTariffEditor } from './ComparisonTariffEditor';
import type { ComparisonPlan } from '@/lib/roi/comparison-tariff-repo';

const plans: ComparisonPlan[] = [
    { name: 'EV Plan', versions: [
        { version: 2, is_current: true, effective_from: '2025-06-01', buy_rate: 0.30, sell_rate: 0.05, kind: 'tou' },
        { version: 1, is_current: false, effective_from: '2024-01-01', buy_rate: 0.20, sell_rate: 0.04, kind: 'fixed' },
    ] },
];

function render() {
    return renderToStaticMarkup(<ComparisonTariffEditor siteId="s1" plans={plans} meteredPlanName="Standard" />);
}

describe('ComparisonTariffEditor', () => {
    it('renders the plan name and each version', () => {
        const html = render();
        expect(html).toContain('EV Plan');
        expect(html).toContain('2025-06-01');
        expect(html).toContain('2024-01-01');
    });

    it('derives a Fixed/TOU badge per version', () => {
        const html = render();
        expect(html).toMatch(/TOU/);          // version 2 (kind: tou)
        expect(html).toMatch(/0\.20000/);     // version 1 (fixed) shows its rate
    });

    it('exposes create / edit / add-version / rename / delete entry points', () => {
        const html = render();
        expect(html).toMatch(/add comparison plan/i);
        expect(html).toMatch(/edit/i);
        expect(html).toMatch(/add version/i);
        expect(html).toMatch(/rename/i);
        expect(html).toMatch(/delete/i);
    });

    it('no longer carries the flat "coming soon" note', () => {
        const html = render();
        expect(html).not.toMatch(/coming soon/i);
        expect(html).not.toMatch(/Date-based pricing arrives/i);
    });

    it('accepts a meteredPlanVersion prop (clone-from-metered wiring)', () => {
        const html = renderToStaticMarkup(
            <ComparisonTariffEditor siteId="s1" plans={plans} meteredPlanName="Standard" meteredPlanVersion={3} />,
        );
        expect(html).toContain('EV Plan');            // still renders the list
        expect(html).toMatch(/add comparison plan/i); // entry point intact
    });
});
