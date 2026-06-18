import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { RollupBackfill } from '@/lib/db';
import { SavingsView } from './SavingsView';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

const bf = (over: Partial<RollupBackfill>): RollupBackfill => ({
  site_id: 's1', status: 'pending', oldest_date: '2024-01-01', cursor_date: '2024-03-01',
  newest_date: '2024-06-01', days_done: 40, days_total: 100, genesis_anchored: false, last_error: null,
  ...over,
});

const base = { siteId: 's1', roiConfig: null, comparisonPlans: [], meteredPlanName: 'Standard', extendedGrid: null, meteredVersions: [] };

describe('SavingsView', () => {
  it('shows the indexing progress and collapsed settings on a recoverable error', () => {
    const html = renderToStaticMarkup(
      <SavingsView {...base} summary={null} backfill={bf({ status: 'error', last_error: '[attempts=2] 529' })} />,
    );
    expect(html).toMatch(/retry automatically/i);
    expect(html).not.toContain('Index history');
    expect(html).toContain('Savings settings');
  });

  it('shows expanded settings and the start CTA when nothing is set up', () => {
    const html = renderToStaticMarkup(<SavingsView {...base} summary={null} backfill={null} />);
    expect(html).toContain('Index history');
    expect(html).toContain('ROI / Savings');
  });

  it('shows expanded settings but no start CTA when a completed backfill exists without costs', () => {
    const html = renderToStaticMarkup(<SavingsView {...base} summary={null} backfill={bf({ status: 'complete' })} />);
    expect(html).toContain('ROI / Savings');
    expect(html).not.toContain('Index history');
  });
});
