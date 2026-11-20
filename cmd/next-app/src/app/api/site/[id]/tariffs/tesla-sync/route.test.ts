import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  verifySiteAccess: vi.fn(),
  isCrossOriginRequest: vi.fn(),
  commitTeslaSync: vi.fn(),
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
  commitTeslaSync: mocks.commitTeslaSync,
}));

import { POST } from './route';
import type { TeslaSyncOutcome } from '@/lib/tesla-tariff-sync-service';

const context = { params: Promise.resolve({ id: 'site-1' }) };

const post = (body: unknown) =>
  new NextRequest('https://app.test/api/site/site-1/tariffs/tesla-sync', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });

describe('POST /api/site/[id]/tariffs/tesla-sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isCrossOriginRequest.mockReturnValue(false);
    mocks.getCurrentUser.mockResolvedValue({ id: 'user-1' });
    mocks.verifySiteAccess.mockResolvedValue(true);
    mocks.commitTeslaSync.mockResolvedValue({ outcome: 'confirmed' });
  });

  it('enforces auth, site isolation, and cross-origin protection', async () => {
    mocks.getCurrentUser.mockResolvedValueOnce(null);
    expect((await POST(post({ fingerprint: 'fp' }), context)).status).toBe(401);

    mocks.verifySiteAccess.mockResolvedValueOnce(false);
    expect((await POST(post({ fingerprint: 'fp' }), context)).status).toBe(401);

    mocks.isCrossOriginRequest.mockReturnValueOnce(true);
    expect((await POST(post({ fingerprint: 'fp' }), context)).status).toBe(403);
    expect(mocks.commitTeslaSync).not.toHaveBeenCalled();
  });

  it('rejects malformed bodies with a 400 and never commits', async () => {
    expect((await POST(post('{bad json'), context)).status).toBe(400);
    expect((await POST(post({}), context)).status).toBe(400);
    expect((await POST(post({ fingerprint: 42 }), context)).status).toBe(400);
    expect((await POST(post({ fingerprint: '' }), context)).status).toBe(400);
    expect((await POST(post(null), context)).status).toBe(400);
    expect(mocks.commitTeslaSync).not.toHaveBeenCalled();
  });

  it('passes every commit outcome through as a 200 result body', async () => {
    const outcomes: TeslaSyncOutcome[] = [
      'confirmed',
      'unconfirmed',
      'rejected',
      'failed',
      'not_allowed',
      'needs_reauth',
      'conflict',
      'in_flight',
      'unavailable',
    ];
    for (const outcome of outcomes) {
      const result = { outcome, message: `copy for ${outcome}` };
      mocks.commitTeslaSync.mockResolvedValueOnce(result);
      const res = await POST(post({ fingerprint: 'fp-1' }), context);
      expect(res.status).toBe(200);
      expect(res.headers.get('Cache-Control')).toBe('private, no-store, max-age=0');
      expect(await res.json()).toEqual(result);
    }
    expect(mocks.commitTeslaSync).toHaveBeenCalledWith('site-1', 'user-1', 'fp-1');
  });

  it('lets unexpected throws fall through to a 500', async () => {
    mocks.commitTeslaSync.mockRejectedValueOnce(new Error('boom'));
    expect((await POST(post({ fingerprint: 'fp' }), context)).status).toBe(500);
  });
});
