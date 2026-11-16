import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { runCron, withDeadline } = vi.hoisted(() => ({ runCron: vi.fn(), withDeadline: vi.fn() }));
vi.mock('@/lib/urdb/estimate-job', () => ({ runUrdbEstimatesCron: runCron }));
vi.mock('@/lib/io-deadline', () => ({ withIoDeadline: withDeadline }));
vi.mock('@/lib/observability', () => ({
  observeRoute: (_name: string, handler: (request: NextRequest) => Promise<Response>) => handler,
  errorFields: (error: unknown) => ({ error: error instanceof Error ? error.message : 'unknown' }),
  flushLogEvents: vi.fn(),
  logEvent: vi.fn(),
  setLogContext: vi.fn(),
}));

import { GET, maxDuration } from './route';

describe('URDB estimates cron route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('CRON_SECRET', 'secret');
    withDeadline.mockImplementation((_ms: number, action: () => Promise<unknown>) => action());
    runCron.mockResolvedValue({ checked: 2, sites: [{ siteId: 'site-1', status: 'ready' }] });
  });

  it('rejects requests without the cron secret', async () => {
    const response = await GET(new NextRequest('https://app.test/api/cron/urdb-estimates'));
    expect(response.status).toBe(401);
    expect(runCron).not.toHaveBeenCalled();
  });

  it('runs within the route budget and caps the number of sites', async () => {
    const response = await GET(new NextRequest('https://app.test/api/cron/urdb-estimates', {
      headers: { authorization: 'Bearer secret' },
    }));

    expect(response.status).toBe(200);
    expect(maxDuration).toBe(60);
    expect(withDeadline).toHaveBeenCalledWith(50_000, expect.any(Function));
    expect(runCron).toHaveBeenCalledWith({ maxTimeMs: 40_000, maxSites: 5 });
  });

  it('returns 503 when the runner fails', async () => {
    runCron.mockRejectedValueOnce(new Error('database unavailable'));
    const response = await GET(new NextRequest('https://app.test/api/cron/urdb-estimates', {
      headers: { authorization: 'Bearer secret' },
    }));
    expect(response.status).toBe(503);
  });
});
