import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth-checks';
import { isSameOriginPost } from '@/lib/oauth/csrf';
import { revokeUserOAuthGrant } from '@/lib/oauth/oauth-repo';
import { logEvent } from '@/lib/observability';

const PRIVATE = { 'Cache-Control': 'private, no-store' };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function DELETE(
    request: Request,
    context: { params: Promise<{ id: string }> },
): Promise<Response> {
    if (!isSameOriginPost(request)) {
        return NextResponse.json({ error: 'Cross-origin request rejected' }, { status: 403, headers: PRIVATE });
    }

    const user = await getCurrentUser();
    if (!user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: PRIVATE });
    }

    const { id } = await context.params;
    if (!id || !UUID_RE.test(id)) {
        return NextResponse.json({ error: 'Invalid grant id' }, { status: 400, headers: PRIVATE });
    }

    const revoked = await revokeUserOAuthGrant(user.id, id);
    if (!revoked) {
        return NextResponse.json({ error: 'Grant not found' }, { status: 404, headers: PRIVATE });
    }

    logEvent('info', 'oauth.revoke', { grantId: id, source: 'settings' });
    return NextResponse.json({ ok: true }, { status: 200, headers: PRIVATE });
}
