import { NextRequest, NextResponse } from 'next/server';
import { getCurrentSession, getCurrentUser, verifySiteAccess } from '@/lib/auth-checks';
import { isSameOriginPost } from '@/lib/oauth/csrf';
import { createIntegrationToken, listUserOAuthGrantsForSite } from '@/lib/oauth/oauth-repo';
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

/** Creates an integration token for one home. The raw token is in this response only. */
export const POST = observeRoute('/api/oauth/grants', async (request: NextRequest): Promise<Response> => {
    if (!isSameOriginPost(request)) {
        return NextResponse.json({ error: 'Cross-origin request rejected' }, { status: 403, headers: PRIVATE });
    }
    // Bound to the version this session was validated at, like OAuth consent.
    const user = await getCurrentSession();
    if (!user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: PRIVATE });
    }

    const body: { siteId?: unknown; name?: unknown } | null = await request.json().catch(() => null);
    const siteId = typeof body?.siteId === 'string' ? body.siteId.trim() : '';
    if (!siteId || !(await verifySiteAccess(siteId))) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403, headers: PRIVATE });
    }
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 80 || name.includes('\0')) {
        return NextResponse.json({ error: 'Enter a name up to 80 characters.' }, { status: 400, headers: PRIVATE });
    }

    const created = await createIntegrationToken(user.id, siteId, name, user.sessionVersion);
    if (!created) {
        return NextResponse.json(
            { error: 'Your session ended. Sign in again to create a token.' },
            { status: 401, headers: PRIVATE },
        );
    }
    return NextResponse.json(created, { status: 201, headers: PRIVATE });
});
