import { TeslaRefreshError } from './tesla-refresh-outcome';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SiteRepo } from './site-repo';

beforeEach(() => { vi.resetModules(); vi.useFakeTimers(); });
afterEach(() => { vi.doUnmock('pg'); vi.doUnmock('./tesla-auth'); vi.useRealTimers(); vi.restoreAllMocks(); });

async function setup(terminal = false, hungCleanup = false) {
  const parent = new AbortController();
  const queries: string[] = [];
  const query = vi.fn(async (sql: string) => {
    queries.push(sql);
    if (hungCleanup && sql.includes('SET is_refreshing = 0')) return new Promise<never>(() => {});
    return { rows: sql.includes('SET is_refreshing = 1')
      ? [{ access_token: 'access', refresh_token: 'refresh' }] : [], rowCount: 1 };
  });
  const release = vi.fn();
  vi.doMock('pg', () => ({ Pool: class {
    on() {} setMaxListeners() {} query = query;
    connect = async () => ({ query, release });
  } }));
  const { abortable, withIoDeadline } = await import('./io-deadline');
  vi.doMock('./tesla-auth', async () => ({ ...await vi.importActual<typeof import('./tesla-auth')>('./tesla-auth'), refreshAccessToken: async () => {
    if (terminal) {
      parent.abort(new Error('Parent cancelled'));
      throw new TeslaRefreshError('credential_rejected');
    }
    return abortable(new Promise<never>(() => {}));
  } }));
  const { TeslaTokenRepo } = await import('./tesla-token-repo');
  const { SiteRepo } = await import('./site-repo');
  const siteRepo = new SiteRepo();
  vi.spyOn(siteRepo, 'getSite').mockResolvedValue({ user_id: 'u' } as Awaited<ReturnType<SiteRepo['getSite']>>);
  vi.spyOn(siteRepo, 'invalidateCache').mockImplementation(() => {});
  const handler = new TeslaTokenRepo(siteRepo).getLockedRefreshHandler('s').refreshHandler;
  // Keep a handle to the underlying handler: the outer deadline may reject
  // before its finally block finishes cleaning up.
  let handlerFinished: Promise<unknown> = Promise.resolve();
  const pending = withIoDeadline(100, () => {
    handlerFinished = handler('refresh').catch(error => error);
    return handlerFinished;
  }, parent.signal).catch(error => error);
  await vi.advanceTimersByTimeAsync(100);
  await pending;
  return { queries, release, finished: () => handlerFinished };
}

it('releases the refresh lock through the real database wrapper after the parent deadline expires', async () => {
  const { queries, finished } = await setup();
  await vi.advanceTimersByTimeAsync(18000);
  await finished();
  expect(queries.some(sql => sql.includes('SET is_refreshing = 0'))).toBe(true);
});

it('atomically revokes and releases after terminal failure even when the parent was cancelled', async () => {
  const { queries, finished } = await setup(true);
  await finished();
  expect(queries.some(sql => sql.includes('SET is_refreshing = 0') && sql.includes('tesla_refresh_state = $4'))).toBe(true);
});

it('bounds cleanup independently when its database query hangs', async () => {
  const { queries, release, finished } = await setup(false, true);
  // 18 s exchange + 5 s outcome write + 1 s cleanup, each bounded on its own.
  await vi.advanceTimersByTimeAsync(25000);
  await finished();
  expect(queries.some(sql => sql.includes('SET is_refreshing = 0'))).toBe(true);
  expect(release).toHaveBeenCalledWith(true);
});
