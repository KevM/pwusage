import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ toast: () => {} }) }));

import { ComparisonTariffEditor } from './ComparisonTariffEditor';
import type { ComparisonPlan } from '@/lib/roi/comparison-tariff-repo';

const plans: ComparisonPlan[] = [
    { name: 'EV Plan', versions: [
        { version: 2, is_current: true, effective_from: '2025-06-01', buy_rate: 0.30, sell_rate: 0.05, kind: 'fixed' },
        { version: 1, is_current: false, effective_from: '2024-01-01', buy_rate: 0.20, sell_rate: 0.04, kind: 'fixed' },
    ] },
];

describe('ComparisonTariffEditor', () => {
    it('renders the plan name and each version', () => {
        const html = renderToStaticMarkup(<ComparisonTariffEditor siteId="s1" plans={plans} meteredPlanName="Standard" />);
        expect(html).toContain('EV Plan');
        expect(html).toContain('2025-06-01');
        expect(html).toContain('2024-01-01');
    });

    it('exposes per-version edit + delete and per-plan controls', () => {
        const html = renderToStaticMarkup(<ComparisonTariffEditor siteId="s1" plans={plans} meteredPlanName="Standard" />);
        expect(html).toMatch(/edit/i);
        expect(html).toMatch(/delete/i);
        expect(html).toMatch(/add version/i);
    });

    it('does not carry the stale "date-based pricing arrives" note', () => {
        const html = renderToStaticMarkup(<ComparisonTariffEditor siteId="s1" plans={plans} meteredPlanName="Standard" />);
        expect(html).not.toMatch(/Date-based pricing arrives/i);
    });
});
