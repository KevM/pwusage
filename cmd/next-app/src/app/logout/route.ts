import { NextRequest, NextResponse } from 'next/server';
import { isCrossOriginRequest, isSecureRequest } from '@/lib/request-security';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store', Pragma: 'no-cache' };

/**
 * POST /logout — ends this browser's (or the native app's) session.
 *
 * Signing out is a state change, so it takes an intentional POST: the web
 * header's form, or the iOS app's URLSession request (which may omit Origin;
 * `isCrossOriginRequest` allows that). A cross-origin POST is refused before
 * the cookie is touched. The 303 makes the browser follow with GET /, where a
 * 307 would re-POST to the home page.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
    if (isCrossOriginRequest(request)) {
        return NextResponse.json({ error: 'Cross-origin requests are not allowed' }, { status: 403, headers: NO_STORE });
    }

    const response = NextResponse.redirect(new URL('/', request.nextUrl), { status: 303, headers: NO_STORE });
    response.cookies.set('site_auth', '', {
        httpOnly: true,
        secure: isSecureRequest(request),
        maxAge: 0,
        path: '/',
        sameSite: 'lax',
    });
    return response;
}

/**
 * GET never signs out: a link, prefetch, image or cross-site navigation must
 * not be able to end someone's session.
 */
export async function GET(): Promise<NextResponse> {
    return NextResponse.json({ error: 'Use POST to sign out' }, {
        status: 405,
        headers: { ...NO_STORE, Allow: 'POST' },
    });
}
