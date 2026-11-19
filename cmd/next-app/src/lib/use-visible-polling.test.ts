import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startVisiblePolling, type VisibilitySource } from './use-visible-polling';

function fakeDocument(initial: DocumentVisibilityState) {
    const listeners = new Set<() => void>();
    const doc = {
        visibilityState: initial,
        addEventListener: (_: 'visibilitychange', l: () => void) => { listeners.add(l); },
        removeEventListener: (_: 'visibilitychange', l: () => void) => { listeners.delete(l); },
    };
    const setVisibility = (state: DocumentVisibilityState) => {
        doc.visibilityState = state;
        listeners.forEach(l => l());
    };
    return { doc: doc as VisibilitySource, setVisibility, listeners };
}

describe('startVisiblePolling', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('polls while visible, stops while hidden, and fires on return', () => {
        const { doc, setVisibility } = fakeDocument('visible');
        const fire = vi.fn();
        startVisiblePolling(doc, fire, 60_000, true);
        expect(fire).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(120_000);
        expect(fire).toHaveBeenCalledTimes(3);

        setVisibility('hidden');
        vi.advanceTimersByTime(10 * 60_000);
        expect(fire).toHaveBeenCalledTimes(3);

        setVisibility('visible');
        expect(fire).toHaveBeenCalledTimes(4);
        vi.advanceTimersByTime(60_000);
        expect(fire).toHaveBeenCalledTimes(5);
    });

    it('a page opened hidden does not poll until shown', () => {
        const { doc, setVisibility } = fakeDocument('hidden');
        const fire = vi.fn();
        startVisiblePolling(doc, fire, 60_000, true);
        vi.advanceTimersByTime(5 * 60_000);
        expect(fire).not.toHaveBeenCalled();
        setVisibility('visible');
        expect(fire).toHaveBeenCalledTimes(1);
    });

    it('stop clears the interval and the listener', () => {
        const { doc, listeners } = fakeDocument('visible');
        const fire = vi.fn();
        const stop = startVisiblePolling(doc, fire, 60_000, false);
        stop();
        vi.advanceTimersByTime(5 * 60_000);
        expect(fire).not.toHaveBeenCalled();
        expect(listeners.size).toBe(0);
    });
});
