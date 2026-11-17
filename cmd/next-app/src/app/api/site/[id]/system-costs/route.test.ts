import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const {
  getCurrentUserMock,
  verifySiteAccessMock,
  isCrossOriginMock,
  saveSystemCostsMock,
} = vi.hoisted(() => ({
  getCurrentUserMock: vi.fn(),
  verifySiteAccessMock: vi.fn(),
  isCrossOriginMock: vi.fn(),
  saveSystemCostsMock: vi.fn(),
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

vi.mock('@/lib/tariff-timeline-repo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tariff-timeline-repo')>();
  return {
    ...actual,
    TariffTimelineRepo: class {
      saveSystemCosts = saveSystemCostsMock;
    },
  };
});

import { PUT } from './route';
import { TariffNotFoundError } from '@/lib/tariff-timeline-repo';

const timelineStub = {
  version: 2 as const,
  siteId: 'site-1',
  timezone: 'America/Chicago',
  systemCosts: { siteInstalled: '2023-11-14', solar: null, powerwall: null },
};

const validBody = {
  solar: { installDate: '2023-11-14', price: 24000, taxCreditPercent: 30, incentives: 0 },
  powerwall: null,
};

function put(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/site/site-1/system-costs', {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

describe('PUT /api/site/[id]/system-costs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isCrossOriginMock.mockReturnValue(false);
    getCurrentUserMock.mockResolvedValue({ id: 'u1', email: 'u1@example.com' });
    verifySiteAccessMock.mockResolvedValue(true);
    saveSystemCostsMock.mockResolvedValue(timelineStub);
  });

  it('saves costs and returns the timeline', async () => {
    const res = await PUT(put(validBody), { params: Promise.resolve({ id: 'site-1' }) });

    expect(res.status).toBe(200);
    expect(saveSystemCostsMock).toHaveBeenCalledWith('site-1', 'u1', validBody);
    expect(await res.json()).toEqual(timelineStub);
  });

  it('rejects unauthorised sites', async () => {
    verifySiteAccessMock.mockResolvedValue(false);

    const res = await PUT(put(validBody), { params: Promise.resolve({ id: 'site-1' }) });
    expect(res.status).toBe(401);
    expect(saveSystemCostsMock).not.toHaveBeenCalled();
  });

  it('rejects cross-origin requests', async () => {
    isCrossOriginMock.mockReturnValue(true);

    const res = await PUT(put(validBody), { params: Promise.resolve({ id: 'site-1' }) });
    expect(res.status).toBe(403);
    expect(saveSystemCostsMock).not.toHaveBeenCalled();
  });

  it('maps validation errors to 400 without saving', async () => {
    const res = await PUT(put({ solar: { ...validBody.solar, price: -5 }, powerwall: null }), { params: Promise.resolve({ id: 'site-1' }) });

    expect(res.status).toBe(400);
    expect(saveSystemCostsMock).not.toHaveBeenCalled();
  });

  it('maps a missing site to 404', async () => {
    saveSystemCostsMock.mockRejectedValueOnce(new TariffNotFoundError('Site not found'));

    const res = await PUT(put(validBody), { params: Promise.resolve({ id: 'site-1' }) });
    expect(res.status).toBe(404);
  });
});
