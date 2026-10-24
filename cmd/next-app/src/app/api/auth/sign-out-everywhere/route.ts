import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth-checks';
import { UserRepo } from '@/lib/user-repo';
import { isSecureRequest } from '@/lib/request-security';

export const dynamic = 'force-dynamic';

function jsonError(error: string, status: number): NextResponse {
    return NextResponse.json({ error }, {
        status,
        headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' },
    });
}

/**
 * POST /api/auth/sign-out-everywhere
 *
 * Bumps User.session_version, revoking every outstanding site_auth JWT on
 * every device (the caller's cookie is cleared too; re-auth issues a token
 * stamped with the new version). CSRF: the site_auth cookie is SameSite=Lax
 * so cross-site POSTs never carry it, and the origin check below is defense
 * in depth consistent with the mobile session exchange route.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
    const origin = request.headers.get('origin');
    if (origin) {
        let originUrl: URL;
        try {
            originUrl = new URL(origin);
        } catch {
            return jsonError('Cross-origin requests are not allowed', 403);
        }
        if (originUrl.origin !== request.nextUrl.origin) {
            return jsonError('Cross-origin requests are not allowed', 403);
        }
    }

    if (request.headers.get('sec-fetch-site')?.toLowerCase() === 'cross-site') {
        return jsonError('Cross-origin requests are not allowed', 403);
    }

    const user = await getCurrentUser();
    if (!user) return jsonError('Unauthorized', 401);

    await new UserRepo().bumpSessionVersion(user.id);

    const response = NextResponse.json({ ok: true }, {
        headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' },
    });
    response.cookies.set('site_auth', '', {
        httpOnly: true,
        secure: isSecureRequest(request),
        maxAge: 0,
        path: '/',
        sameSite: 'lax',
    });
    return response;
}
