import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('./analytics', () => ({
    track: vi.fn(),
    identify: vi.fn(),
}));

describe('notifyReauthNeeded', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('fires the tesla-reauth-needed event with site_id when provided', async () => {
        const { notifyReauthNeeded, __resetReauthSignal } = await import('./reauth-signal');
        const { track } = await import('./analytics');
        __resetReauthSignal();
        notifyReauthNeeded('site-123');
        expect(track).toHaveBeenCalledWith('tesla-reauth-needed', { site_id: 'site-123' });
    });

    it('fires without site_id when not provided', async () => {
        const { notifyReauthNeeded, __resetReauthSignal } = await import('./reauth-signal');
        const { track } = await import('./analytics');
        __resetReauthSignal();
        notifyReauthNeeded();
        expect(track).toHaveBeenCalledWith('tesla-reauth-needed', {});
    });

    it('deduplicates within a single page session', async () => {
        const { notifyReauthNeeded, __resetReauthSignal } = await import('./reauth-signal');
        const { track } = await import('./analytics');
        __resetReauthSignal();
        vi.mocked(track).mockClear();
        notifyReauthNeeded('site-1');
        notifyReauthNeeded('site-1');
        notifyReauthNeeded('site-1');
        expect(track).toHaveBeenCalledTimes(1);
    });
});
