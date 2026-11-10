import { NextRequest, NextResponse } from 'next/server';
import { deleteAccount } from '@/lib/account-deletion-service';
import { getCurrentUser } from '@/lib/auth-checks';
import { observeRoute } from '@/lib/observability';
import { isCrossOriginRequest, isSecureRequest } from '@/lib/request-security';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store', Pragma: 'no-cache' };

function jsonError(error: string, status: number, code?: string): NextResponse {
    return NextResponse.json({ error, ...(code ? { code } : {}) }, { status, headers: NO_STORE });
}

/**
 * DELETE /api/user permanently deletes the signed-in account. CSRF: site_auth is
 * SameSite=Lax, and the origin check is defense in depth, matching sign-out-everywhere.
 */
async function handleDELETE(request: NextRequest): Promise<NextResponse> {
    if (isCrossOriginRequest(request)) return jsonError('Cross-origin requests are not allowed', 403);

    const user = await getCurrentUser();
    if (!user) return jsonError('Sign in again, then try again.', 401);

    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return jsonError('Invalid request body', 400);
    }
    if ((body as { confirm?: unknown } | null)?.confirm !== 'DELETE') {
        return jsonError('Type DELETE to confirm.', 400);
    }

    let result;
    try {
        result = await deleteAccount(user.id);
    } catch {
        return jsonError('Could not delete your account. Your account was not changed. Try again.', 500);
    }

    if (result.status === 'needs_reconnect') {
        return jsonError(
            'Reconnect Tesla so pwusage can restore your Powerwall backup reserve, then try again. Your account was not deleted.',
            409,
            'TESLA_CONNECTION_REQUIRED',
        );
    }
    if (result.status === 'battery_saver_pending') {
        return jsonError(
            'Could not confirm your Powerwall backup reserve was restored. Your account was not deleted. Try again in a few minutes.',
            409,
            'BATTERY_SAVER_PENDING',
        );
    }

    const response = NextResponse.json({ ok: true }, { headers: NO_STORE });
    response.cookies.set('site_auth', '', {
        httpOnly: true,
        secure: isSecureRequest(request),
        maxAge: 0,
        path: '/',
        sameSite: 'lax',
    });
    return response;
}

export const DELETE = observeRoute('/api/user', handleDELETE);
