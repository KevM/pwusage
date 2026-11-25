import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth-checks';
import { revokeUserOAuthGrant } from '@/lib/oauth/oauth-repo';
import { logEvent } from '@/lib/observability';

export async function DELETE(
    _request: Request,
    context: { params: Promise<{ id: string }> },
): Promise<Response> {
    const user = await getCurrentUser();
    if (!user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await context.params;
    if (!id) {
        return NextResponse.json({ error: 'Missing grant id' }, { status: 400 });
    }

    const revoked = await revokeUserOAuthGrant(user.id, id);
    if (!revoked) {
        return NextResponse.json({ error: 'Grant not found' }, { status: 404 });
    }

    logEvent('info', 'oauth.revoke', { grantId: id, source: 'settings' });
    return NextResponse.json({ ok: true }, { status: 200 });
}
