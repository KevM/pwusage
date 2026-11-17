import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  afterCallbacks: [] as Array<() => Promise<unknown> | unknown>,
  getCurrentUser: vi.fn(),
  verifySiteAccess: vi.fn(),
  isCrossOriginRequest: vi.fn(),
  commitTariffSelection: vi.fn(),
  runSiteReattribution: vi.fn(),
}));

vi.mock('next/server', async importOriginal => {
  const actual = await importOriginal<typeof import('next/server')>();
  return {
    ...actual,
    after: (cb: () => Promise<unknown> | unknown) => {
      mocks.afterCallbacks.push(cb);
    },
  };
});

vi.mock('@/lib/auth-checks', () => ({
  getCurrentUser: mocks.getCurrentUser,
  verifySiteAccess: mocks.verifySiteAccess,
}));

vi.mock('@/lib/request-security', () => ({
  isCrossOriginRequest: mocks.isCrossOriginRequest,
}));

vi.mock('@/lib/io-deadline', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/io-deadline')>(),
  withIoDeadline: (_ms: number, fn: () => Promise<unknown>) => fn(),
}));

vi.mock('@/lib/observability', () => ({
  observeRoute: (_name: string, fn: (req: NextRequest, ctx: unknown) => Promise<Response>) => fn,
  setLogContext: vi.fn(),
  logEvent: vi.fn(),
  flushLogEvents: vi.fn(),
  errorFields: () => ({}),
}));

vi.mock('@/lib/tariff-reattribution', () => ({
  REATTRIBUTION_AFTER_MAX_TIME_MS: 6000,
  runSiteReattribution: mocks.runSiteReattribution,
}));

vi.mock('@/lib/tariff-selection-service', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/tariff-selection-service')>(),
  commitTariffSelection: mocks.commitTariffSelection,
}));

import { POST } from './route';
import { TariffValidationError } from '@/lib/tariff-timeline';
import { TariffNotFoundError, TariffSelectionConflictError, UtilityChangedError } from '@/lib/tariff-timeline-repo';
import { UrdbUnavailableError } from '@/lib/urdb/client';

const context = { params: Promise.resolve({ id: 'site-1' }) };

const timelineStub = {
  version: 2 as const,
  siteId: 'site-1',
  timezone: 'America/Chicago',
  currency: 'USD',
  periods: [],
  referencePeriods: [],
  estimates: null,
  battery: null,
  systemCosts: { siteInstalled: '2024-01-01', solar: null, powerwall: null },
  reattribution: null,
  holidayDates: [],
  teslaSync: {
    latestTariffId: null,
    latestTariffName: null,
    latestUpdatedAt: null,
    differsFromActiveManual: false,
  },
};

const post = (body: unknown) =>
  new NextRequest('https://app.test/api/site/site-1/tariffs/selection', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });

describe('POST /api/site/[id]/tariffs/selection', () => {
  beforeEach(() => {
    mocks.afterCallbacks.length = 0;
    vi.clearAllMocks();
    mocks.isCrossOriginRequest.mockReturnValue(false);
    mocks.getCurrentUser.mockResolvedValue({ id: 'user-1' });
    mocks.verifySiteAccess.mockResolvedValue(true);
    mocks.runSiteReattribution.mockResolvedValue({ outcome: 'idle', processedDays: 0, updatedDays: 0 });
    mocks.commitTariffSelection.mockResolvedValue({
      selectionIds: [11],
      tariffIds: [22],
      createdNewTariffVersion: true,
      unchanged: false,
      reattributionRange: { fromDate: '2025-01-01', toDate: null },
      timeline: timelineStub,
    });
  });

  it('enforces auth, site isolation, and cross-origin protection', async () => {
    mocks.getCurrentUser.mockResolvedValueOnce(null);
    expect((await POST(post({}), context)).status).toBe(401);

    mocks.verifySiteAccess.mockResolvedValueOnce(false);
    expect((await POST(post({}), context)).status).toBe(401);

    mocks.isCrossOriginRequest.mockReturnValueOnce(true);
    expect((await POST(post({}), context)).status).toBe(403);
    expect(mocks.commitTariffSelection).not.toHaveBeenCalled();
  });

  it('commits an explicit selection with ETag and runs after() reattribution only for changed actual scope', async () => {
    const payload = {
      scope: 'actual',
      candidate: { kind: 'public', label: 'urdb-1' },
      effectiveFrom: '2025-01-01',
      effectiveTo: null,
      expectedReviewHash: 'b'.repeat(64),
      verifiedAgainstBill: true,
    };

    const res = await POST(post(payload), context);
    expect(res.status).toBe(200);
    expect(res.headers.get('ETag')).toMatch(/^"[0-9a-f]{64}"$/);
    expect(mocks.commitTariffSelection).toHaveBeenCalledWith('site-1', 'user-1', payload);
    expect(mocks.afterCallbacks).toHaveLength(1);
    await mocks.afterCallbacks[0]();
    expect(mocks.runSiteReattribution).toHaveBeenCalledWith({
      siteId: 'site-1',
      trigger: 'after',
      maxTimeMs: 6000,
    });

    // Reference-scope or unchanged commits do not trigger actual reattribution
    mocks.afterCallbacks.length = 0;
    mocks.runSiteReattribution.mockClear();
    mocks.commitTariffSelection.mockResolvedValueOnce({
      selectionIds: [12],
      tariffIds: [23],
      createdNewTariffVersion: false,
      unchanged: true,
      reattributionRange: null,
      timeline: timelineStub,
    });
    const retryRes = await POST(post(payload), context);
    expect(retryRes.status).toBe(200);
    expect(mocks.afterCallbacks).toHaveLength(0);
  });

  it('returns 409 with refreshPath and refreshed preview on stale review conflict', async () => {
    const freshPreview = {
      reviewHash: 'c'.repeat(64),
      siteId: 'site-1',
      scope: 'actual' as const,
      effectiveFrom: '2025-01-01',
      effectiveTo: null,
      currency: 'USD',
      unit: 'kWh' as const,
      timezone: 'America/Chicago',
      holidaysUseWeekendSchedule: true,
      recalculatesHistory: true,
      recalculationRange: { fromDate: '2025-01-01', toDate: null },
      affectsPowerwallPlan: false as const,
      candidatePlan: null,
      affectedIntervals: [],
      unchangedOutsidePeriods: [],
      restoration: {
        preservedOriginals: [],
        restoredOriginals: [],
        unavailableRanges: [],
        canApplyRestoration: false,
      },
      approximationNotes: [],
      summary: {
        hasBuyRateChanges: false,
        hasSellRateChanges: false,
        hasRateChanges: false,
        hasPeriodNameChanges: false,
        fillsGap: false,
        replacesExistingPlan: false,
      },
    };
    mocks.commitTariffSelection.mockRejectedValueOnce(new TariffSelectionConflictError('site-1', freshPreview));

    const res = await POST(post({}), context);
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json).toMatchObject({
      code: 'REVIEW_STALE',
      refreshPath: '/api/site/site-1/tariffs/selection/preview',
      preview: freshPreview,
    });
    expect(mocks.afterCallbacks).toHaveLength(0);
  });

  it('maps malformed JSON, validation, missing site, utility conflict, and URDB outages', async () => {
    expect((await POST(post('{bad'), context)).status).toBe(400);

    mocks.commitTariffSelection.mockRejectedValueOnce(new TariffValidationError('Bad commit'));
    expect((await POST(post({}), context)).status).toBe(400);

    mocks.commitTariffSelection.mockRejectedValueOnce(new TariffNotFoundError('Site not found'));
    expect((await POST(post({}), context)).status).toBe(404);

    mocks.commitTariffSelection.mockRejectedValueOnce(new UtilityChangedError('Utility changed'));
    expect((await POST(post({}), context)).status).toBe(409);

    mocks.commitTariffSelection.mockRejectedValueOnce(new UrdbUnavailableError('URDB down'));
    expect((await POST(post({}), context)).status).toBe(503);
  });
});
