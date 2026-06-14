import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { RollupBackfill } from '@/lib/db';
import { IndexingStatus } from './IndexingStatus';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

const bf = (over: Partial<RollupBackfill>): RollupBackfill => ({
  site_id: 's1', status: 'pending', oldest_date: '2024-01-01', cursor_date: '2024-03-01',
  newest_date: '2024-06-01', days_done: 50, days_total: 100, genesis_anchored: false, last_error: null,
  ...over,
});

describe('IndexingStatus', () => {
  it('shows progress and percent while running', () => {
    const html = renderToStaticMarkup(<IndexingStatus siteId="s1" backfill={bf({ status: 'running' })} />);
    expect(html).toContain('50%');
    expect(html).not.toContain('Index history');
  });

  it('shows the start CTA only when there is no backfill row', () => {
    const html = renderToStaticMarkup(<IndexingStatus siteId="s1" backfill={null} />);
    expect(html).toContain('Index history');
  });

  it('keeps the in-process card (no start button) on a recoverable error', () => {
    const html = renderToStaticMarkup(<IndexingStatus siteId="s1" backfill={bf({ status: 'error', last_error: '[attempts=2] 529 overload' })} />);
    expect(html).toMatch(/retry automatically/i);
    expect(html).not.toContain('Index history');
  });

  it('shows a paused message with no button on a terminal error', () => {
    const html = renderToStaticMarkup(<IndexingStatus siteId="s1" backfill={bf({ status: 'error', last_error: '[attempts=5] 529 overload' })} />);
    expect(html).toMatch(/resume later/i);
    expect(html).not.toContain('Index history');
  });
});
