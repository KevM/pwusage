import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as delay } from 'node:timers/promises';

// Request-local context reaches nested repositories, token refresh and importers.
// A race alone cannot cancel a write: callers must persist uncertain outcomes.
export class IoDeadlineError extends Error {
  readonly code = 'IO_DEADLINE_EXCEEDED';
  constructor() { super('I/O deadline exceeded'); this.name = 'IoDeadlineError'; }
}

/** Allowlisted diagnostics only: arbitrary cancellation reasons may contain secrets.
 * Detached work must disable inheritCaller when classifying outside its own context.
 */
export function ioFailureDetails(error: unknown, signal?: AbortSignal, inheritCaller = true) {
  const caller = inheritCaller ? ioSignal() : undefined;
  const reason: unknown = caller?.aborted ? caller.reason : signal?.aborted ? signal.reason : error;
  return {
    cancellationSource: caller?.aborted ? 'caller' : signal?.aborted ? 'endpoint' : 'none',
    failureCode: reason instanceof IoDeadlineError ? reason.code
      : reason instanceof Error && reason.name === 'TimeoutError' ? 'REQUEST_TIMEOUT'
      : caller?.aborted || signal?.aborted ? 'REQUEST_CANCELLED' : 'EXCHANGE_ERROR',
  };
}
const context = new AsyncLocalStorage<AbortSignal>();
export function ioSignal(): AbortSignal | undefined { return context.getStore(); }
export function checkIoDeadline(): void { ioSignal()?.throwIfAborted(); }
export function abortable<T>(promise: Promise<T>, signal = ioSignal()): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) { void promise.catch(() => undefined); return Promise.reject(signal.reason); }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
// Pass null only for bounded cleanup that must survive its parent's cancellation.
export async function withIoDeadline<T>(ms: number, work: () => Promise<T>, parent: AbortSignal | null | undefined = ioSignal()): Promise<T> {
  const controller = new AbortController();
  const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(new IoDeadlineError()), ms);
  try { return await context.run(signal, () => { signal.throwIfAborted(); return abortable(work(), signal); }); }
  finally { clearTimeout(timer); }
}
export async function ioDelay(ms: number): Promise<void> {
  checkIoDeadline();
  await delay(ms, undefined, { signal: ioSignal() });
}
