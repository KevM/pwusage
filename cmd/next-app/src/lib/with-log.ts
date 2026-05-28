import { log } from './log';
import type { NextRequest } from 'next/server';

type Handler<Ctx> = (req: NextRequest, ctx: Ctx) => Promise<Response>;

export function withLog<Ctx>(handler: Handler<Ctx>): Handler<Ctx> {
    return async (req, ctx) => {
        try {
            const res = await handler(req, ctx);
            await log.flush();
            return res;
        } catch (err) {
            log.error('Unhandled route error', {
                url: req.url,
                err: err instanceof Error ? err.message : String(err),
            });
            await log.flush();
            throw err;
        }
    };
}
