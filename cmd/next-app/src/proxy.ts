import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { checkRefreshNeeded, COOKIE_MAX_AGE_SECONDS } from './lib/auth-jwt';

// Define paths that do not require auth check/refresh overhead
// (Static files, images, favicon are usually excluded by matcher, but good to be safe)


export async function proxy(request: NextRequest) {
    const { pathname } = request.nextUrl;

    // Only run on relevant paths to save performance
    // Note: Matcher in config below handles most of this, but checking explicitly if needed.

    const siteAuthToken = request.cookies.get('site_auth')?.value;

    if (siteAuthToken) {
        // Check if we need to refresh the token (sliding window)
        // We do this for ANY request that has the token, to keep it alive.
        const newToken = await checkRefreshNeeded(siteAuthToken);

        if (newToken) {
            // Token was refreshed! Set the new cookie.
            const response = NextResponse.next();

            response.cookies.set('site_auth', newToken, {
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                maxAge: COOKIE_MAX_AGE_SECONDS,
                path: '/',
                sameSite: 'lax'
            });

            console.log(`[Middleware/Proxy] Refreshed site_auth token for path: ${pathname}`);
            return response;
        }
    }

    return NextResponse.next();
}

export const config = {
    matcher: [
        /*
         * Match all request paths except for the ones starting with:
         * - _next/static (static files)
         * - _next/image (image optimization files)
         * - favicon.ico (favicon file)
         * - public folder content (if any known patterns)
         */
        '/((?!_next/static|_next/image|favicon.ico).*)',
    ],
};
