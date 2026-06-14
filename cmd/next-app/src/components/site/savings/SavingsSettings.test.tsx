import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SavingsSettings } from './SavingsSettings';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

const props = { siteId: 's1', roiConfig: null, comparisonPlans: [], meteredPlanName: 'Standard' };

describe('SavingsSettings', () => {
  it('renders the config forms when defaultOpen is true', () => {
    const html = renderToStaticMarkup(<SavingsSettings {...props} defaultOpen />);
    expect(html).toContain('ROI / Savings');
    expect(html).toContain('Comparison plans');
  });

  it('hides the config forms when defaultOpen is false', () => {
    const html = renderToStaticMarkup(<SavingsSettings {...props} defaultOpen={false} />);
    expect(html).toContain('Savings settings');
    expect(html).not.toContain('ROI / Savings');
  });
});
