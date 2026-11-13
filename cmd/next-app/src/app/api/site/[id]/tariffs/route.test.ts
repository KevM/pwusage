import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const {
  afterCallbacks,
  getCurrentUserMock,
  verifySiteAccessMock,
  isCrossOriginMock,
  getTimelineMock,
  createManualPeriodMock,
  updatePeriodMock,
  deleteManualPeriodMock,
  enqueueMock,
  runSiteMock,
  poolQueryMock,
} = vi.hoisted(() => ({
  afterCallbacks: [] as Array<() => Promise<unknown> | unknown>,
  getCurrentUserMock: vi.fn(),
  verifySiteAccessMock: vi.fn(),
  isCrossOriginMock: vi.fn(),
  getTimelineMock: vi.fn(),
  createManualPeriodMock: vi.fn(),
  updatePeriodMock: vi.fn(),
  deleteManualPeriodMock: vi.fn(),
  enqueueMock: vi.fn(),
  runSiteMock: vi.fn(),
  poolQueryMock: vi.fn(),
}));

vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>();
  return {
    ...actual,
    after: (cb: () => Promise<unknown> | unknown) => {
      afterCallbacks.push(cb);
    },
  };
});

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

vi.mock('@/lib/io-deadline', () => ({
  withIoDeadline: async (_ms: number, fn: () => Promise<unknown>) => fn(),
}));

vi.mock('@/lib/tariff-reattribution', () => ({
  REATTRIBUTION_AFTER_MAX_TIME_MS: 6000,
  enqueueTariffReattribution: enqueueMock,
  runSiteReattribution: runSiteMock,
}));

vi.mock('@/lib/db', () => ({
  pool: { query: poolQueryMock },
}));

vi.mock('@/lib/tariff-timeline-repo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tariff-timeline-repo')>();
  return {
    ...actual,
    TariffTimelineRepo: class {
      getTimeline = getTimelineMock;
      createManualPeriod = createManualPeriodMock;
      updatePeriod = updatePeriodMock;
      deleteManualPeriod = deleteManualPeriodMock;
    },
  };
});

import { GET, POST } from './route';
import { DELETE, PATCH } from './[periodId]/route';
import { POST as REATTRIBUTE_POST } from './reattribute/route';
import { TariffNotFoundError } from '@/lib/tariff-timeline-repo';
import { TariffValidationError } from '@/lib/tariff-timeline';

const timelineStub = {
  version: 2 as const,
  siteId: 'site-1',
  timezone: 'America/Chicago',
  currency: 'USD',
  periods: [],
  reattribution: null,
  teslaSync: {
    latestTariffId: 10,
    latestTariffName: 'We Energies',
    latestUpdatedAt: '2026-01-01T00:00:00.000Z',
    differsFromActiveManual: false,
  },
};

const reattributionStub = {
  status: 'pending' as const,
  fromDate: '2026-01-01',
  toDate: '2026-06-30',
  totalDays: 120,
  processedDays: 0,
  updatedDays: 0,
  lastError: null,
  updatedAt: '2026-06-01T00:00:00.000Z',
};

const validPayload = {
  name: 'We Energies Summer',
  effectiveFrom: '2026-01-01',
  effectiveTo: '2026-06-30',
  seasons: [
    {
      name: 'All Year',
      fromMonth: 1,
      toMonth: 12,
      weekdayPeriods: [
        { touName: 'ON_PEAK', fromHour: 9, fromMinute: 0, toHour: 21, toMinute: 0, buyRate: 0.30335, sellRate: 0.04906 },
        { touName: 'OFF_PEAK', fromHour: 21, fromMinute: 0, toHour: 9, toMinute: 0, buyRate: 0.14512, sellRate: 0.0329 },
      ],
      weekendPeriods: [
        { touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.14512, sellRate: 0.0329 },
      ],
    },
  ],
};

describe('tariff timeline API routes', () => {
  beforeEach(() => {
    afterCallbacks.length = 0;
    vi.clearAllMocks();
    getCurrentUserMock.mockResolvedValue({ id: 'user-1' });
    verifySiteAccessMock.mockResolvedValue(true);
    isCrossOriginMock.mockReturnValue(false);
    getTimelineMock.mockResolvedValue(timelineStub);
    createManualPeriodMock.mockResolvedValue(timelineStub);
    updatePeriodMock.mockResolvedValue({
      timeline: timelineStub,
      affectedRange: { fromDate: '2026-01-01', toDate: '2026-06-30' },
    });
    deleteManualPeriodMock.mockResolvedValue({
      timeline: timelineStub,
      removedRange: { fromDate: '2026-01-01', toDate: '2026-06-30' },
    });
    enqueueMock.mockResolvedValue(reattributionStub);
    runSiteMock.mockResolvedValue({ outcome: 'idle', processedDays: 10, updatedDays: 10 });
    poolQueryMock.mockResolvedValue({ rows: [] });
  });

  it('GET returns 401 when unauthenticated or unauthorized', async () => {
    getCurrentUserMock.mockResolvedValueOnce(null);
    const res1 = await GET(new NextRequest('https://app.test/api/site/site-1/tariffs'), {
      params: Promise.resolve({ id: 'site-1' }),
    });
    expect(res1.status).toBe(401);

    verifySiteAccessMock.mockResolvedValueOnce(false);
    const res2 = await GET(new NextRequest('https://app.test/api/site/site-1/tariffs'), {
      params: Promise.resolve({ id: 'site-1' }),
    });
    expect(res2.status).toBe(401);
    expect(getTimelineMock).not.toHaveBeenCalled();
  });

  it('GET returns SiteTariffsTimelineResponse v2', async () => {
    const res = await GET(new NextRequest('https://app.test/api/site/site-1/tariffs'), {
      params: Promise.resolve({ id: 'site-1' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store, max-age=0');
    expect(await res.json()).toEqual(timelineStub);
    expect(getTimelineMock).toHaveBeenCalledWith('site-1', 'user-1');
  });

  it('POST / PATCH / DELETE / reattribute reject cross-origin requests with 403', async () => {
    isCrossOriginMock.mockReturnValue(true);

    const postRes = await POST(
      new NextRequest('https://app.test/api/site/site-1/tariffs', { method: 'POST', body: '{}' }),
      { params: Promise.resolve({ id: 'site-1' }) }
    );
    expect(postRes.status).toBe(403);

    const patchRes = await PATCH(
      new NextRequest('https://app.test/api/site/site-1/tariffs/5', { method: 'PATCH', body: '{}' }),
      { params: Promise.resolve({ id: 'site-1', periodId: '5' }) }
    );
    expect(patchRes.status).toBe(403);

    const delRes = await DELETE(
      new NextRequest('https://app.test/api/site/site-1/tariffs/5', { method: 'DELETE' }),
      { params: Promise.resolve({ id: 'site-1', periodId: '5' }) }
    );
    expect(delRes.status).toBe(403);

    const reattrRes = await REATTRIBUTE_POST(
      new NextRequest('https://app.test/api/site/site-1/tariffs/reattribute', { method: 'POST', body: '{}' }),
      { params: Promise.resolve({ id: 'site-1' }) }
    );
    expect(reattrRes.status).toBe(403);
    expect(createManualPeriodMock).not.toHaveBeenCalled();
  });

  it('POST returns 400 on TariffValidationError and 201 on valid 5-decimal payload with after() drain', async () => {
    createManualPeriodMock.mockRejectedValueOnce(new TariffValidationError('Missing season coverage'));
    const badRes = await POST(
      new NextRequest('https://app.test/api/site/site-1/tariffs', {
        method: 'POST',
        body: JSON.stringify(validPayload),
      }),
      { params: Promise.resolve({ id: 'site-1' }) }
    );
    expect(badRes.status).toBe(400);
    expect(enqueueMock).not.toHaveBeenCalled();

    const okRes = await POST(
      new NextRequest('https://app.test/api/site/site-1/tariffs', {
        method: 'POST',
        body: JSON.stringify(validPayload),
      }),
      { params: Promise.resolve({ id: 'site-1' }) }
    );
    expect(okRes.status).toBe(201);
    const body = await okRes.json();
    expect(body).toMatchObject({ version: 2 });
    // The job is queued by the repo inside the mutation's transaction, not by the route.
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(afterCallbacks).toHaveLength(1);
    await afterCallbacks[0]();
    expect(runSiteMock).toHaveBeenCalledWith({ siteId: 'site-1', trigger: 'after', maxTimeMs: 6000 });
  });

  it('PATCH and DELETE enforce manual rules (400 on tesla, 404 on missing) and schedule after()', async () => {
    updatePeriodMock.mockRejectedValueOnce(new TariffValidationError('Tesla-synced rate plans only allow adjusting effective dates'));
    const teslaPatch = await PATCH(
      new NextRequest('https://app.test/api/site/site-1/tariffs/9', {
        method: 'PATCH',
        body: JSON.stringify({ name: 'Renamed' }),
      }),
      { params: Promise.resolve({ id: 'site-1', periodId: '9' }) }
    );
    expect(teslaPatch.status).toBe(400);

    deleteManualPeriodMock.mockRejectedValueOnce(new TariffNotFoundError('Rate plan period not found'));
    const missingDel = await DELETE(
      new NextRequest('https://app.test/api/site/site-1/tariffs/999', { method: 'DELETE' }),
      { params: Promise.resolve({ id: 'site-1', periodId: '999' }) }
    );
    expect(missingDel.status).toBe(404);

    deleteManualPeriodMock.mockRejectedValueOnce(new TariffValidationError('Only custom rate plan periods can be deleted'));
    const teslaDel = await DELETE(
      new NextRequest('https://app.test/api/site/site-1/tariffs/2', { method: 'DELETE' }),
      { params: Promise.resolve({ id: 'site-1', periodId: '2' }) }
    );
    expect(teslaDel.status).toBe(400);

    const okDel = await DELETE(
      new NextRequest('https://app.test/api/site/site-1/tariffs/5', { method: 'DELETE' }),
      { params: Promise.resolve({ id: 'site-1', periodId: '5' }) }
    );
    expect(okDel.status).toBe(200);
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(afterCallbacks).toHaveLength(1);
  });

  it('POST /reattribute resets and enqueues reattribution then runs after()', async () => {
    poolQueryMock
      .mockResolvedValueOnce({ rows: [{ timezone: 'America/Chicago' }] })
      .mockResolvedValueOnce({ rows: [{ from_date: '2025-05-01', to_date: null }] });
    const res = await REATTRIBUTE_POST(
      new NextRequest('https://app.test/api/site/site-1/tariffs/reattribute', { method: 'POST', body: '{}' }),
      { params: Promise.resolve({ id: 'site-1' }) }
    );
    expect(res.status).toBe(200);
    expect(enqueueMock).toHaveBeenCalledWith({
      siteId: 'site-1',
      fromDate: '2025-05-01',
      toDate: null,
      requestedByUserId: 'user-1',
      trigger: 'retry',
    });
    expect(afterCallbacks).toHaveLength(1);
  });
});
