import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  verifySiteAccess: vi.fn(),
  isCrossOriginRequest: vi.fn(),
  previewTariffSelection: vi.fn(),
}));

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

vi.mock('@/lib/tariff-selection-service', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/tariff-selection-service')>(),
  previewTariffSelection: mocks.previewTariffSelection,
}));

import { POST } from './route';
import { TariffValidationError } from '@/lib/tariff-timeline';
import { TariffNotFoundError, UtilityChangedError } from '@/lib/tariff-timeline-repo';
import { UrdbUnavailableError } from '@/lib/urdb/client';

const context = { params: Promise.resolve({ id: 'site-1' }) };

const post = (body: unknown) =>
  new NextRequest('https://app.test/api/site/site-1/tariffs/selection/preview', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });

const previewStub = {
  reviewHash: 'a'.repeat(64),
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

describe('POST /api/site/[id]/tariffs/selection/preview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isCrossOriginRequest.mockReturnValue(false);
    mocks.getCurrentUser.mockResolvedValue({ id: 'user-1' });
    mocks.verifySiteAccess.mockResolvedValue(true);
    mocks.previewTariffSelection.mockResolvedValue(previewStub);
  });

  it('enforces auth, site isolation, and cross-origin protection', async () => {
    mocks.getCurrentUser.mockResolvedValueOnce(null);
    expect((await POST(post({}), context)).status).toBe(401);

    mocks.verifySiteAccess.mockResolvedValueOnce(false);
    expect((await POST(post({}), context)).status).toBe(401);

    mocks.isCrossOriginRequest.mockReturnValueOnce(true);
    expect((await POST(post({}), context)).status).toBe(403);
    expect(mocks.previewTariffSelection).not.toHaveBeenCalled();
  });

  it('returns preview response for explicit public, manual, and restoration requests', async () => {
    const payload = {
      scope: 'actual',
      candidate: { kind: 'public', label: 'urdb-1' },
      effectiveFrom: '2025-01-01',
      effectiveTo: null,
    };

    const res = await POST(post(payload), context);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store, max-age=0');
    expect(await res.json()).toEqual(previewStub);
    expect(mocks.previewTariffSelection).toHaveBeenCalledWith('site-1', 'user-1', payload);
  });

  it('maps malformed JSON, validation, missing site, utility conflict, and URDB errors cleanly', async () => {
    const malformed = await POST(post('{bad json'), context);
    expect(malformed.status).toBe(400);

    mocks.previewTariffSelection.mockRejectedValueOnce(new TariffValidationError('An effective start date is required'));
    expect((await POST(post({}), context)).status).toBe(400);

    mocks.previewTariffSelection.mockRejectedValueOnce(new TariffNotFoundError('Site not found'));
    expect((await POST(post({}), context)).status).toBe(404);

    mocks.previewTariffSelection.mockRejectedValueOnce(new UtilityChangedError('Choose a utility first.'));
    expect((await POST(post({}), context)).status).toBe(409);

    mocks.previewTariffSelection.mockRejectedValueOnce(new UrdbUnavailableError('timeout'));
    expect((await POST(post({}), context)).status).toBe(503);
  });
});
