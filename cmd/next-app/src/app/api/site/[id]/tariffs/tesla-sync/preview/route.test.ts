import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  verifySiteAccess: vi.fn(),
  isCrossOriginRequest: vi.fn(),
  previewTeslaSync: vi.fn(),
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

vi.mock('@/lib/tesla-tariff-sync-service', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/tesla-tariff-sync-service')>(),
  previewTeslaSync: mocks.previewTeslaSync,
}));

import { POST } from './route';
import { TeslaSyncUnavailableError } from '@/lib/tesla-tariff-sync-service';

const context = { params: Promise.resolve({ id: 'site-1' }) };

const post = () =>
  new NextRequest('https://app.test/api/site/site-1/tariffs/tesla-sync/preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });

const previewStub = {
  fingerprint: 'a'.repeat(64),
  current: { name: 'Tesla Plan', seasons: [] },
  proposed: { name: 'PWUsage Plan', seasons: [], source: 'manual', selectionId: 7 },
  adjustments: [],
  problems: [],
  estimated: false,
};

describe('POST /api/site/[id]/tariffs/tesla-sync/preview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isCrossOriginRequest.mockReturnValue(false);
    mocks.getCurrentUser.mockResolvedValue({ id: 'user-1' });
    mocks.verifySiteAccess.mockResolvedValue(true);
    mocks.previewTeslaSync.mockResolvedValue(previewStub);
  });

  it('enforces auth, site isolation, and cross-origin protection', async () => {
    mocks.getCurrentUser.mockResolvedValueOnce(null);
    expect((await POST(post(), context)).status).toBe(401);

    mocks.verifySiteAccess.mockResolvedValueOnce(false);
    expect((await POST(post(), context)).status).toBe(401);

    mocks.isCrossOriginRequest.mockReturnValueOnce(true);
    expect((await POST(post(), context)).status).toBe(403);
    expect(mocks.previewTeslaSync).not.toHaveBeenCalled();
  });

  it('returns the preview for the signed-in member', async () => {
    const res = await POST(post(), context);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store, max-age=0');
    expect(await res.json()).toEqual(previewStub);
    expect(mocks.previewTeslaSync).toHaveBeenCalledWith('site-1', 'user-1');
  });

  it('turns every unavailable reason into a 409 with the reason and message', async () => {
    const reasons = [
      'no_active_plan',
      'no_difference',
      'not_tou_capable',
      'no_tesla_plan',
      'needs_reauth',
      'tesla_unavailable',
      'not_allowed',
    ] as const;
    for (const reason of reasons) {
      const error = new TeslaSyncUnavailableError(reason);
      mocks.previewTeslaSync.mockRejectedValueOnce(error);
      const res = await POST(post(), context);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'unavailable', reason, message: error.message });
    }
  });

  it('lets unexpected errors fall through to a 500', async () => {
    mocks.previewTeslaSync.mockRejectedValueOnce(new Error('boom'));
    expect((await POST(post(), context)).status).toBe(500);
  });
});
