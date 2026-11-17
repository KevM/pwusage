import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  afterCallbacks: [] as Array<() => Promise<unknown> | unknown>,
  getCurrentUser: vi.fn(),
  verifySiteAccess: vi.fn(),
  isCrossOriginRequest: vi.fn(),
  getSiteRateCountry: vi.fn(),
  setSiteRateCountry: vi.fn(),
  runSiteReattribution: vi.fn(),
  logEvent: vi.fn(),
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
  logEvent: mocks.logEvent,
  flushLogEvents: vi.fn(),
  errorFields: () => ({}),
}));

vi.mock('@/lib/tariff-reattribution', () => ({
  REATTRIBUTION_AFTER_MAX_TIME_MS: 6000,
  runSiteReattribution: mocks.runSiteReattribution,
}));

vi.mock('@/lib/tariff-timeline-repo', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/tariff-timeline-repo')>();
  return {
    ...actual,
    TariffTimelineRepo: class {
      getSiteRateCountry = mocks.getSiteRateCountry;
      setSiteRateCountry = mocks.setSiteRateCountry;
    },
  };
});

import { GET, PUT } from './route';
import { TariffNotFoundError } from '@/lib/tariff-timeline-repo';
import { TariffValidationError } from '@/lib/tariff-timeline';

const context = { params: Promise.resolve({ id: 'site-1' }) };

const timelineStub = {
  version: 2 as const,
  siteId: 'site-1',
  timezone: 'America/Chicago',
  currency: 'USD',
  periods: [],
  referencePeriods: [],
  estimates: null,
  rateCountry: {
    countryCode: 'US',
    source: 'owner' as const,
    updatedAt: '2026-11-17T18:00:00.000Z',
    eligibility: 'us' as const,
    hasIneligiblePublicSelection: false,
  },
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

const put = (body: unknown) =>
  new NextRequest('https://app.test/api/site/site-1/rate-country', {
    method: 'PUT',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });

describe('/api/site/[id]/rate-country', () => {
  beforeEach(() => {
    mocks.afterCallbacks.length = 0;
    vi.clearAllMocks();
    mocks.isCrossOriginRequest.mockReturnValue(false);
    mocks.getCurrentUser.mockResolvedValue({ id: 'user-1' });
    mocks.verifySiteAccess.mockResolvedValue(true);
    mocks.runSiteReattribution.mockResolvedValue({ outcome: 'idle', processedDays: 0, updatedDays: 0 });
    mocks.getSiteRateCountry.mockResolvedValue({
      countryCode: 'US',
      source: 'owner',
      updatedAt: '2026-11-17T18:00:00.000Z',
      eligibility: 'us',
    });
    mocks.setSiteRateCountry.mockResolvedValue({
      timeline: timelineStub,
      reattributionRange: null,
    });
  });

  it('enforces auth, site access isolation, and cross-origin protection', async () => {
    mocks.getCurrentUser.mockResolvedValueOnce(null);
    expect((await GET(new NextRequest('https://app.test/api/site/site-1/rate-country'), context)).status).toBe(401);

    mocks.verifySiteAccess.mockResolvedValueOnce(false);
    expect((await PUT(put({ countryCode: 'US', source: 'owner' }), context)).status).toBe(401);

    mocks.isCrossOriginRequest.mockReturnValueOnce(true);
    expect((await PUT(put({ countryCode: 'US', source: 'owner' }), context)).status).toBe(403);
    expect(mocks.setSiteRateCountry).not.toHaveBeenCalled();
  });

  it('returns stored country metadata on GET', async () => {
    const res = await GET(new NextRequest('https://app.test/api/site/site-1/rate-country'), context);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store, max-age=0');
    expect(await res.json()).toEqual({
      countryCode: 'US',
      source: 'owner',
      updatedAt: '2026-11-17T18:00:00.000Z',
      eligibility: 'us',
    });
  });

  it('rejects payloads with coordinates and never logs them', async () => {
    const actualRepo = await vi.importActual<typeof import('@/lib/tariff-timeline-repo')>('@/lib/tariff-timeline-repo');

    const res = await PUT(
      put({ countryCode: 'US', source: 'solar_location', latitude: 43.07, longitude: -89.4 }),
      context
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/coordinates/i);
    expect(JSON.stringify(body)).not.toContain('43.07');
    expect(JSON.stringify(body)).not.toContain('-89.4');
    expect(mocks.setSiteRateCountry).not.toHaveBeenCalled();

    // Repo boundary also rejects coordinate payloads directly before opening a DB connection.
    await expect(
      new actualRepo.TariffTimelineRepo().setSiteRateCountry('site-1', 'user-1', {
        countryCode: 'US',
        source: 'solar_location',
        lat: 43.07,
        lng: -89.4,
      })
    ).rejects.toThrow(TariffValidationError);
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });

  it('maps invalid codes, missing site, and runs after() reattribution when automatic coverage is removed', async () => {
    expect((await PUT(put({ countryCode: 'ZZ', source: 'owner' }), context)).status).toBe(400);
    expect((await PUT(put({ countryCode: 'UK', source: 'owner' }), context)).status).toBe(400);
    expect(mocks.setSiteRateCountry).not.toHaveBeenCalled();

    mocks.setSiteRateCountry.mockRejectedValueOnce(new TariffValidationError('Choose a valid two-letter country code.'));
    expect((await PUT(put({ countryCode: 'US', source: 'owner' }), context)).status).toBe(400);

    mocks.setSiteRateCountry.mockRejectedValueOnce(new TariffNotFoundError('Site not found'));
    expect((await PUT(put({ countryCode: 'CA', source: 'owner' }), context)).status).toBe(404);

    mocks.setSiteRateCountry.mockResolvedValueOnce({
      timeline: {
        ...timelineStub,
        rateCountry: {
          countryCode: 'CA',
          source: 'owner',
          updatedAt: '2026-11-17T18:05:00.000Z',
          eligibility: 'outside_us',
          hasIneligiblePublicSelection: false,
        },
      },
      reattributionRange: { fromDate: '2025-01-01', toDate: null },
    });

    const ok = await PUT(put({ countryCode: 'CA', source: 'owner' }), context);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('ETag')).toMatch(/^"[0-9a-f]{64}"$/);
    expect(mocks.afterCallbacks).toHaveLength(1);
    await mocks.afterCallbacks[0]();
    expect(mocks.runSiteReattribution).toHaveBeenCalledWith({
      siteId: 'site-1',
      trigger: 'after',
      maxTimeMs: 6000,
    });
  });
});
