import { beforeEach, describe, expect, it, vi } from 'vitest';

const { historyRevisionMock, reattributionMock } = vi.hoisted(() => ({
  historyRevisionMock: vi.fn(),
  reattributionMock: vi.fn(),
}));

vi.mock('./mobile-history-revision', () => ({
  readMobileHistoryRevision: historyRevisionMock,
}));

vi.mock('./tariff-reattribution', () => ({
  getSiteReattributionStatus: reattributionMock,
}));

import { readMobileBillRevision } from './mobile-bill-revision';
import { Schedule } from './schedule';
import type { SiteWithTariffs } from './db-types';

const site: SiteWithTariffs = {
  id: 'site-1',
  name: 'Home',
  timezone: 'America/Chicago',
  billing_start_day: 1,
  updated: new Date('2026-01-01T00:00:00Z'),
  installed: new Date('2025-01-01T00:00:00Z'),
  json: {},
  tariffs: [
    {
      id: 10,
      site_id: 'site-1',
      name: 'Standard',
      updated: new Date('2026-01-01T00:00:00Z'),
      seasons: [
        {
          id: 1,
          tariff_id: 10,
          name: 'All Year',
          from_month: 1,
          from_day: 1,
          to_month: 12,
          to_day: 31,
          buy_rate: 0.2,
          sell_rate: 0.05,
          schedules: [
            {
              id: 2,
              season_id: 1,
              name: 'OFF_PEAK',
              buy_rate: 0.2,
              sell_rate: 0.05,
              from_day_of_week: 0,
              to_day_of_week: 6,
              from_hour: 0,
              from_minute: 0,
              to_hour: 24,
              to_minute: 0,
            },
          ],
        },
      ],
    },
  ],
};

const config = {
  name: 'Home',
  timezone: 'America/Chicago',
  billing_start_day: 1,
  currency: 'USD',
  tariff_ids: [10],
};

describe('readMobileBillRevision', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    historyRevisionMock.mockResolvedValue({
      latest: new Date('2026-06-15T10:00:00Z'),
      hasFutureSamples: false,
      revision: 'hist-rev-1',
    });
    reattributionMock.mockResolvedValue(null);
  });

  it('produces distinct revisions when tariffReattribution transitions pending -> running -> idle even if cycle history is unchanged', async () => {
    const schedule = new Schedule(site.tariffs, site.timezone);
    const cycleStart = new Date('2026-06-01T05:00:00Z');
    const cycleEnd = new Date('2026-07-01T05:00:00Z');
    const now = new Date('2026-06-15T12:00:00Z');

    reattributionMock.mockResolvedValueOnce({
      status: 'pending',
      fromDate: '2026-01-01',
      toDate: null,
      totalDays: 100,
      processedDays: 0,
      updatedDays: 0,
      lastError: null,
      updatedAt: '2026-06-15T11:59:00Z',
    });
    const revPending = await readMobileBillRevision(site, config, schedule, cycleStart, cycleEnd, now, false);

    reattributionMock.mockResolvedValueOnce({
      status: 'running',
      fromDate: '2026-01-01',
      toDate: null,
      totalDays: 100,
      processedDays: 30,
      updatedDays: 12,
      lastError: null,
      updatedAt: '2026-06-15T11:59:30Z',
    });
    const revRunning = await readMobileBillRevision(site, config, schedule, cycleStart, cycleEnd, now, false);

    reattributionMock.mockResolvedValueOnce(null);
    const revIdle = await readMobileBillRevision(site, config, schedule, cycleStart, cycleEnd, now, false);

    expect(revPending).toBeTruthy();
    expect(revRunning).toBeTruthy();
    expect(revIdle).toBeTruthy();
    expect(new Set([revPending, revRunning, revIdle]).size).toBe(3);
  });
});
