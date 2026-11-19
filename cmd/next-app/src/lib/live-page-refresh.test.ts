import { describe, expect, it, vi } from 'vitest';

vi.mock('./today-refresh', () => ({ refreshTodayData: vi.fn(), refreshLiveStatus: vi.fn() }));

import { refreshLivePage, LIVE_PAGE_STATUS_TTL_MS } from './live-page-refresh';

function deps(history: string, live: string | Error) {
    return {
        refreshTodayData: vi.fn(async () => ({ status: history })),
        refreshLiveStatus: vi.fn(async () => {
            if (live instanceof Error) throw live;
            return { status: live };
        }),
    } as unknown as Parameters<typeof refreshLivePage>[1];
}

describe('refreshLivePage', () => {
    it('re-renders when new samples were stored', async () => {
        const d = deps('persisted', 'cached');
        expect((await refreshLivePage('s1', d)).changed).toBe(true);
        expect(d!.refreshLiveStatus).toHaveBeenCalledWith('s1', { cacheTtlMs: LIVE_PAGE_STATUS_TTL_MS });
    });

    it('re-renders when a new live reading was stored', async () => {
        expect((await refreshLivePage('s1', deps('not-due', 'refreshed'))).changed).toBe(true);
    });

    it('does not re-render when nothing changed (so a refresh cannot loop)', async () => {
        for (const [history, live] of [['throttled', 'cached'], ['not-due', 'throttled'], ['in-flight', 'in-flight'], ['no-new-rows', 'cached']]) {
            expect((await refreshLivePage('s1', deps(history, live))).changed).toBe(false);
        }
    });

    it('a failed Tesla call keeps the stored snapshot', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const result = await refreshLivePage('s1', deps('error', new Error('tesla_live_timeout')));
        expect(result).toEqual({ changed: false, historyStatus: 'error', liveStatus: 'error' });
    });
});
