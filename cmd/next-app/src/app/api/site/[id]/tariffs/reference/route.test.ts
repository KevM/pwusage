import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const {
  getCurrentUserMock,
  verifySiteAccessMock,
  isCrossOriginMock,
  createReferencePeriodMock,
  enqueueMock,
} = vi.hoisted(() => ({
  getCurrentUserMock: vi.fn(),
  verifySiteAccessMock: vi.fn(),
  isCrossOriginMock: vi.fn(),
  createReferencePeriodMock: vi.fn(),
  enqueueMock: vi.fn(),
}));

vi.mock('@/lib/auth-checks', () => ({
  getCurrentUser: getCurrentUserMock,
  verifySiteAccess: verifySiteAccessMock,
}));

vi.mock('@/lib/request-security', () => ({
  isCrossOriginRequest: isCrossOriginMock,
}));

vi.mock('@/lib/observability', () => ({
  observeRoute: (_name: string, fn: () => Promise<Response>) => async () => fn(),
  setLogContext: vi.fn(),
  logEvent: vi.fn(),
  flushLogEvents: vi.fn(),
  errorFields: (err: unknown) => ({ errorName: err instanceof Error ? err.name : 'Error' }),
}));

vi.mock('@/lib/tariff-reattribution', () => ({
  enqueueTariffReattribution: enqueueMock,
  runSiteReattribution: vi.fn(),
}));

vi.mock('@/lib/tariff-timeline-repo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tariff-timeline-repo')>();
  return {
    ...actual,
    TariffTimelineRepo: class {
      createReferencePeriod = createReferencePeriodMock;
    },
  };
});

import { POST } from './route';
import { TariffNotFoundError } from '@/lib/tariff-timeline-repo';
import { TariffValidationError } from '@/lib/tariff-timeline';

const timelineStub = {
  version: 2 as const,
  siteId: 'site-1',
  timezone: 'America/Chicago',
  currency: 'USD',
  periods: [],
  referencePeriods: [],
  battery: null,
  reattribution: null,
  holidayDates: ['2026-01-01'],
  teslaSync: {
    latestTariffId: 10,
    latestTariffName: 'We Energies',
    latestUpdatedAt: '2026-01-01T00:00:00.000Z',
    differsFromActiveManual: false,
  },
};

describe('POST /api/site/[id]/tariffs/reference', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isCrossOriginMock.mockReturnValue(false);
    getCurrentUserMock.mockResolvedValue({ id: 'u1', email: 'u1@example.com' });
    verifySiteAccessMock.mockResolvedValue(true);
    createReferencePeriodMock.mockResolvedValue(timelineStub);
  });

  it('creates a reference plan without queuing re-attribution', async () => {
    const req = new NextRequest('http://localhost/api/site/site-1/tariffs/reference', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Standard Fixed',
        effectiveFrom: '2024-01-01',
        effectiveTo: null,
        seasons: [],
      }),
    });

    const res = await POST(req, { params: Promise.resolve({ id: 'site-1' }) });
    expect(res.status).toBe(201);
    expect(createReferencePeriodMock).toHaveBeenCalledWith('site-1', 'u1', expect.objectContaining({ name: 'Standard Fixed' }));
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('rejects unauthorised sites', async () => {
    verifySiteAccessMock.mockResolvedValue(false);
    const req = new NextRequest('http://localhost/api/site/site-1/tariffs/reference', {
      method: 'POST',
      body: JSON.stringify({ name: 'Standard Fixed' }),
    });

    const res = await POST(req, { params: Promise.resolve({ id: 'site-1' }) });
    expect(res.status).toBe(401);
    expect(createReferencePeriodMock).not.toHaveBeenCalled();
  });

  it('maps validation and not found errors', async () => {
    createReferencePeriodMock.mockRejectedValueOnce(new TariffValidationError('Bad dates'));
    const req1 = new NextRequest('http://localhost/api/site/site-1/tariffs/reference', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    expect((await POST(req1, { params: Promise.resolve({ id: 'site-1' }) })).status).toBe(400);

    createReferencePeriodMock.mockRejectedValueOnce(new TariffNotFoundError('Site not found'));
    const req2 = new NextRequest('http://localhost/api/site/site-1/tariffs/reference', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    expect((await POST(req2, { params: Promise.resolve({ id: 'site-1' }) })).status).toBe(404);
  });
});
