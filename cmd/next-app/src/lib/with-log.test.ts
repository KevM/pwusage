import { describe, it, expect, vi } from 'vitest';
import { withLog } from './with-log';

vi.mock('./log', () => {
    const calls: string[] = [];
    return {
        log: {
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn((m: string) => { calls.push(`error:${m}`); }),
            debug: vi.fn(),
            flush: vi.fn(async () => { calls.push('flush'); }),
        },
        __calls: calls,
    };
});

describe('withLog', () => {
    it('awaits flush() before returning the handler response', async () => {
        const handler = vi.fn(async () => {
            return new Response('ok');
        });
        const mod = await import('./log') as unknown as { __calls: string[] };
        const wrapped = withLog(handler);
        const res = await wrapped({ url: 'http://x' } as never, {} as never);
        expect(res).toBeInstanceOf(Response);
        expect(handler).toHaveBeenCalledOnce();
        expect(mod.__calls).toContain('flush');
    });

    it('logs and flushes on thrown error, then rethrows', async () => {
        const handler = vi.fn(async () => { throw new Error('bad'); });
        const wrapped = withLog(handler);
        await expect(wrapped({ url: 'http://x' } as never, {} as never)).rejects.toThrow('bad');
        const mod = await import('./log') as unknown as { __calls: string[] };
        expect(mod.__calls.some(c => c.startsWith('error:'))).toBe(true);
        expect(mod.__calls).toContain('flush');
    });
});
