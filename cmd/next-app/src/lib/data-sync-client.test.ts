import { describe, expect, it, vi } from 'vitest';
import { changedDaysTouchDate, MAX_SYNC_ATTEMPTS, runDataSync, runSyncStep, type DataSyncDeps } from './data-sync-client';

type Frame = Record<string, unknown>;

/** A `/api/sync` response streaming these frames, optionally split mid-line. */
function sseResponse(frames: Frame[], splitAt?: number): Response {
    const text = frames.map(f => `data: ${JSON.stringify(f)}\n\n`).join('');
    const parts = splitAt === undefined ? [text] : [text.slice(0, splitAt), text.slice(splitAt)];
    const encoder = new TextEncoder();
    return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
            parts.forEach(p => controller.enqueue(encoder.encode(p)));
            controller.close();
        },
    }), { status: 200 });
}

function deps(responses: Array<() => Response | Promise<Response>>) {
    const queue = [...responses];
    const fetchMock = vi.fn(async () => {
        const next = queue.shift();
        if (!next) throw new Error('unexpected request');
        return next();
    });
    const onHistoryChanged = vi.fn();
    const controller = new AbortController();
    const d: DataSyncDeps = {
        siteId: 's1',
        fetch: fetchMock as unknown as typeof fetch,
        signal: controller.signal,
        onStatus: vi.fn(),
        onIdle: vi.fn(),
        onHistoryChanged,
        sleep: async () => undefined,
        now: () => new Date('2026-11-19T18:00:00'),
    };
    return { d, fetchMock, onHistoryChanged, controller };
}

// Billing period well in the past, so the hot zone (around "now") does not overlap it:
// only the full-period stage runs.
const pastPeriod = { start: new Date('2026-09-01T00:00:00'), end: new Date('2026-10-01T00:00:00') };
// Current period, with the viewed date inside it: the hot zone runs first.
const currentPeriod = { start: new Date('2026-11-01T00:00:00'), end: new Date('2026-12-01T00:00:00'), viewDate: new Date('2026-11-19T00:00:00') };

describe('runDataSync refreshes only on changed history', () => {
    it('an already-covered period causes zero refreshes', async () => {
        const { d, fetchMock, onHistoryChanged } = deps([
            () => sseResponse([{ status: 'checking' }, { status: 'complete', changedDays: [] }]),
            () => sseResponse([{ status: 'checking' }, { status: 'complete', changedDays: [] }]),
        ]);
        expect(await runDataSync(d, currentPeriod)).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(2); // hot zone, then full period
        expect(onHistoryChanged).not.toHaveBeenCalled();
    });

    it('newly imported nearby days refresh once, as soon as they arrive', async () => {
        const day = '2026-11-18T06:00:00.000Z';
        const { d, onHistoryChanged } = deps([
            () => sseResponse([{ status: 'progress', message: 'Importing 2026-11-18...' }, { status: 'complete', changedDays: [day] }]),
            () => sseResponse([{ status: 'complete', changedDays: [] }]),
        ]);
        await runDataSync(d, currentPeriod);
        expect(onHistoryChanged).toHaveBeenCalledTimes(1);
        expect(onHistoryChanged).toHaveBeenCalledWith([day]);
    });

    it('a partial response that changed a day refreshes once, not once per event and again on close', async () => {
        const { d, fetchMock, onHistoryChanged } = deps([
            () => sseResponse([{ status: 'partial', processedWindows: 3, totalWindows: 10, changedDays: ['2026-09-01T05:00:00.000Z'] }]),
            () => sseResponse([{ status: 'complete', changedDays: [] }]),
        ]);
        expect(await runDataSync(d, pastPeriod)).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(onHistoryChanged).toHaveBeenCalledTimes(1);
    });

    it('a partial response with nothing written does not refresh', async () => {
        const { d, onHistoryChanged } = deps([
            () => sseResponse([{ status: 'partial', processedWindows: 2, totalWindows: 10, changedDays: [] }]),
            () => sseResponse([{ status: 'complete', changedDays: [] }]),
        ]);
        await runDataSync(d, pastPeriod);
        expect(onHistoryChanged).not.toHaveBeenCalled();
    });

    it('a failed request does not refresh, and stops the stage', async () => {
        const { d, fetchMock, onHistoryChanged } = deps([
            () => new Response('nope', { status: 500 }),
        ]);
        expect(await runDataSync(d, pastPeriod)).toBe(false);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(onHistoryChanged).not.toHaveBeenCalled();
        expect(d.onIdle).toHaveBeenCalledTimes(1);
    });

    it('an error after days were written still refreshes once', async () => {
        const { d, onHistoryChanged } = deps([
            () => sseResponse([{ status: 'error', message: 'throttled', changedDays: ['2026-09-02T05:00:00.000Z'] }]),
        ]);
        expect(await runDataSync(d, pastPeriod)).toBe(false);
        expect(onHistoryChanged).toHaveBeenCalledTimes(1);
    });

    it('a network failure does not refresh', async () => {
        const { d, onHistoryChanged } = deps([
            () => { throw new TypeError('Failed to fetch'); },
        ]);
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        expect(await runDataSync(d, pastPeriod)).toBe(false);
        expect(onHistoryChanged).not.toHaveBeenCalled();
    });

    it('keeps the retry limit while the server keeps reporting progress', async () => {
        let total = 100;
        const { d, fetchMock } = deps(Array.from({ length: MAX_SYNC_ATTEMPTS + 5 }, () =>
            () => sseResponse([{ status: 'partial', processedWindows: 1, totalWindows: total--, changedDays: [] }])));
        expect(await runDataSync(d, pastPeriod)).toBe(false);
        expect(fetchMock).toHaveBeenCalledTimes(MAX_SYNC_ATTEMPTS);
    });

    it('stops after two idle answers (import lock busy)', async () => {
        const { d, fetchMock } = deps(Array.from({ length: 5 }, () =>
            () => sseResponse([{ status: 'partial', processedWindows: 0, totalWindows: 0, changedDays: [] }])));
        expect(await runDataSync(d, pastPeriod)).toBe(false);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('cancellation stops without reporting a change', async () => {
        const { d, controller, onHistoryChanged } = deps([
            () => { controller.abort(); return sseResponse([{ status: 'complete', changedDays: ['2026-11-18T06:00:00.000Z'] }]); },
        ]);
        expect(await runDataSync(d, currentPeriod)).toBe(false);
        expect(onHistoryChanged).not.toHaveBeenCalled();
    });
});

describe('runDataSync detects outside changes through the history revision', () => {
    const period = { start: pastPeriod.start, end: pastPeriod.end };

    it('refreshes once when another request imported the rendered period', async () => {
        // This tab writes nothing, but the stored revision moved past what the page rendered.
        const { d, fetchMock, onHistoryChanged } = deps([
            () => sseResponse([{ status: 'complete', changedDays: [], historyRevision: 'rev-2' }]),
        ]);
        d.period = period;
        d.knownRevision = { current: 'rev-1' };
        await runDataSync(d, pastPeriod);
        expect(onHistoryChanged).toHaveBeenCalledTimes(1);
        expect(d.knownRevision.current).toBe('rev-2');
        const url = new URL(String((fetchMock.mock.calls[0] as unknown[])[0]), 'http://x');
        expect(url.searchParams.get('periodStart')).toBe(period.start.toISOString());
        expect(url.searchParams.get('periodEnd')).toBe(period.end.toISOString());
    });

    it('a matching revision causes no refresh', async () => {
        const { d, onHistoryChanged } = deps([
            () => sseResponse([{ status: 'complete', changedDays: [], historyRevision: 'rev-1' }]),
        ]);
        d.period = period;
        d.knownRevision = { current: 'rev-1' };
        await runDataSync(d, pastPeriod);
        expect(onHistoryChanged).not.toHaveBeenCalled();
    });

    it('one outside change refreshes once across several requests', async () => {
        const { d, onHistoryChanged } = deps([
            () => sseResponse([{ status: 'complete', changedDays: [], historyRevision: 'rev-2' }]),
            () => sseResponse([{ status: 'complete', changedDays: [], historyRevision: 'rev-2' }]),
        ]);
        d.period = { start: currentPeriod.start, end: currentPeriod.end };
        d.knownRevision = { current: 'rev-1' };
        await runDataSync(d, currentPeriod); // hot zone, then full period
        expect(onHistoryChanged).toHaveBeenCalledTimes(1);
    });

    it('without a rendered revision, only this request\'s writes count', async () => {
        const { d, onHistoryChanged } = deps([
            () => sseResponse([{ status: 'complete', changedDays: [], historyRevision: 'rev-2' }]),
        ]);
        d.period = period;
        d.knownRevision = { current: null };
        await runDataSync(d, pastPeriod);
        expect(onHistoryChanged).not.toHaveBeenCalled();
    });
});

describe('runSyncStep', () => {
    it('parses an event split across stream chunks', async () => {
        const { d } = deps([
            () => sseResponse([{ status: 'complete', changedDays: ['2026-09-01T05:00:00.000Z'] }], 20),
        ]);
        const result = await runSyncStep(d, pastPeriod.start, pastPeriod.end);
        expect(result).toMatchObject({ complete: true, changedDays: ['2026-09-01T05:00:00.000Z'] });
    });
});

describe('changedDaysTouchDate', () => {
    it('matches the viewed day and its neighbours only', () => {
        expect(changedDaysTouchDate(['2026-11-18T06:00:00.000Z'], '2026-11-18')).toBe(true);
        expect(changedDaysTouchDate(['2026-11-17T06:00:00.000Z'], '2026-11-18')).toBe(true);
        expect(changedDaysTouchDate(['2026-11-01T05:00:00.000Z'], '2026-11-18')).toBe(false);
        expect(changedDaysTouchDate([], '2026-11-18')).toBe(false);
    });
});
