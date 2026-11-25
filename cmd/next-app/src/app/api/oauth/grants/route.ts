import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser, verifySiteAccess } from '@/lib/auth-checks';
import { listUserOAuthGrantsForSite } from '@/lib/oauth/oauth-repo';
import { observeRoute } from '@/lib/observability';

const PRIVATE = { 'Cache-Control': 'private, no-store' };

export const GET = observeRoute('/api/oauth/grants', async (request: NextRequest): Promise<Response> => {
    const user = await getCurrentUser();
    if (!user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: PRIVATE });
    }

    const siteId = request.nextUrl.searchParams.get('siteId')?.trim() ?? '';
    if (!siteId || !(await verifySiteAccess(siteId))) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403, headers: PRIVATE });
    }

    const grants = await listUserOAuthGrantsForSite(user.id, siteId);
    return NextResponse.json({ grants }, { status: 200, headers: PRIVATE });
});
