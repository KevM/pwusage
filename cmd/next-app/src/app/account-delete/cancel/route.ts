import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth-checks';
import { accountFingerprint, logEvent, observeRoute } from '@/lib/observability';

export const dynamic = 'force-dynamic';

/** Records the Cancel click for the deletion funnel, then returns to the profile page. */
async function handleGET(request: NextRequest): Promise<NextResponse> {
    const user = await getCurrentUser();
    if (user) {
        logEvent('info', 'user.account-deletion.cancelled', { accountId: accountFingerprint(user.id) });
    }
    return NextResponse.redirect(new URL('/profile', request.url), 303);
}

export const GET = observeRoute('/account-delete/cancel', handleGET);
