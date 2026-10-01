import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { getAppBaseUrl } from '@/lib/url-utils';
import { mobileCallbackResponse } from '@/lib/mobile-login-callback';
import { isValidAppState, isValidMobileLoginParameters } from '@/lib/mobile-login-validation';
import { buildTeslaAuthorizeUrl } from '@/lib/tesla-authorize-url';

export async function GET(request: NextRequest) {
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
    // Nothing downstream will clear these: we never redirect to Tesla, so the
    // callback route that normally does it is never reached.
    clearAuthAttemptCookies(await cookies());
    if (mobileState && isValidAppState(mobileState)) {
      return mobileCallbackResponse({ error: 'login_unavailable', state: mobileState });
    }
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  const state = crypto.randomBytes(16).toString('hex');
  const nonce = crypto.randomBytes(16).toString('hex');

  const cookieStore = await cookies();
  const authCookieOptions = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
  };
  cookieStore.set('auth_state', state, authCookieOptions);
  cookieStore.set('auth_nonce', nonce, authCookieOptions);
  cookieStore.delete('auth_mobile_attempt');
  cookieStore.delete('auth_mobile_challenge');
  cookieStore.delete('auth_mobile_state');
  if (isMobileLogin && mobileChallenge && mobileState) {
    const mobileCookieOptions = { ...authCookieOptions, sameSite: 'lax' as const, path: '/', maxAge: 10 * 60 };
    cookieStore.set('auth_mobile_attempt', crypto.randomUUID(), mobileCookieOptions);
    cookieStore.set('auth_mobile_challenge', mobileChallenge, mobileCookieOptions);
    cookieStore.set('auth_mobile_state', mobileState, mobileCookieOptions);
  }
  if (callback && callback.startsWith('/') && !callback.startsWith('//') && !callback.startsWith('/\\')) {
    cookieStore.set('auth_callback', callback, { httpOnly: true, secure: process.env.NODE_ENV === 'production' });
  }

  const redirectBaseUrl = getAppBaseUrl(request);
  const callbackUrl = `${redirectBaseUrl}/auth/tesla-callback`;

  redirect(buildTeslaAuthorizeUrl({ state, nonce, callbackUrl, clientId }));
}

/**
 * The six cookies a login attempt owns. Mirrors `clearAuthAttemptCookies` in
 * /auth/tesla-callback, which clears the same set on every one of its own
 * failure paths.
 */
function clearAuthAttemptCookies(cookieStore: Awaited<ReturnType<typeof cookies>>): void {
  cookieStore.delete('auth_state');
  cookieStore.delete('auth_nonce');
  cookieStore.delete('auth_callback');
  cookieStore.delete('auth_mobile_attempt');
  cookieStore.delete('auth_mobile_challenge');
  cookieStore.delete('auth_mobile_state');
}
