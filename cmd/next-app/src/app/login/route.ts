import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { getAppBaseUrl } from '@/lib/url-utils';
import { mobileCallbackResponse } from '@/lib/mobile-login-callback';
import { isValidAppState, isValidMobileLoginParameters } from '@/lib/mobile-login-validation';
import { isSecureRequest } from '@/lib/request-security';
import { buildTeslaAuthorizeUrl } from '@/lib/tesla-authorize-url';
import { logEvent, observeRoute } from '@/lib/observability';
import {
  LOGIN_ATTEMPT_SECONDS, MAX_LOGIN_ATTEMPTS, isAttemptCookie, isLoginPrefetch,
  loginAttemptCookieName, productionLoginRedirect, safeLoginCallback, teslaLoginBaseUrl,
  type TeslaLoginAttempt,
} from '@/lib/tesla-login-attempt';

async function handleGET(request: NextRequest) {
  if (isLoginPrefetch(request)) return new NextResponse(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  const canonical = productionLoginRedirect(request);
  if (canonical) return NextResponse.redirect(canonical);

  const searchParams = request.nextUrl.searchParams;
  const callback = searchParams.get('callback');
  const mobileChallenge = searchParams.get('mobile_challenge');
  const mobileState = searchParams.get('mobile_state');

  const isMobileLogin = mobileChallenge !== null || mobileState !== null;
  if (isMobileLogin && (!mobileChallenge || !mobileState || !isValidMobileLoginParameters(mobileChallenge, mobileState))) {
    return new Response('Invalid mobile login request', { status: 400 });
  }

  // Intercept a missing client id rather than letting requireEnv throw, matching
  // what /auth/tesla-callback already does. A throw here is user-visible on iOS:
  // no pwusage://auth/callback is ever produced, so the app reports
  // `invalidCallback` and presents a raw Next.js 500 page instead of
  // `AuthError.serverRejectedLogin`.
  //
  // Normalized the same way requireEnv normalizes, so this guard agrees with it
  // on what "missing" means; raw truthiness would let a whitespace-only value
  // through to fail later as a confusing authorize-URL rejection.
  //
  // Deliberately positioned before the cookie writes so a misconfigured deploy
  // emits no Set-Cookie headers at all.
  const clientId = process.env.PUBLIC_TESLA_OAUTH_CLIENT_ID?.trim();
  if (!clientId) {
    console.error('[Login] Missing required Tesla OAuth environment variables', {
      missing: 'PUBLIC_TESLA_OAUTH_CLIENT_ID',
      isMobileLogin,
    });
    if (mobileState && isValidAppState(mobileState)) {
      return mobileCallbackResponse({ error: 'login_unavailable', state: mobileState });
    }
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  const cookieStore = await cookies();
  const pendingCount = cookieStore.getAll().filter(cookie => isAttemptCookie(cookie.name)).length;
  if (pendingCount >= MAX_LOGIN_ATTEMPTS) {
    logEvent('warn', 'tesla.sign-in.limited', { pendingCount });
    if (mobileState && isValidAppState(mobileState)) {
      return mobileCallbackResponse({ error: 'login_unavailable', state: mobileState });
    }
    return NextResponse.json({ error: 'Several sign-ins are already in progress. Finish one or try again in 10 minutes.' },
      { status: 429, headers: { 'Cache-Control': 'no-store', 'Retry-After': String(LOGIN_ATTEMPT_SECONDS) } });
  }
  const state = `v2.${crypto.randomBytes(16).toString('hex')}`;
  const nonce = crypto.randomBytes(16).toString('hex');
  const attempt: TeslaLoginAttempt = {
    nonce,
    loginId: crypto.randomUUID(),
    expiresAt: Date.now() + LOGIN_ATTEMPT_SECONDS * 1000,
    callback: safeLoginCallback(callback),
    ...(isMobileLogin && mobileChallenge && mobileState ? {
      mobileAttemptId: crypto.randomUUID(), mobileChallenge, mobileState,
    } : {}),
  };
  const cookieName = loginAttemptCookieName(state);
  if (!cookieName) throw new Error('Invalid generated login attempt');
  cookieStore.set(cookieName, JSON.stringify(attempt), {
    httpOnly: true, secure: isSecureRequest(request), sameSite: 'lax', path: '/', maxAge: LOGIN_ATTEMPT_SECONDS,
  });
  logEvent('info', 'tesla.sign-in.started', {
    loginId: attempt.loginId, loginKind: isMobileLogin ? 'mobile' : 'web', pendingCount,
    loginHost: request.nextUrl.host, callbackHost: new URL(teslaLoginBaseUrl(getAppBaseUrl(request))).host,
  });

  const redirectBaseUrl = teslaLoginBaseUrl(getAppBaseUrl(request));
  const callbackUrl = `${redirectBaseUrl}/auth/tesla-callback`;
  redirect(buildTeslaAuthorizeUrl({ state, nonce, callbackUrl, clientId }));
}

export const GET = observeRoute('/login', handleGET);
