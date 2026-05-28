import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { track, identify } from './analytics';

describe('analytics wrapper', () => {
    const realWindow = globalThis.window;

    afterEach(() => {
        // Restore between tests
        if (realWindow) {
            (globalThis as { window?: Window }).window = realWindow;
        } else {
            delete (globalThis as { window?: Window }).window;
        }
        vi.restoreAllMocks();
    });

    it('track() is a no-op when window is undefined (SSR)', () => {
        delete (globalThis as { window?: Window }).window;
        expect(() => track('event-name', { x: 1 })).not.toThrow();
    });

    it('identify() is a no-op when window is undefined (SSR)', () => {
        delete (globalThis as { window?: Window }).window;
        expect(() => identify('user-1', { email: 'a@b' })).not.toThrow();
    });

    it('track() is a no-op when window.umami is missing', () => {
        (globalThis as { window?: Window }).window = { } as Window;
        expect(() => track('event-name')).not.toThrow();
    });

    it('track() forwards to window.umami.track when present', () => {
        const trackSpy = vi.fn();
        (globalThis as { window?: Window }).window = {
            umami: { track: trackSpy, identify: vi.fn() },
        } as unknown as Window;
        track('event-name', { site_id: 's' });
        expect(trackSpy).toHaveBeenCalledWith('event-name', { site_id: 's' });
    });

    it('identify() forwards to window.umami.identify when present', () => {
        const identifySpy = vi.fn();
        (globalThis as { window?: Window }).window = {
            umami: { track: vi.fn(), identify: identifySpy },
        } as unknown as Window;
        identify('user-1', { email: 'a@b' });
        expect(identifySpy).toHaveBeenCalledWith('user-1', { email: 'a@b' });
    });

    beforeEach(() => {
        // no-op, kept for symmetry with afterEach restoration
    });
});
