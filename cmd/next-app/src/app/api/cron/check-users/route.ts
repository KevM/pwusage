import { logEvent, observeRoute } from '@/lib/observability';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { UserRepo } from '@/lib/user-repo';

async function handleGET(request: NextRequest) {
    try {
        const authHeader = request.headers.get('authorization');
        const cronSecret = process.env.CRON_SECRET;
        if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        console.log('[CRON] Starting user status verification...');
        const userRepo = new UserRepo();
        const result = await userRepo.verifyAllUserStatuses();

        logEvent('info', 'cron.check-users.completed', { summary: result });

        return NextResponse.json({
            success: true,
            summary: result
        });

    } catch (error) {
        logEvent('error', 'cron.check-users.failed', { error });
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}

export const GET = observeRoute('/api/cron/check-users', handleGET);
