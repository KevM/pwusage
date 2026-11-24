import { NextRequest, NextResponse } from 'next/server';
import { getAuthorizedSiteIds, getCurrentUser } from '@/lib/auth-checks';
import {
    BILLING_READ_SCOPE,
    createIntegrationCredential,
    listIntegrationCredentials,
    revokeIntegrationCredential,
} from '@/lib/integration-credential-repo';
import { isCrossOriginRequest } from '@/lib/request-security';

type Context = { params: Promise<{ id: string }> };
const PRIVATE_RESPONSE = { 'Cache-Control': 'private, no-store' };

async function getAccess({ params }: Context) {
    const [{ id: siteId }, user, sites] = await Promise.all([params, getCurrentUser(), getAuthorizedSiteIds()]);
    return user && sites.includes(siteId) ? { siteId, userId: user.id } : null;
}

function json(body: unknown, status = 200) {
    return NextResponse.json(body, { status, headers: PRIVATE_RESPONSE });
}

export async function GET(_request: NextRequest, context: Context) {
    const access = await getAccess(context);
    if (!access) return json({ error: 'Unauthorized' }, 401);
    return json({ credentials: await listIntegrationCredentials(access.userId, access.siteId, BILLING_READ_SCOPE) });
}

export async function POST(request: NextRequest, context: Context) {
    if (isCrossOriginRequest(request)) return json({ error: 'Forbidden' }, 403);
    const access = await getAccess(context);
    if (!access) return json({ error: 'Unauthorized' }, 401);

    const body: { name?: unknown } | null = await request.json().catch(() => null);
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 80 || name.includes('\0')) return json({ error: 'Enter a name up to 80 characters.' }, 400);

    return json(await createIntegrationCredential(access.userId, access.siteId, name, BILLING_READ_SCOPE), 201);
}

export async function DELETE(request: NextRequest, context: Context) {
    if (isCrossOriginRequest(request)) return json({ error: 'Forbidden' }, 403);
    const access = await getAccess(context);
    if (!access) return json({ error: 'Unauthorized' }, 401);

    const id = request.nextUrl.searchParams.get('id');
    if (!id || !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(id)) {
        return json({ error: 'Invalid token ID' }, 400);
    }

    const revoked = await revokeIntegrationCredential(access.userId, access.siteId, id, BILLING_READ_SCOPE);
    if (!revoked) return json({ error: 'Token not found' }, 404);
    return new NextResponse(null, { status: 204, headers: PRIVATE_RESPONSE });
}
