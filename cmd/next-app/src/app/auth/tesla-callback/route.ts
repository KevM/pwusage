import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { NextRequest, NextResponse } from 'next/server';
import { TeslaAuthService } from '@/lib/tesla-auth-service';
import { getAppBaseUrl } from '@/lib/url-utils';
import { createMobileLoginHandoff } from '@/lib/mobile-login-handoff';
import { isValidAppState, isValidMobileLoginParameters } from '@/lib/mobile-login-validation';

export const maxDuration = 60; // Allow up to 60 seconds on Vercel to avoid timeouts during slow Tesla API / JWKS calls

export async function GET(request: NextRequest) {
    const searchParams = request.nextUrl.searchParams;
    const code = searchParams.get('code');
    const state = searchParams.get('state');
    const redirectBaseUrl = getAppBaseUrl(request);
    const callbackUrl = `${redirectBaseUrl}/auth/tesla-callback`;
    const cookieStore = await cookies();
    const mobileAttemptId = cookieStore.get('auth_mobile_attempt')?.value;
    const mobileChallenge = cookieStore.get('auth_mobile_challenge')?.value;
    const mobileState = cookieStore.get('auth_mobile_state')?.value;
    const hasMobileCookies = !!(mobileAttemptId || mobileChallenge || mobileState);

    // Validate required environment variables
    if (!process.env.PUBLIC_TESLA_OAUTH_CLIENT_ID || !process.env.PUBLIC_TESLA_OAUTH_AUDIENCE) {
        console.error('[AuthCallback] Missing required Tesla OAuth environment variables', {
            hasClientId: !!process.env.PUBLIC_TESLA_OAUTH_CLIENT_ID,
            hasAudience: !!process.env.PUBLIC_TESLA_OAUTH_AUDIENCE
        });
        if (hasMobileCookies) clearAuthAttemptCookies(cookieStore);
        if (mobileState && isValidAppState(mobileState)) {
            return mobileCallbackResponse({ error: 'login_unavailable', state: mobileState });
        }
        return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
    }

    if (!code || !state) {
        if (hasMobileCookies) clearAuthAttemptCookies(cookieStore);
        if (mobileState && isValidAppState(mobileState)) {
            return mobileCallbackResponse({
                error: searchParams.get('error') === 'access_denied' ? 'access_denied' : 'missing_code_or_state',
                state: mobileState,
            });
        }
        return NextResponse.json({ error: 'Missing code or state' }, { status: 400 });
    }

    const savedState = cookieStore.get('auth_state')?.value;
    const savedNonce = cookieStore.get('auth_nonce')?.value;
    const savedCallback = cookieStore.get('auth_callback')?.value;
    if (hasMobileCookies && (!mobileAttemptId || !mobileChallenge || !mobileState
        || !isValidMobileLoginParameters(mobileChallenge, mobileState))) {
        clearAuthAttemptCookies(cookieStore);
        if (mobileState && isValidAppState(mobileState)) {
            return mobileCallbackResponse({ error: 'invalid_login_attempt', state: mobileState });
        }
        return NextResponse.json({ error: 'Invalid mobile login attempt' }, { status: 401 });
    }

    const authService = new TeslaAuthService();
    let result: Awaited<ReturnType<TeslaAuthService['handleTeslaCallback']>>;
    try {
        result = await authService.handleTeslaCallback({
            code,
            state,
            savedState: savedState || '',
            savedNonce: savedNonce || '',
            callbackUrl
        });
    } catch (error) {
        if (!hasMobileCookies) throw error;
        console.error('[AuthCallback] Mobile Tesla callback failed unexpectedly', error);
        clearAuthAttemptCookies(cookieStore);
        if (mobileState && isValidAppState(mobileState)) {
            return mobileCallbackResponse({ error: 'login_unavailable', state: mobileState });
        }
        return NextResponse.json({ error: 'Mobile login failed' }, { status: 500 });
    }

    if (result.status === 'state-mismatch') {
        if (hasMobileCookies) clearAuthAttemptCookies(cookieStore);
        if (mobileState && isValidAppState(mobileState)) {
            return mobileCallbackResponse({ error: 'state_mismatch', state: mobileState });
        }
        return NextResponse.json({ error: 'State mismatch' }, { status: 401 });
    }
    if (result.status === 'token-exchange-failed') {
        if (hasMobileCookies) clearAuthAttemptCookies(cookieStore);
        if (mobileState && isValidAppState(mobileState)) {
            return mobileCallbackResponse({ error: 'token_exchange_failed', state: mobileState });
        }
        return NextResponse.json({ error: 'Failed to exchange token' }, { status: result.statusCode });
    }
    if (result.status === 'invalid-id-token') {
        if (hasMobileCookies) clearAuthAttemptCookies(cookieStore);
        if (mobileState && isValidAppState(mobileState)) {
            return mobileCallbackResponse({ error: 'invalid_id_token', state: mobileState });
        }
        return NextResponse.json({ error: 'Invalid ID token' }, { status: 401 });
    }
    if (result.status === 'nonce-mismatch') {
        if (hasMobileCookies) clearAuthAttemptCookies(cookieStore);
        if (mobileState && isValidAppState(mobileState)) {
            return mobileCallbackResponse({ error: 'nonce_mismatch', state: mobileState });
        }
        return NextResponse.json({ error: 'Nonce mismatch' }, { status: 401 });
    }

    // Success flow - generate cookie & sign JWT
    if (result.status === 'success') {
        if (mobileAttemptId && mobileChallenge && mobileState) {
            if (result.siteIds.length === 0 && !result.roles.includes('admin')) {
                clearAuthAttemptCookies(cookieStore);
                return mobileCallbackResponse({ error: 'no_sites', state: mobileState });
            }
            let handoff: { code: string; attemptId: string };
            try {
                handoff = await createMobileLoginHandoff({
                    attemptId: mobileAttemptId,
                    codeChallenge: mobileChallenge,
                    appState: mobileState,
                    userId: result.userId,
                    siteIds: result.siteIds,
                    roles: result.roles,
                });
            } catch (error) {
                console.error('[AuthCallback] Failed to create mobile login handoff', error);
                clearAuthAttemptCookies(cookieStore);
                return mobileCallbackResponse({ error: 'login_unavailable', state: mobileState });
            }
            clearAuthAttemptCookies(cookieStore);
            return mobileCallbackResponse({ code: handoff.code, attempt: handoff.attemptId, state: mobileState });
        }

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
    clearAuthAttemptCookies(cookieStore);

    if (savedCallback && savedCallback.startsWith('/') && !savedCallback.startsWith('//') && !savedCallback.startsWith('/\\')) {
        redirect(savedCallback);
    } else {
        redirect('/');
    }
}

function clearAuthAttemptCookies(cookieStore: Awaited<ReturnType<typeof cookies>>): void {
    cookieStore.delete('auth_state');
    cookieStore.delete('auth_nonce');
    cookieStore.delete('auth_callback');
    cookieStore.delete('auth_mobile_attempt');
    cookieStore.delete('auth_mobile_challenge');
    cookieStore.delete('auth_mobile_state');
}

function mobileCallbackResponse(params: Record<string, string>): NextResponse {
    const callback = new URL('pwusage://auth/callback');
    for (const [key, value] of Object.entries(params)) callback.searchParams.set(key, value);
    const response = NextResponse.redirect(callback);
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('Pragma', 'no-cache');
    response.headers.set('Referrer-Policy', 'no-referrer');
    return response;
}
