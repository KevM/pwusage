export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { UserRepo } from '@/lib/user-repo';
import { log } from '@/lib/log';
import { withLog } from '@/lib/with-log';
import { pingHeartbeat } from '@/lib/heartbeat';

export const GET = withLog(async (request: NextRequest) => {
    try {
        const authHeader = request.headers.get('authorization');
        if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        log.info('[CRON] Starting user status verification...');
        const userRepo = new UserRepo();
        const result = await userRepo.verifyAllUserStatuses();

        log.info(`[CRON] User status verification completed: ${JSON.stringify(result)}`, {
            ...result,
        });

        await pingHeartbeat('check-users');

        return NextResponse.json({
            success: true,
            summary: result
        });

    } catch (error) {
        log.error('[CRON] User status verification failed', {
            err: error instanceof Error ? error.message : String(error),
        });
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
});
