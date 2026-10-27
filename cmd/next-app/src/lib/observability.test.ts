import { after } from 'next/server';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { flushLogEvents, logEvent, observeRoute, setLogContext } from './observability';

const mocks = vi.hoisted(() => ({
    callbacks: [] as Array<() => unknown>,
    ingest: vi.fn(),
    constructor: vi.fn(),
}));
vi.mock('next/server', async importOriginal => {
    const original = await importOriginal<typeof import('next/server')>();
    const { AsyncResource } = await import('node:async_hooks');
    return { ...original, after: vi.fn((callback: () => unknown) => mocks.callbacks.push(AsyncResource.bind(callback))) };
});
vi.mock('@axiomhq/js', () => ({
    AxiomWithoutBatching: class {
        ingest = mocks.ingest;
        constructor(options: unknown) { mocks.constructor(options); }
    },
}));
async function finishResponse() {
    while (mocks.callbacks.length) {
        const callbacks = mocks.callbacks.splice(0);
        await Promise.all(callbacks.map(callback => callback()));
    }
}
function entries(): Array<Record<string, unknown>> {
    return mocks.ingest.mock.calls.flatMap(call => call[1] as Array<Record<string, unknown>>);
}
describe('production observability', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.callbacks.length = 0;
        mocks.ingest.mockResolvedValue({ failed: 0 });
        vi.stubEnv('VERCEL_ENV', 'production');
        vi.stubEnv('AXIOM_TOKEN', 'ingest-secret');
        vi.stubEnv('AXIOM_DATASET', 'pwusage');
        vi.stubEnv('VERCEL_DEPLOYMENT_ID', 'deployment-1');
        vi.spyOn(console, 'info').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

    it('delivers only after the response, with correlation but no query strings or headers', async () => {
        const handler = observeRoute('/test', async () => {
            setLogContext({ siteId: 'site-1' });
            logEvent('info', 'tesla.refresh.succeeded', { attempts: 1 });
            return new Response('unchanged', { status: 201 });
        });
        const response = await handler(new Request('https://example.test/test?code=private', {
            headers: { authorization: 'Bearer private', cookie: 'session=private' },
        }));
        expect(response.status).toBe(201);
        expect(await response.text()).toBe('unchanged');
        expect(mocks.ingest).not.toHaveBeenCalled();
        await finishResponse();
        expect(mocks.ingest).toHaveBeenCalledTimes(1);
        expect(mocks.ingest.mock.calls[0][0]).toBe('pwusage');
        expect(entries()).toHaveLength(2);
        expect(entries()[0]).toMatchObject({ siteId: 'site-1', route: '/test', deployment: 'deployment-1' });
        expect(entries()[1]).toMatchObject({ event: 'request.completed', status: 201 });
        expect(entries()[0].requestId).toBe(entries()[1].requestId);
        expect(JSON.stringify(entries())).not.toContain('private');
    });

    it.each(['preview', 'development'])('keeps %s logs local even with credentials', async environment => {
        vi.stubEnv('VERCEL_ENV', environment);
        await observeRoute('/test', async () => new Response())(new Request('https://example.test'));
        expect(console.info).toHaveBeenCalled();
        expect(mocks.callbacks).toHaveLength(0);
        expect(mocks.constructor).not.toHaveBeenCalled();
    });

    it('exports cron checkpoints before the handler completes and retains later events', async () => {
        let release: () => void = () => {};
        const gate = new Promise<void>(resolve => { release = resolve; });
        const response = observeRoute('/api/cron/check-users', async () => {
            logEvent('info', 'tesla.user-verification.started', { verificationId: 'check-1' });
            flushLogEvents();
            await gate;
            logEvent('warn', 'tesla.user-verification.completed', { verificationId: 'check-1', outcome: 'revoked' });
            return new Response();
        })(new Request('https://example.test'));

        // The handler is still blocked; its first checkpoint has already left.
        expect(entries()).toHaveLength(1);
        expect(entries()[0].event).toBe('tesla.user-verification.started');
        release();
        await response;
        await finishResponse();
        expect(entries().map(entry => entry.event)).toEqual([
            'tesla.user-verification.started', 'tesla.user-verification.completed', 'request.completed',
        ]);
        expect(new Set(entries().map(entry => entry.requestId)).size).toBe(1);
    });

    it.each(['AXIOM_TOKEN', 'AXIOM_DATASET'])('keeps requests working without %s', async key => {
        vi.stubEnv(key, '');
        expect((await observeRoute('/test', async () => new Response())(new Request('https://example.test'))).status).toBe(200);
        expect(mocks.callbacks).toHaveLength(0);
    });

    it('redacts nested credentials and omits raw upstream error messages', async () => {
        const error = Object.assign(new Error('upstream included refresh_token=opaque-secret'), { status: 503, code: 'ETIMEDOUT' });
        const cycle: Record<string, unknown> = {};
        cycle.self = cycle;
        await observeRoute('/test', async () => {
            logEvent('warn', 'tesla.refresh.failed', {
                error, access_token: 'opaque-secret', nested: { clientSecret: 'opaque-secret', email: 'private@example.com' }, cycle,
            });
            return new Response();
        })(new Request('https://example.test'));
        await finishResponse();
        expect(JSON.stringify(entries())).not.toContain('opaque-secret');
        expect(JSON.stringify(entries())).not.toContain('private@example.com');
        expect(entries()[0].error).toMatchObject({ name: 'Error', status: 503, code: 'ETIMEDOUT' });
    });

    it('isolates overlapping requests and captures logs from after work', async () => {
        let unblock: () => void = () => {};
        const gate = new Promise<void>(resolve => { unblock = resolve; });
        const first = observeRoute('/first', async () => {
            setLogContext({ siteId: 'first' });
            await gate;
            after(async () => {
                await Promise.resolve();
                logEvent('warn', 'background.failed');
            });
            return new Response();
        })(new Request('https://example.test'));
        await observeRoute('/second', async () => {
            setLogContext({ siteId: 'second' });
            return new Response();
        })(new Request('https://example.test'));
        unblock();
        await first;
        await finishResponse();
        expect(entries().find(entry => entry.event === 'background.failed')).toMatchObject({ route: '/first', siteId: 'first' });
        expect(entries().filter(entry => entry.route === '/second')).toHaveLength(1);
        expect(new Set(entries().map(entry => entry.requestId)).size).toBe(2);
    });

    it('uses specific site IDs inside a multi-site request without overwriting the job context', async () => {
        await observeRoute('/cron', async () => {
            setLogContext({ siteIds: ['a', 'b', 'a'] });
            logEvent('info', 'tesla.refresh.succeeded', { siteId: 'b' });
            return new Response();
        })(new Request('https://example.test'));
        await finishResponse();
        expect(entries()[0]).toMatchObject({ siteIds: ['a', 'b'], siteId: 'b', siteCount: 2 });
        expect(entries()[1]).toMatchObject({ siteIds: ['a', 'b'], siteCount: 2 });
        expect(entries()[1]).not.toHaveProperty('siteId');
    });

    it('uses the only authorized site on single-site sign-in requests', async () => {
        await observeRoute('/auth', async () => {
            setLogContext({ siteIds: ['site-1'] });
            return new Response();
        })(new Request('https://example.test'));
        await finishResponse();
        expect(entries()[0]).toMatchObject({ siteId: 'site-1', siteIds: ['site-1'] });
    });

    it('does not change an exception or leak exporter failure details', async () => {
        mocks.ingest.mockRejectedValue(new Error('sensitive upstream response'));
        const error = new Error('business failure');
        const handler = observeRoute('/test', async () => { throw error; });
        await expect(handler(new Request('https://example.test'))).rejects.toBe(error);
        await expect(finishResponse()).resolves.toBeUndefined();
        expect(entries()[0]).toMatchObject({ event: 'request.failed', level: 'error' });
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('delivery failed'), { count: 1 });
        expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('sensitive');
    });

    it('treats Next redirects as control flow without exporting their destination', async () => {
        const redirect = { digest: 'NEXT_REDIRECT;replace;https://private.test?code=secret;307;' };
        await expect(observeRoute('/auth', async () => { throw redirect; })(new Request('https://example.test'))).rejects.toBe(redirect);
        await finishResponse();
        expect(entries()[0]).toMatchObject({ event: 'request.redirected', level: 'info' });
        expect(JSON.stringify(entries())).not.toContain('private');
    });

    it('bounds export volume for noisy requests and keeps unobserved callers local', async () => {
        logEvent('info', 'script.event');
        expect(mocks.callbacks).toHaveLength(0);
        await observeRoute('/test', async () => {
            for (let i = 0; i < 250; i++) logEvent('info', 'test.event');
            return new Response();
        })(new Request('https://example.test'));
        await finishResponse();
        expect(entries()).toHaveLength(200);
    });

    it('handles a missing Next request lifecycle without failing the response', async () => {
        vi.mocked(after).mockImplementationOnce(() => { throw new Error('no lifecycle'); });
        const response = await observeRoute('/test', async () => new Response())(new Request('https://example.test'));
        expect(response.status).toBe(200);
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('No request lifecycle'));
    });

    it('does not fail authentication work if the checkpoint lifecycle is unavailable', async () => {
        const response = await observeRoute('/test', async () => {
            logEvent('info', 'verification.started');
            vi.mocked(after).mockImplementationOnce(() => { throw new Error('no lifecycle'); });
            flushLogEvents();
            return new Response();
        })(new Request('https://example.test'));
        expect(response.status).toBe(200);
        await finishResponse();
        expect(entries().map(entry => entry.event)).toEqual(['verification.started', 'request.completed']);
    });
});
