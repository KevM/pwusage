import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('log wrapper', () => {
    beforeEach(() => {
        vi.resetModules();
        delete process.env.BETTERSTACK_SOURCE_TOKEN;
        delete process.env.BETTERSTACK_INGEST_URL;
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('log.info forwards to console.info', async () => {
        const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
        const { log } = await import('./log');
        log.info('hello', { a: 1 });
        expect(spy).toHaveBeenCalledWith('hello', { a: 1 });
    });

    it('log.warn forwards to console.warn', async () => {
        const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { log } = await import('./log');
        log.warn('careful');
        expect(spy).toHaveBeenCalledWith('careful');
    });

    it('log.error forwards to console.error', async () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const { log } = await import('./log');
        log.error('boom', { err: 'x' });
        expect(spy).toHaveBeenCalledWith('boom', { err: 'x' });
    });

    it('log.debug forwards to console.debug', async () => {
        const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
        const { log } = await import('./log');
        log.debug('chatter');
        expect(spy).toHaveBeenCalledWith('chatter');
    });

    it('forwards to Logtail when BETTERSTACK_SOURCE_TOKEN is set', async () => {
        process.env.BETTERSTACK_SOURCE_TOKEN = 'test-token';
        const mockInfo = vi.fn().mockResolvedValue({});
        vi.doMock('@logtail/node', () => {
            class MockLogtail {
                info = mockInfo;
                warn = vi.fn().mockResolvedValue({});
                error = vi.fn().mockResolvedValue({});
                debug = vi.fn().mockResolvedValue({});
                flush = vi.fn().mockResolvedValue(undefined);
            }
            return { Logtail: MockLogtail };
        });
        const { log } = await import('./log');
        log.info('msg', { a: 1 });
        expect(mockInfo).toHaveBeenCalledWith('msg', { a: 1 });
    });

    it('flush() resolves silently when SDK is not configured', async () => {
        const { log } = await import('./log');
        await expect(log.flush()).resolves.toBeUndefined();
    });
});
