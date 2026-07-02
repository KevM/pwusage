export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { UserRepo } from '@/lib/user-repo';

export async function GET(request: NextRequest) {
    try {
        const authHeader = request.headers.get('authorization');
        const cronSecret = process.env.CRON_SECRET;
        if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        console.log('[CRON] Starting user status verification...');
        const userRepo = new UserRepo();
        const result = await userRepo.verifyAllUserStatuses();

        console.log(`[CRON] User status verification completed: ${JSON.stringify(result)}`);

        return NextResponse.json({
            success: true,
            summary: result
        });

    } catch (error) {
        console.error('[CRON] User status verification failed:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
