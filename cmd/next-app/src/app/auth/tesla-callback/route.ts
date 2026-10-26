import { logEvent, observeRoute, setLogContext } from '@/lib/observability';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { NextRequest, NextResponse } from 'next/server';
import { TeslaAuthService } from '@/lib/tesla-auth-service';
import { getAppBaseUrl } from '@/lib/url-utils';
import { createMobileLoginHandoff } from '@/lib/mobile-login-handoff';
import { mobileCallbackResponse } from '@/lib/mobile-login-callback';
import { isValidAppState, isValidMobileLoginParameters } from '@/lib/mobile-login-validation';
import { isSecureRequest } from '@/lib/request-security';
import {
    LOGIN_ATTEMPT_SECONDS, isLoginPrefetch, loginAttemptCookieName, productionLoginRedirect, readLoginAttempt, teslaLoginBaseUrl,
} from '@/lib/tesla-login-attempt';

export const maxDuration = 60; // Allow up to 60 seconds on Vercel to avoid timeouts during slow Tesla API / JWKS calls

async function handleGET(request: NextRequest) {
    if (isLoginPrefetch(request)) return new NextResponse(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
    const canonical = productionLoginRedirect(request);
    if (canonical) return NextResponse.redirect(canonical);
    const searchParams = request.nextUrl.searchParams;
    const code = searchParams.get('code');
    const state = searchParams.get('state');
    const redirectBaseUrl = teslaLoginBaseUrl(getAppBaseUrl(request));
    const callbackUrl = `${redirectBaseUrl}/auth/tesla-callback`;
    const cookieStore = await cookies();
    // v2 callbacks never borrow legacy cookies or another attempt's mobile metadata.
    // Keep the legacy reader for logins already in flight during deployment.
    const scoped = state?.startsWith('v2.') ?? false;
    const attemptName = state ? loginAttemptCookieName(state) : undefined;
    const attemptValue = attemptName ? cookieStore.get(attemptName)?.value : undefined;
    const attempt = readLoginAttempt(attemptValue);
    const savedState = scoped ? (attempt ? state : undefined) : cookieStore.get('auth_state')?.value;
    const savedNonce = scoped ? attempt?.nonce : cookieStore.get('auth_nonce')?.value;
    const savedCallback = scoped ? attempt?.callback : cookieStore.get('auth_callback')?.value;
    const mobileAttemptId = scoped ? attempt?.mobileAttemptId : cookieStore.get('auth_mobile_attempt')?.value;
    const mobileChallenge = scoped ? attempt?.mobileChallenge : cookieStore.get('auth_mobile_challenge')?.value;
    const mobileState = scoped ? attempt?.mobileState : cookieStore.get('auth_mobile_state')?.value;
    const hasMobileCookies = !!(mobileAttemptId || mobileChallenge || mobileState);
    let cleared = false;
    const clearAttempt = () => {
        if (cleared) return;
        cleared = true;
        if (scoped) {
            if (attemptName) cookieStore.delete(attemptName);
        } else {
            clearAuthAttemptCookies(cookieStore);
        }
    };
    // Consume this browser's attempt on every terminal path, including denial or throws.
    // Tesla's authorization code and the mobile handoff retain their server-side replay checks.
    if (scoped) clearAttempt();
    logEvent('info', 'tesla.sign-in.callback', {
        loginId: attempt?.loginId, attemptFormat: scoped ? 'v2' : 'legacy',
        ageMs: attempt ? Date.now() - (attempt.expiresAt - LOGIN_ATTEMPT_SECONDS * 1000) : undefined,
    });
    if (!savedState || savedState !== state) {
        logEvent('warn', 'tesla.sign-in.continuity-rejected', {
            reason: scoped ? (attemptValue ? 'invalid-or-expired-attempt' : 'missing-attempt')
                : (savedState ? 'legacy-mismatch' : 'missing-legacy-cookie'),
            attemptFormat: scoped ? 'v2' : 'legacy',
            loginHost: request.nextUrl.host,
            callbackHost: new URL(callbackUrl).host,
        });
    }

    // Validate required environment variables. Both are read by
    // handleTeslaCallback via requireEnv: it throws on a missing one (deliberately,
    // so a misconfiguration can never be posted to Tesla as the literal string
    // "undefined"), and this check is what turns that loud throw into the clean
    // response below instead of a raw 500.
    //
    // Normalized the same way requireEnv normalizes, so this guard agrees with it on
    // what "missing" means. Raw truthiness would treat a whitespace-only value as
    // present, letting it past this check to fail during verification as a confusing
    // `invalid-id-token` instead of the clean response below.
    const clientId = process.env.PUBLIC_TESLA_OAUTH_CLIENT_ID?.trim();
    const clientSecret = process.env.TESLA_OAUTH_SECRET?.trim();
    if (!clientId || !clientSecret) {
        console.error('[AuthCallback] Missing required Tesla OAuth environment variables', {
            hasClientId: !!clientId,
            hasClientSecret: !!clientSecret
        });
        if (hasMobileCookies) clearAttempt();
        if (mobileState && isValidAppState(mobileState)) {
            return mobileCallbackResponse({ error: 'login_unavailable', state: mobileState });
        }
        return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
    }

    if (!code || !state) {
        if (hasMobileCookies) clearAttempt();
        if (mobileState && isValidAppState(mobileState)) {
            return mobileCallbackResponse({
                error: searchParams.get('error') === 'access_denied' ? 'access_denied' : 'missing_code_or_state',
                state: mobileState,
            });
        }
        return NextResponse.json({ error: 'Missing code or state' }, { status: 400 });
    }

    if (hasMobileCookies && (!mobileAttemptId || !mobileChallenge || !mobileState
        || !isValidMobileLoginParameters(mobileChallenge, mobileState))) {
        clearAttempt();
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
        clearAttempt();
        if (mobileState && isValidAppState(mobileState)) {
            return mobileCallbackResponse({ error: 'login_unavailable', state: mobileState });
        }
        return NextResponse.json({ error: 'Mobile login failed' }, { status: 500 });
    }

    if (result.status === 'success') setLogContext({ siteIds: result.siteIds });
    logEvent(result.status === 'success' ? 'info' : 'warn', 'tesla.sign-in.result', { outcome: result.status });

    if (result.status === 'state-mismatch') {
        if (hasMobileCookies) clearAttempt();
        if (mobileState && isValidAppState(mobileState)) {
            return mobileCallbackResponse({ error: 'state_mismatch', state: mobileState });
        }
        return NextResponse.json({ error: 'State mismatch' }, { status: 401 });
    }
    if (result.status === 'token-exchange-failed') {
        if (hasMobileCookies) clearAttempt();
        if (mobileState && isValidAppState(mobileState)) {
            return mobileCallbackResponse({ error: 'token_exchange_failed', state: mobileState });
        }
        return NextResponse.json({ error: 'Failed to exchange token' }, { status: result.statusCode });
    }
    if (result.status === 'invalid-id-token') {
        if (hasMobileCookies) clearAttempt();
        if (mobileState && isValidAppState(mobileState)) {
            return mobileCallbackResponse({ error: 'invalid_id_token', state: mobileState });
        }
        return NextResponse.json({ error: 'Invalid ID token' }, { status: 401 });
    }
    if (result.status === 'nonce-mismatch') {
        if (hasMobileCookies) clearAttempt();
        if (mobileState && isValidAppState(mobileState)) {
            return mobileCallbackResponse({ error: 'nonce_mismatch', state: mobileState });
        }
        return NextResponse.json({ error: 'Nonce mismatch' }, { status: 401 });
    }
    if (result.status === 'db-error') {
        clearAttempt();
        if (mobileState && isValidAppState(mobileState)) {
            return mobileCallbackResponse({ error: 'login_unavailable', state: mobileState });
        }
        return NextResponse.json({ error: 'Could not finish Tesla sign-in' }, { status: 500 });
    }
    if (result.status === 'fleet-api-failed') {
        clearAttempt();
        if (mobileState && isValidAppState(mobileState)) {
            return mobileCallbackResponse({ error: 'product_import_failed', state: mobileState });
        }
        return NextResponse.json({ error: 'Failed to load Tesla products' }, { status: 502 });
    }

    // Success flow - generate cookie & sign JWT
    if (result.status === 'success') {
        if (mobileAttemptId && mobileChallenge && mobileState) {
            if (result.siteIds.length === 0 && !result.roles.includes('admin')) {
                clearAttempt();
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
                clearAttempt();
                return mobileCallbackResponse({ error: 'login_unavailable', state: mobileState });
            }
            clearAttempt();
            return mobileCallbackResponse({ code: handoff.code, attempt: handoff.attemptId, state: mobileState });
        }

        if (result.siteIds.length > 0 || result.roles.includes('admin')) {
            const { signSiteToken, COOKIE_MAX_AGE_SECONDS } = await import('@/lib/auth-jwt');
            // Stamp the user's current session_version so a fresh login after a
            // sign-out-everywhere bump is not immediately treated as revoked.
            const { UserRepo } = await import('@/lib/user-repo');
            const authState = await new UserRepo().getAuthState(result.userId);
            const siteToken = signSiteToken(result.siteIds, result.roles, result.userId, undefined, authState?.sessionVersion ?? 0);

            // Set 24h cookie
            cookieStore.set('site_auth', siteToken, {
                httpOnly: true,
                secure: isSecureRequest(request),
                maxAge: COOKIE_MAX_AGE_SECONDS,
                path: '/',
                sameSite: 'lax'
            });
            console.log('[AuthCallback] Set site_auth token.');
        }
    }

    // Clean up auth cookies
    clearAttempt();

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


export const GET = observeRoute('/auth/tesla-callback', handleGET);
