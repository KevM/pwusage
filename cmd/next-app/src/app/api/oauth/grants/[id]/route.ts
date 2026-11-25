import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth-checks';
import { isSameOriginPost } from '@/lib/oauth/csrf';
import { revokeUserOAuthGrant } from '@/lib/oauth/oauth-repo';
import { logEvent } from '@/lib/observability';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function DELETE(
    request: Request,
    context: { params: Promise<{ id: string }> },
): Promise<Response> {
    if (!isSameOriginPost(request)) {
        return NextResponse.json({ error: 'Cross-origin request rejected' }, { status: 403 });
    }

    const user = await getCurrentUser();
    if (!user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await context.params;
    if (!id || !UUID_RE.test(id)) {
        return NextResponse.json({ error: 'Invalid grant id' }, { status: 400 });
    }

    const revoked = await revokeUserOAuthGrant(user.id, id);
    if (!revoked) {
        return NextResponse.json({ error: 'Grant not found' }, { status: 404 });
    }

    logEvent('info', 'oauth.revoke', { grantId: id, source: 'settings' });
    return NextResponse.json({ ok: true }, { status: 200 });
}
