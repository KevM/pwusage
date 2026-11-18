import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  afterCallbacks: [] as Array<() => Promise<unknown>>,
  runUrdbEstimatesForSite: vi.fn(),
  logEvent: vi.fn(),
  flushLogEvents: vi.fn(),
}));

vi.mock('next/server', () => ({
  after: (callback: () => Promise<unknown>) => { mocks.afterCallbacks.push(callback); },
}));
vi.mock('./estimate-job', () => ({ runUrdbEstimatesForSite: mocks.runUrdbEstimatesForSite }));
vi.mock('../observability', () => ({
  logEvent: mocks.logEvent,
  flushLogEvents: mocks.flushLogEvents,
  errorFields: (error: unknown) => ({ message: String(error) }),
}));

import { startPendingEstimates } from './start-estimates';

const timeline = (status: string | null) => ({ estimates: status === null ? undefined : { status } }) as never;

describe('startPendingEstimates', () => {
  beforeEach(() => {
    mocks.afterCallbacks.length = 0;
    vi.clearAllMocks();
    vi.stubEnv('OPENEI_API_KEY', 'test-key');
  });

  it('runs the estimate for a pending site after the response, once', async () => {
    mocks.runUrdbEstimatesForSite.mockResolvedValue({ status: 'ready', changedDays: 12 });
    startPendingEstimates('site-1', timeline('pending'));
    expect(mocks.runUrdbEstimatesForSite).not.toHaveBeenCalled();
    expect(mocks.afterCallbacks).toHaveLength(1);
    await mocks.afterCallbacks[0]();
    expect(mocks.runUrdbEstimatesForSite).toHaveBeenCalledTimes(1);
    expect(mocks.runUrdbEstimatesForSite.mock.calls[0][0]).toBe('site-1');
    expect(mocks.flushLogEvents).toHaveBeenCalled();
  });

  it.each([['ready'], ['needs_utility'], ['needs_plan'], ['skipped'], ['failed'], [null]])(
    'does nothing when estimates are %s',
    status => {
      startPendingEstimates('site-1', timeline(status));
      expect(mocks.afterCallbacks).toHaveLength(0);
    }
  );

  it('does nothing without an OpenEI key, as the scheduled job does', () => {
    vi.stubEnv('OPENEI_API_KEY', '');
    startPendingEstimates('site-1', timeline('pending'));
    expect(mocks.afterCallbacks).toHaveLength(0);
  });

  it('logs a failed run and leaves the retry to the scheduled job', async () => {
    mocks.runUrdbEstimatesForSite.mockRejectedValue(new Error('OpenEI down'));
    startPendingEstimates('site-1', timeline('pending'));
    await expect(mocks.afterCallbacks[0]()).resolves.toBeUndefined();
    expect(mocks.logEvent).toHaveBeenCalledWith('warn', 'urdb.estimates.after_failed', expect.anything());
    expect(mocks.flushLogEvents).toHaveBeenCalled();
  });
});
