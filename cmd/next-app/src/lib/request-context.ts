import { AsyncLocalStorage } from 'node:async_hooks';
import type { SiteWithTariffs } from './db';

export interface RequestContext {
    siteCache: Map<string, SiteWithTariffs>;
}

const requestContextStorage = new AsyncLocalStorage<RequestContext>();

/**
 * Returns the current request's context. If called outside of `withRequestContext`,
 * returns a throwaway context with a fresh Map (writes are not persisted).
 */
export function getRequestContext(): RequestContext {
    const ctx = requestContextStorage.getStore();
    if (ctx) return ctx;
    return { siteCache: new Map() };
}

/**
 * Runs `fn` inside a fresh request context. Any nested `getRequestContext()`
 * calls (including across awaits) will see the same `siteCache` map.
 */
export async function withRequestContext<T>(fn: () => Promise<T>): Promise<T> {
    const ctx: RequestContext = { siteCache: new Map() };
    return requestContextStorage.run(ctx, fn);
}
