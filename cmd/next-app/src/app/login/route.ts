import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { NextRequest } from 'next/server';
import crypto from 'crypto';
import { getAppBaseUrl } from '@/lib/url-utils';
import { isValidMobileLoginParameters } from '@/lib/mobile-login-validation';
import { requireEnv } from '@/lib/tesla-token-endpoint';

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const callback = searchParams.get('callback');
  const mobileChallenge = searchParams.get('mobile_challenge');
  const mobileState = searchParams.get('mobile_state');

  const isMobileLogin = mobileChallenge !== null || mobileState !== null;
  if (isMobileLogin && (!mobileChallenge || !mobileState || !isValidMobileLoginParameters(mobileChallenge, mobileState))) {
    return new Response('Invalid mobile login request', { status: 400 });
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
  // Third Tesla credential path to read this through requireEnv, alongside
  // tesla-auth.ts and tesla-auth-service.ts, so a missing variable fails loudly
  // at the point of use.
  // Deliberately positioned after the cookie writes: Next.js discards the pending
  // cookie buffer on a throw, so this order means a missing client id produces no
  // Set-Cookie headers at all.
  const clientId = requireEnv('PUBLIC_TESLA_OAUTH_CLIENT_ID');

  redirect(buildTeslaAuthorizeUrl({ state, nonce, callbackUrl, clientId }));
}

const TESLA_AUTHORIZE_ENDPOINT = 'https://auth.tesla.com/oauth2/v3/authorize';

export interface TeslaAuthorizeUrlParams {
  state: string;
  nonce: string;
  callbackUrl: string;
  clientId: string;
}

export function buildTeslaAuthorizeUrl(params: TeslaAuthorizeUrlParams): string {
  const query = [
    ['locale', 'en-US'],
    ['response_type', 'code'],
    // Passed as a single space-separated value and encoded below, so the
    // separators become %20 exactly as before.
    ['scope', 'openid energy_device_data offline_access user_data energy_cmds'],
    ['state', params.state],
    ['redirect_uri', params.callbackUrl],
    ['client_id', params.clientId],
    ['nonce', params.nonce],
    // Purpose-built replacement for prompt=login. Tesla documents this for
    // picking up newly-granted scopes; prompt=login additionally forces a full
    // re-authentication on every login.
    ['prompt_missing_scopes', 'true'],
  ]
    // encodeURIComponent rather than URLSearchParams: toString() encodes spaces as
    // "+", and production already emits %20 today with login working, so keeping
    // %20 preserves known-working behavior. Every value is encoded here, which
    // the previous template literal skipped for redirect_uri, state and nonce.
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&');

  return `${TESLA_AUTHORIZE_ENDPOINT}?${query}`;
}
