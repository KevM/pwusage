import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const {
  access,
  getCurrentUserMock,
  isCrossOriginMock,
  createClient,
  ensureSite,
  getTimelineMock,
} = vi.hoisted(() => ({
  access: vi.fn(),
  getCurrentUserMock: vi.fn(),
  isCrossOriginMock: vi.fn(),
  createClient: vi.fn(),
  ensureSite: vi.fn(),
  getTimelineMock: vi.fn(),
}));

vi.mock('@/lib/auth-checks', () => ({
  verifySiteAccess: access,
  getCurrentUser: getCurrentUserMock,
}));
vi.mock('@/lib/request-security', () => ({ isCrossOriginRequest: isCrossOriginMock }));
vi.mock('@/lib/observability', () => ({
  observeRoute: (_name: string, fn: (req: NextRequest) => Promise<Response>) => fn,
  setLogContext: vi.fn(),
  errorFields: (e: unknown) => ({ errorName: e instanceof Error ? e.name : 'Error' }),
}));
vi.mock('@/lib/tesla-client-factory', () => ({ createTeslaClientForSite: createClient }));
vi.mock('@/lib/importer', () => ({ Importer: class { ensureSite = ensureSite; } }));
vi.mock('@/lib/tariff-timeline-repo', () => ({
  TariffTimelineRepo: class {
    getTimeline = getTimelineMock;
  },
}));

import * as routeModule from './route';
import { POST } from './route';

const timelineBefore = {
  version: 2 as const,
  siteId: 'a',
  timezone: 'America/Chicago',
  currency: 'USD',
  periods: [],
  reattribution: null,
  teslaSync: {
    latestTariffId: 1,
    latestTariffName: 'Winter',
    latestUpdatedAt: '2026-01-01T00:00:00Z',
    differsFromActiveManual: false,
  },
};

const timelineAfter = {
  ...timelineBefore,
  teslaSync: {
    ...timelineBefore.teslaSync,
    latestTariffId: 2,
    latestUpdatedAt: '2026-06-01T00:00:00Z',
  },
};

const context = { params: Promise.resolve({ id: 'a' }) };

describe('refresh-tariffs v2 POST route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    access.mockResolvedValue(true);
    getCurrentUserMock.mockResolvedValue({ id: 'user-1' });
    isCrossOriginMock.mockReturnValue(false);
    createClient.mockResolvedValue({});
    ensureSite.mockResolvedValue({ id: 'a', tariffs: [{ id: 2 }] });
    getTimelineMock.mockResolvedValueOnce(timelineBefore).mockResolvedValueOnce(timelineAfter);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('retires GET in favor of GET /api/site/[id]/tariffs', () => {
    expect('GET' in routeModule).toBe(false);
  });

  it('rejects cross-origin POST with 403 before checking auth or contacting Tesla', async () => {
    isCrossOriginMock.mockReturnValue(true);
    const res = await POST(new NextRequest('https://example.test/api/site/a/refresh-tariffs', { method: 'POST' }), context);
    expect(res.status).toBe(403);
    expect(createClient).not.toHaveBeenCalled();
  });

  it('checks site access before contacting Tesla', async () => {
    access.mockResolvedValue(false);
    const res = await POST(new NextRequest('https://example.test/api/site/a/refresh-tariffs', { method: 'POST' }), context);
    expect(res.status).toBe(403);
    expect(createClient).not.toHaveBeenCalled();
  });

  it('refreshes from Tesla and returns updatedFromTesla + timeline v2', async () => {
    const res = await POST(new NextRequest('https://example.test/api/site/a/refresh-tariffs', { method: 'POST' }), context);
    expect(res.status).toBe(200);
    expect(ensureSite).toHaveBeenCalledWith('a');
    expect(await res.json()).toEqual({
      success: true,
      message: 'Rate plan refreshed',
      updatedFromTesla: true,
      timeline: timelineAfter,
    });
  });
});
