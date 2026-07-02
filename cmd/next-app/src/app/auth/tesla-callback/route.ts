import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { NextRequest, NextResponse } from 'next/server';
import { TeslaAuthService } from '@/lib/tesla-auth-service';
import { getAppBaseUrl } from '@/lib/url-utils';

export const maxDuration = 60; // Allow up to 60 seconds on Vercel to avoid timeouts during slow Tesla API / JWKS calls

export async function GET(request: NextRequest) {
    const searchParams = request.nextUrl.searchParams;
    const code = searchParams.get('code');
    const state = searchParams.get('state');
    const redirectBaseUrl = getAppBaseUrl(request);
    const callbackUrl = `${redirectBaseUrl}/auth/tesla-callback`;

    // Validate required environment variables
    if (!process.env.PUBLIC_TESLA_OAUTH_CLIENT_ID || !process.env.PUBLIC_TESLA_OAUTH_AUDIENCE) {
        console.error('[AuthCallback] Missing required Tesla OAuth environment variables', {
            hasClientId: !!process.env.PUBLIC_TESLA_OAUTH_CLIENT_ID,
            hasAudience: !!process.env.PUBLIC_TESLA_OAUTH_AUDIENCE
        });
        return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
    }

    if (!code || !state) {
        return NextResponse.json({ error: 'Missing code or state' }, { status: 400 });
    }

    const cookieStore = await cookies();
    const savedState = cookieStore.get('auth_state')?.value;
    const savedNonce = cookieStore.get('auth_nonce')?.value;
    const savedCallback = cookieStore.get('auth_callback')?.value;

    const authService = new TeslaAuthService();
    const result = await authService.handleTeslaCallback({
        code,
        state,
        savedState: savedState || '',
        savedNonce: savedNonce || '',
        callbackUrl
    });

    if (result.status === 'state-mismatch') {
        return NextResponse.json({ error: 'State mismatch' }, { status: 401 });
    }
    if (result.status === 'token-exchange-failed') {
        return NextResponse.json({ error: 'Failed to exchange token' }, { status: result.statusCode });
    }
    if (result.status === 'invalid-id-token') {
        return NextResponse.json({ error: 'Invalid ID token' }, { status: 401 });
    }
    if (result.status === 'nonce-mismatch') {
        return NextResponse.json({ error: 'Nonce mismatch' }, { status: 401 });
    }

    // Success flow - generate cookie & sign JWT
    if (result.status === 'success') {
        if (result.siteIds.length > 0 || result.roles.includes('admin')) {
            const { signSiteToken, COOKIE_MAX_AGE_SECONDS } = await import('@/lib/auth-jwt');
            const siteToken = signSiteToken(result.siteIds, result.roles, result.userId);

            // Set 24h cookie
            cookieStore.set('site_auth', siteToken, {
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                maxAge: COOKIE_MAX_AGE_SECONDS,
                path: '/',
                sameSite: 'lax'
            });
            console.log('[AuthCallback] Set site_auth token.');
        }
    }

    // Clean up auth cookies
    cookieStore.delete('auth_state');
    cookieStore.delete('auth_nonce');
    cookieStore.delete('auth_callback');

    if (savedCallback && savedCallback.startsWith('/') && !savedCallback.startsWith('//') && !savedCallback.startsWith('/\\')) {
        redirect(savedCallback);
    } else {
        redirect('/');
    }
}
