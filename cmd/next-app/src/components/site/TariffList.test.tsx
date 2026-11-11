import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { SiteTariffsTimelineResponse } from '@/lib/tariff-contract';
import { TariffList } from './TariffList';

const baseTimeline: SiteTariffsTimelineResponse = {
  version: 2,
  siteId: 'site-1',
  timezone: 'America/Chicago',
  currency: 'USD',
  periods: [
    {
      periodId: 2,
      tariffId: 20,
      name: 'We Energies Time-of-Use',
      version: 2,
      source: 'manual',
      effectiveFrom: '2026-01-01',
      effectiveTo: null,
      isCurrentToday: true,
      updatedBy: { email: 'alice@example.com', isCurrentUser: true },
      seasons: [
        {
          name: 'All Year',
          fromMonth: 1,
          toMonth: 12,
          weekdayPeriods: [
            {
              touName: 'ON_PEAK',
              fromHour: 9,
              fromMinute: 0,
              toHour: 21,
              toMinute: 0,
              buyRate: 0.30335,
              sellRate: 0.04906,
            },
            {
              touName: 'OFF_PEAK',
              fromHour: 21,
              fromMinute: 0,
              toHour: 9,
              toMinute: 0,
              buyRate: 0.1,
              sellRate: 0.0329,
            },
          ],
          weekendPeriods: [
            {
              touName: 'OFF_PEAK',
              fromHour: 0,
              fromMinute: 0,
              toHour: 24,
              toMinute: 0,
              buyRate: 0.1,
              sellRate: 0.0329,
            },
          ],
        },
      ],
    },
    {
      periodId: 1,
      tariffId: 10,
      name: 'We Energies Prior',
      version: 1,
      source: 'tesla',
      effectiveFrom: '2025-01-01',
      effectiveTo: '2025-09-30',
      isCurrentToday: false,
      updatedBy: { email: 'bob@example.com', isCurrentUser: false },
      seasons: [
        {
          name: 'All Year',
          fromMonth: 1,
          toMonth: 12,
          weekdayPeriods: [
            {
              touName: 'OFF_PEAK',
              fromHour: 0,
              fromMinute: 0,
              toHour: 24,
              toMinute: 0,
              buyRate: 0.15,
              sellRate: 0.02,
            },
          ],
          weekendPeriods: [
            {
              touName: 'OFF_PEAK',
              fromHour: 0,
              fromMinute: 0,
              toHour: 24,
              toMinute: 0,
              buyRate: 0.15,
              sellRate: 0.02,
            },
          ],
        },
      ],
    },
  ],
  reattribution: null,
  teslaSync: {
    latestTariffId: 10,
    latestTariffName: 'We Energies Prior',
    latestUpdatedAt: '2025-01-01T00:00:00Z',
    differsFromActiveManual: false,
  },
};

function renderTimeline(timeline: SiteTariffsTimelineResponse | null = baseTimeline) {
  return renderToStaticMarkup(
    <TariffList
      timeline={timeline}
      onRefresh={vi.fn(async () => {})}
      refreshLoading={false}
      refreshStatus={null}
      onRetryReattribution={vi.fn(async () => {})}
      retryLoading={false}
    />
  );
}

describe('TariffList v2 timeline', () => {
  it('renders active and historical spans with badges, middle-dot author attribution, gap rows, and 5-decimal precision', () => {
    const html = renderTimeline();

    expect(html).toContain('Active today');
    expect(html).toContain('Custom');
    expect(html).toContain('Synced from Tesla');
    expect(html).toContain('Edited by you');
    expect(html).toContain('Edited by bob@example.com');
    expect(html).toContain('·');

    // Gap between 2025-09-30 and 2026-01-01 -> Oct 1, 2025 – Dec 31, 2025
    expect(html).toContain('Oct 1, 2025 – Dec 31, 2025 · Uses nearest prior plan');

    // Dynamic 2..5 decimal formatting without truncating to 4 decimals
    expect(html).toContain('$0.30335');
    expect(html).toContain('$0.04906');
    expect(html).toContain('$0.10');
    expect(html).toContain('Buy');
    expect(html).toContain('Sell');
    expect(html).toContain('Rate Plan');
    expect(html).toContain('Rate Period');
  });

  it('shows reattribution running and failed retry banners plus Tesla divergence notice', () => {
    const runningHtml = renderTimeline({
      ...baseTimeline,
      reattribution: {
        status: 'running',
        fromDate: '2026-01-01',
        toDate: null,
        totalDays: 120,
        processedDays: 45,
        updatedDays: 40,
        lastError: null,
        updatedAt: '2026-06-01T00:00:00Z',
      },
      teslaSync: {
        ...baseTimeline.teslaSync,
        differsFromActiveManual: true,
      },
    });
    expect(runningHtml).toContain('Updating historical rates · 45 of 120 days');
    expect(runningHtml).toContain('Your custom rate plan remains active');

    const failedHtml = renderTimeline({
      ...baseTimeline,
      reattribution: {
        status: 'failed',
        fromDate: '2026-01-01',
        toDate: null,
        totalDays: 120,
        processedDays: 45,
        updatedDays: 40,
        lastError: 'PoolTimeout',
        updatedAt: '2026-06-01T00:00:00Z',
      },
    });
    expect(failedHtml).toContain('Could not finish updating history');
    expect(failedHtml).toContain('Retry');
  });

  it('mentions iOS editor support and contains zero forbidden tariff or TOU terms', () => {
    const html = renderTimeline();
    expect(html).toContain('PWUsage iOS app');
    expect(html.toLowerCase()).not.toContain('tariff');
    expect(html).not.toMatch(/\bTOU\b/i);

    const emptyHtml = renderTimeline({ ...baseTimeline, periods: [] });
    expect(emptyHtml.toLowerCase()).not.toContain('tariff');
    expect(emptyHtml).not.toMatch(/\bTOU\b/i);
  });
});
