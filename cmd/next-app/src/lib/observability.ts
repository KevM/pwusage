import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { AxiomWithoutBatching } from '@axiomhq/js';
import { after } from 'next/server';

type Level = 'info' | 'warn' | 'error';
type Fields = Record<string, unknown>;
interface LogScope {
    context: Fields;
    events: Fields[];
    scheduled: boolean;
    count: number;
}
const scopes = new AsyncLocalStorage<LogScope>();
const MAX_EVENTS = 200;
const SENSITIVE_KEY = /token|secret|password|authorization|cookie|email|payload|body|headers|nonce|^sub$|^state$/i;

/** Errors may contain credentials or upstream response bodies. Export only diagnostic codes. */
function safeValue(value: unknown, depth = 0): unknown {
    if (depth > 4) return '[omitted]';
    if (value instanceof Error) {
        const details = value as Error & { code?: unknown; status?: unknown; cause?: unknown };
        return safeValue({ name: value.name, code: details.code, status: details.status, cause: details.cause }, depth + 1);
    }
    if (Array.isArray(value)) return value.slice(0, 30).map(item => safeValue(item, depth + 1));
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).slice(0, 30).map(([key, item]) => [
            key, SENSITIVE_KEY.test(key) ? '[redacted]' : safeValue(item, depth + 1),
        ]));
    }
    if (typeof value === 'string') {
        return value.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
            .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted]')
            .slice(0, 1000);
    }
    if (typeof value === 'bigint') return value.toString();
    return value;
}

function configured(): boolean {
    return process.env.VERCEL_ENV === 'production'
        && !!process.env.AXIOM_TOKEN?.trim() && !!process.env.AXIOM_DATASET?.trim();
}

async function send(scope: LogScope): Promise<void> {
    // Clear the flag before awaiting: events from concurrent after() work need their own flush.
    scope.scheduled = false;
    const events = scope.events.splice(0);
    if (!events.length || !configured()) return;
    try {
        const deadline = AbortSignal.timeout(2500);
        let deliveryFailed = false;
        const client = new AxiomWithoutBatching({
            token: process.env.AXIOM_TOKEN!.trim(),
            onError: () => { deliveryFailed = true; },
            fetch: (input, init) => fetch(input, {
                ...init,
                signal: init?.signal ? AbortSignal.any([deadline, init.signal]) : deadline,
            }),
        });
        const result = await client.ingest(process.env.AXIOM_DATASET!.trim(), events);
        if (deliveryFailed) {
            console.warn('[Observability] Axiom delivery failed; events remain in runtime logs', { count: events.length });
        } else if (result.failed > 0) {
            console.warn('[Observability] Axiom rejected events', { count: result.failed });
        }
    } catch {
        // Never recurse into logEvent or expose Axiom errors (which can include response bodies).
        console.warn('[Observability] Axiom delivery failed; events remain in runtime logs', { count: events.length });
    }
}

/**
 * Start a bounded checkpoint now, retaining after() as its lifecycle owner.
 * Long cron jobs otherwise lose every buffered event if the platform terminates
 * the invocation before a response. No wait is added to the business operation.
 */
export function flushLogEvents(): void {
    const scope = scopes.getStore();
    if (!scope?.events.length || !configured()) return;
    const pending = send(scope);
    try {
        after(() => pending);
    } catch {
        // send() catches transport errors itself. A missing lifecycle must not
        // turn a diagnostic checkpoint into an authentication failure.
        console.warn('[Observability] Checkpoint lifecycle unavailable; delivery is best effort');
    }
}

/** Use fixed event names and explicit fields; never pass request objects or raw upstream bodies. */
export function logEvent(level: Level, event: string, fields: Fields = {}): void {
    const scope = scopes.getStore();
    const safeFields = safeValue(fields) as Fields;
    const entry = {
        ...scope?.context,
        ...safeFields,
        _time: new Date().toISOString(), level, event,
        service: 'pwusage', environment: process.env.VERCEL_ENV ?? 'development',
        deployment: process.env.VERCEL_DEPLOYMENT_ID,
        commit: process.env.VERCEL_GIT_COMMIT_SHA,
    };
    console[level](event, entry);
    // Unobserved callers (e.g. maintenance scripts) keep console logging only.
    if (!scope || !configured() || scope.count >= MAX_EVENTS) return;
    scope.count += 1;
    scope.events.push(entry);
    if (!scope.scheduled) {
        scope.scheduled = true;
        try {
            // Nested after() is supported: background refresh logs are also lifecycle-bound.
            after(() => send(scope));
        } catch {
            scope.scheduled = false;
            scope.events.length = 0;
            console.warn('[Observability] No request lifecycle available; using runtime logs only');
        }
    }
}

export function setLogContext(fields: { siteId: string } | { siteIds: string[] }): void {
    const scope = scopes.getStore();
    if (!scope) return;
    if ('siteId' in fields) {
        scope.context.siteId = fields.siteId;
    } else {
        const siteIds = [...new Set(fields.siteIds)];
        scope.context.siteIds = siteIds.slice(0, 100);
        scope.context.siteCount = siteIds.length;
        if (siteIds.length === 1) scope.context.siteId = siteIds[0];
        else delete scope.context.siteId;
    }
}

type SessionRejection = 'missing-cookie' | 'invalid-session' | 'expired-session'
    | 'missing-account' | 'inactive-account' | 'revoked-session' | 'site-not-assigned';

/** Fixed reasons and the same account fingerprint used by Tesla refresh events. */
export function logSessionRejection(reason: SessionRejection, userId?: string): void {
    logEvent('info', 'auth.session.rejected', {
        reason, ...(userId ? { accountId: createHash('sha256').update(userId).digest('hex').slice(0, 16) } : {}),
    });
}

/** Server pages need a scope too: route-handler scopes do not cover rendering. */
export function observePage<A extends unknown[], R>(route: string, handler: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
    return async (...args) => {
        if (scopes.getStore()) return handler(...args);
        const scope: LogScope = {
            context: { route, method: 'RENDER', requestId: randomUUID() },
            events: [], scheduled: false, count: 0,
        };
        return scopes.run(scope, async () => {
            const start = Date.now();
            try {
                const result = await handler(...args);
                logEvent('info', 'page.completed', { durationMs: Date.now() - start });
                return result;
            } catch (error) {
                const redirect = error && typeof error === 'object' && 'digest' in error
                    && typeof error.digest === 'string' && error.digest.startsWith('NEXT_REDIRECT;');
                logEvent(redirect ? 'info' : 'error', redirect ? 'page.redirected' : 'page.failed', {
                    durationMs: Date.now() - start, ...(redirect ? {} : { error }),
                });
                throw error;
            }
        });
    };
}

export function observeRoute<T extends Request, R extends Response>(
    route: string, handler: (request: T) => Promise<R>,
): (request: T) => Promise<R> {
    return async request => {
        // POST markup delegates to GET. Preserve one correlation id for the whole request.
        if (scopes.getStore()) return handler(request);
        const scope: LogScope = {
            context: { route, method: request.method, requestId: randomUUID() },
            events: [], scheduled: false, count: 0,
        };
        return scopes.run(scope, async () => {
            const start = Date.now();
            try {
                const response = await handler(request);
                logEvent(response.status >= 500 ? 'error' : response.status >= 400 ? 'warn' : 'info',
                    'request.completed', { status: response.status, durationMs: Date.now() - start });
                return response;
            } catch (error) {
                // Next.js redirects throw a control-flow exception; never log the redirect URL.
                const redirect = error && typeof error === 'object' && 'digest' in error
                    && typeof error.digest === 'string' && error.digest.startsWith('NEXT_REDIRECT;');
                logEvent(redirect ? 'info' : 'error', redirect ? 'request.redirected' : 'request.failed',
                    { durationMs: Date.now() - start, ...(redirect ? {} : { error }) });
                throw error;
            }
        });
    };
}
