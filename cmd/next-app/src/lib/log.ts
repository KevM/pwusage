import { Logtail } from '@logtail/node';

type Ctx = Record<string, unknown>;
type Level = 'info' | 'warn' | 'error' | 'debug';

const token = process.env.BETTERSTACK_SOURCE_TOKEN;
const endpoint = process.env.BETTERSTACK_INGEST_URL;
const lt: Logtail | null = token
    ? new Logtail(token, endpoint ? { endpoint } : undefined)
    : null;

function emit(level: Level, message: string, ctx?: Ctx): void {
    const consoleFn = console[level] ?? console.log;
    if (ctx !== undefined) {
        consoleFn(message, ctx);
    } else {
        consoleFn(message);
    }
    if (lt) {
        // The SDK methods return promises; attach .catch() so an async rejection
        // never becomes an unhandled rejection. Also guard against synchronous
        // throws (defensive belt-and-suspenders).
        try {
            lt[level](message, ctx).catch(() => { /* swallow */ });
        } catch {
            // swallow synchronous throw
        }
    }
}

export const log = {
    info: (m: string, c?: Ctx): void => emit('info', m, c),
    warn: (m: string, c?: Ctx): void => emit('warn', m, c),
    error: (m: string, c?: Ctx): void => emit('error', m, c),
    debug: (m: string, c?: Ctx): void => emit('debug', m, c),
    flush: async (): Promise<void> => {
        if (!lt) return;
        try {
            await lt.flush();
        } catch {
            // swallow
        }
    },
};
