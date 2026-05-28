import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('pingHeartbeat', () => {
    const origFetch = globalThis.fetch;

    beforeEach(() => {
        vi.resetModules();
        delete process.env.BETTERSTACK_HEARTBEAT_CLEANUP;
        delete process.env.BETTERSTACK_HEARTBEAT_CHECK_USERS;
        delete process.env.BETTERSTACK_HEARTBEAT_RESTORE_RESERVE;
    });

    afterEach(() => {
        globalThis.fetch = origFetch;
        vi.restoreAllMocks();
    });

    it('is a no-op when the URL env var is unset', async () => {
        const fetchSpy = vi.fn();
        globalThis.fetch = fetchSpy as unknown as typeof fetch;
        const { pingHeartbeat } = await import('./heartbeat');
        await pingHeartbeat('cleanup');
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('POSTs to the configured URL when set', async () => {
        process.env.BETTERSTACK_HEARTBEAT_CLEANUP = 'https://uptime.betterstack.com/api/v1/heartbeat/abc';
        const fetchSpy = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
        globalThis.fetch = fetchSpy as unknown as typeof fetch;
        const { pingHeartbeat } = await import('./heartbeat');
        await pingHeartbeat('cleanup');
        expect(fetchSpy).toHaveBeenCalledWith(
            'https://uptime.betterstack.com/api/v1/heartbeat/abc',
            { method: 'POST' },
        );
    });

    it('swallows network errors', async () => {
        process.env.BETTERSTACK_HEARTBEAT_CLEANUP = 'https://uptime.betterstack.com/api/v1/heartbeat/abc';
        globalThis.fetch = vi.fn().mockRejectedValue(new Error('network down')) as unknown as typeof fetch;
        const { pingHeartbeat } = await import('./heartbeat');
        await expect(pingHeartbeat('cleanup')).resolves.toBeUndefined();
    });
});
