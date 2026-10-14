import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TeslaClient } from './tesla-client';
import { withIoDeadline } from './io-deadline';
describe('Tesla transport deadlines', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  it('passes an abort signal to a hung Fleet request', async () => {
    let signal: AbortSignal | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, options) => { signal = options?.signal ?? undefined; return new Promise(() => {}); });
    const pending = withIoDeadline(1000, () => new TeslaClient('token').getProducts());
    const assertion = expect(pending).rejects.toThrow('deadline');
    await vi.advanceTimersByTimeAsync(1000); await assertion;
    expect(signal?.aborted).toBe(true);
  });
  it('bounds Retry-After and never sends the retry once the budget expires', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 429, headers: { 'Retry-After': '60' } }));
    const pending = withIoDeadline(1000, () => new TeslaClient('token').getProducts());
    const assertion = expect(pending).rejects.toThrow('deadline');
    await vi.advanceTimersByTimeAsync(1000); await assertion;
    await vi.advanceTimersByTimeAsync(60000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('bounds the token refresh handler and suppresses a late Fleet retry', async () => {
    let finish: ((tokens: { access_token: string; refresh_token: string }) => void) | undefined;
    const refresh = vi.fn(() => new Promise<{ access_token: string; refresh_token: string }>(resolve => { finish = resolve; }));
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 401 }));
    const client = new TeslaClient({ accessToken: 'old', refreshToken: 'refresh', tokenRefreshHandler: refresh });
    const pending = withIoDeadline(1000, () => client.getProducts());
    const assertion = expect(pending).rejects.toThrow('deadline');
    await vi.advanceTimersByTimeAsync(1000); await assertion;
    finish?.({ access_token: 'new', refresh_token: 'new-refresh' }); await vi.runAllTimersAsync();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('preserves a transport failure after refreshing instead of reporting the original 401 rejection', async () => {
    const transportError = new Error('Connection lost after command was sent');
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }))
      .mockRejectedValueOnce(transportError);
    const client = new TeslaClient({ accessToken: 'old', refreshToken: 'refresh',
      tokenRefreshHandler: async () => ({ access_token: 'new', refresh_token: 'new-refresh' }) });
    await expect(client.setBackupReserve('s', 20)).rejects.toBe(transportError);
  });
  it('bounds response body consumption, not just response headers', async () => {
    const body = new ReadableStream({ start() {} });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body));
    const pending = withIoDeadline(1000, () => new TeslaClient('token').getProducts());
    const assertion = expect(pending).rejects.toThrow('deadline');
    await vi.advanceTimersByTimeAsync(1000); await assertion;
  });
});
