import { AsyncResource } from 'node:async_hooks';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logEvent, observeRoute } from './observability';

const callbacks = vi.hoisted(() => [] as Array<() => unknown>);
vi.mock('next/server', () => ({
    after: (callback: () => unknown) => callbacks.push(AsyncResource.bind(callback)),
}));

describe('Axiom SDK transport', () => {
    beforeEach(() => {
        callbacks.length = 0;
        vi.stubEnv('VERCEL_ENV', 'production');
        vi.stubEnv('AXIOM_TOKEN', 'xaat-test-ingest');
        vi.stubEnv('AXIOM_DATASET', 'pwusage');
        vi.spyOn(console, 'info').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

    it('sends a real SDK batch with the ingest token and an independent network deadline', async () => {
        const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ ingested: 2, failed: 0 })));
        vi.stubGlobal('fetch', fetchMock);
        await observeRoute('/test', async () => {
            logEvent('info', 'test.ready', { siteId: 'site-1' });
            return new Response();
        })(new Request('https://example.test'));
        await Promise.all(callbacks.splice(0).map(callback => callback()));
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0];
        expect(String(url)).toBe('https://api.axiom.co/v1/datasets/pwusage/ingest');
        const headers = new Headers(init?.headers);
        expect(headers.get('authorization')).toBe('Bearer xaat-test-ingest');
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        const body = typeof init?.body === 'string' ? Buffer.from(init.body) : Buffer.from(init!.body as Uint8Array);
        const text = headers.get('content-encoding') === 'gzip' ? gunzipSync(body).toString() : body.toString();
        expect(text).toContain('test.ready');
        expect(text).toContain('site-1');
        expect(text).not.toContain('xaat-test-ingest');
    });

    it('reports a rejected ingest token without logging upstream response content', async () => {
        vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response('private response', { status: 403 })));
        await observeRoute('/test', async () => new Response())(new Request('https://example.test'));
        await Promise.all(callbacks.splice(0).map(callback => callback()));
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('delivery failed'), { count: 1 });
        expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('private response');
    });
});
