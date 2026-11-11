import { beforeEach, describe, expect, it, vi } from 'vitest';

const { runPendingMock, logEventMock, flushLogEventsMock, setLogContextMock } = vi.hoisted(() => ({
  runPendingMock: vi.fn(),
  logEventMock: vi.fn(),
  flushLogEventsMock: vi.fn(),
  setLogContextMock: vi.fn(),
}));

vi.mock('@/lib/tariff-reattribution', () => ({
  REATTRIBUTION_MAX_TIME_MS: 35_000,
  runPendingReattributionsCron: runPendingMock,
}));

vi.mock('@/lib/observability', () => ({
  observeRoute: (_name: string, fn: (req: Request) => Promise<Response>) => fn,
  logEvent: logEventMock,
  flushLogEvents: flushLogEventsMock,
  setLogContext: setLogContextMock,
  errorFields: (e: unknown) => ({ errorName: e instanceof Error ? e.name : 'Error' }),
}));

vi.mock('@/lib/io-deadline', () => ({
  withIoDeadline: async (_ms: number, fn: () => Promise<unknown>) => fn(),
}));

import { GET, maxDuration } from './route';

function req(auth?: string) {
  return { headers: { get: (k: string) => (k === 'authorization' ? auth ?? null : null) } } as unknown as Request;
}

describe('reattribute-tariffs cron', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('CRON_SECRET', 'cron-secret');
    runPendingMock.mockResolvedValue({
      checked: 1,
      sites: [{ siteId: 'site-a', outcome: 'idle', processedDays: 10, updatedDays: 4 }],
    });
  });

  it('rejects missing or invalid CRON_SECRET with 401', async () => {
    expect((await GET(req('Bearer wrong') as never)).status).toBe(401);
    vi.stubEnv('CRON_SECRET', '');
    expect((await GET(req('Bearer ') as never)).status).toBe(401);
    expect(runPendingMock).not.toHaveBeenCalled();
  });

  it('runs bounded reattribution and emits cron.reattribute-tariffs lifecycle events', async () => {
    const res = await GET(req('Bearer cron-secret') as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      success: true,
      checked: 1,
      sites: [{ siteId: 'site-a', outcome: 'idle', processedDays: 10, updatedDays: 4 }],
    });
    expect(logEventMock).toHaveBeenCalledWith('info', 'cron.reattribute-tariffs.started');
    expect(logEventMock).toHaveBeenCalledWith(
      'info',
      'cron.reattribute-tariffs.completed',
      expect.objectContaining({ checked: 1 })
    );
    expect(flushLogEventsMock).toHaveBeenCalled();
  });

  it('returns 503 without leaking internal error strings on failure', async () => {
    runPendingMock.mockRejectedValueOnce(new Error('secret db string'));
    const res = await GET(req('Bearer cron-secret') as never);
    expect(res.status).toBe(503);
    const bodyText = JSON.stringify(await res.json());
    expect(bodyText).not.toContain('secret db string');
    expect(logEventMock).toHaveBeenCalledWith(
      'error',
      'cron.reattribute-tariffs.failed',
      expect.objectContaining({ error: { errorName: 'Error' } })
    );
  });

  it('stays within Hobby 60 s cap', () => {
    expect(maxDuration).toBe(60);
  });
});
