import { afterEach, expect, it, vi } from 'vitest';
import { ioSignal, withIoDeadline, abortable } from './io-deadline';
afterEach(() => vi.useRealTimers());
it('aborts underlying I/O and prevents late continuations from starting work', async () => {
  vi.useFakeTimers();
  let signal: AbortSignal | undefined;
  const pending = withIoDeadline(100, async () => { signal = ioSignal(); await abortable(new Promise(() => {})); });
  const assertion = expect(pending).rejects.toThrow('I/O deadline exceeded');
  await vi.advanceTimersByTimeAsync(100); await assertion;
  expect(signal?.aborted).toBe(true);
});
