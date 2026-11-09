import { flushLogEvents, logEvent, observeRoute } from '@/lib/observability';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { UserRepo } from '@/lib/user-repo';
import { reconcileDueMemberships } from '@/lib/site-membership-daily';
import { siteMembershipEnabled } from '@/lib/site-membership-flag';

async function handleGET(request: NextRequest) {
    try {
        const authHeader = request.headers.get('authorization');
        const cronSecret = process.env.CRON_SECRET;
        if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        logEvent('info', 'cron.check-users.started');
        flushLogEvents();
        const userRepo = new UserRepo();
        const shared = siteMembershipEnabled();
        const deadline = shared ? Date.now() + 50_000 : Infinity;
        const memberships = shared ? await reconcileDueMemberships(deadline) : null;
        const result = await userRepo.verifyAllUserStatuses(deadline);

        logEvent('info', 'cron.check-users.completed', { summary: result, ...(shared ? { memberships } : {}) });

        return NextResponse.json({
            success: true,
            summary: result,
            ...(shared ? { memberships } : {})
        });

    } catch (error) {
        logEvent('error', 'cron.check-users.failed', { error });
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}

export const GET = observeRoute('/api/cron/check-users', handleGET);
