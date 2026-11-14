import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const {
  getCurrentUserMock,
  verifySiteAccessMock,
  isCrossOriginMock,
  updateReferencePeriodMock,
  deleteReferencePeriodMock,
  enqueueMock,
} = vi.hoisted(() => ({
  getCurrentUserMock: vi.fn(),
  verifySiteAccessMock: vi.fn(),
  isCrossOriginMock: vi.fn(),
  updateReferencePeriodMock: vi.fn(),
  deleteReferencePeriodMock: vi.fn(),
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
      updateReferencePeriod = updateReferencePeriodMock;
      deleteReferencePeriod = deleteReferencePeriodMock;
    },
  };
});

import { DELETE, PATCH } from './route';
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

describe('PATCH / DELETE /api/site/[id]/tariffs/reference/[periodId]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isCrossOriginMock.mockReturnValue(false);
    getCurrentUserMock.mockResolvedValue({ id: 'u1', email: 'u1@example.com' });
    verifySiteAccessMock.mockResolvedValue(true);
    updateReferencePeriodMock.mockResolvedValue(timelineStub);
    deleteReferencePeriodMock.mockResolvedValue(timelineStub);
  });

  it('updates and deletes a reference period without queuing re-attribution', async () => {
    const patchReq = new NextRequest('http://localhost/api/site/site-1/tariffs/reference/7', {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Updated Fixed' }),
    });
    const patchRes = await PATCH(patchReq, { params: Promise.resolve({ id: 'site-1', periodId: '7' }) });
    expect(patchRes.status).toBe(200);
    expect(updateReferencePeriodMock).toHaveBeenCalledWith('site-1', 'u1', 7, { name: 'Updated Fixed' });

    const delReq = new NextRequest('http://localhost/api/site/site-1/tariffs/reference/7', {
      method: 'DELETE',
    });
    const delRes = await DELETE(delReq, { params: Promise.resolve({ id: 'site-1', periodId: '7' }) });
    expect(delRes.status).toBe(200);
    expect(deleteReferencePeriodMock).toHaveBeenCalledWith('site-1', 7, 'u1');
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('rejects unauthorised sites and invalid period ids', async () => {
    verifySiteAccessMock.mockResolvedValueOnce(false);
    const unauthReq = new NextRequest('http://localhost/api/site/site-1/tariffs/reference/7', {
      method: 'DELETE',
    });
    expect((await DELETE(unauthReq, { params: Promise.resolve({ id: 'site-1', periodId: '7' }) })).status).toBe(401);

    const badIdReq = new NextRequest('http://localhost/api/site/site-1/tariffs/reference/abc', {
      method: 'PATCH',
      body: JSON.stringify({}),
    });
    expect((await PATCH(badIdReq, { params: Promise.resolve({ id: 'site-1', periodId: 'abc' }) })).status).toBe(400);
  });

  it('maps validation and not found errors', async () => {
    updateReferencePeriodMock.mockRejectedValueOnce(new TariffValidationError('Bad input'));
    const req1 = new NextRequest('http://localhost/api/site/site-1/tariffs/reference/7', {
      method: 'PATCH',
      body: JSON.stringify({}),
    });
    expect((await PATCH(req1, { params: Promise.resolve({ id: 'site-1', periodId: '7' }) })).status).toBe(400);

    deleteReferencePeriodMock.mockRejectedValueOnce(new TariffNotFoundError('Missing'));
    const req2 = new NextRequest('http://localhost/api/site/site-1/tariffs/reference/7', {
      method: 'DELETE',
    });
    expect((await DELETE(req2, { params: Promise.resolve({ id: 'site-1', periodId: '7' }) })).status).toBe(404);
  });
});
