import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { NextRequest } from 'next/server';
import crypto from 'crypto';
import { getAppBaseUrl } from '@/lib/url-utils';
import { isValidMobileLoginParameters } from '@/lib/mobile-login-validation';

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

  const scopes = "openid%20energy_device_data%20offline_access%20user_data%20energy_cmds";
  const redirectBaseUrl = getAppBaseUrl(request);
  const callbackUrl = `${redirectBaseUrl}/auth/tesla-callback`;
  const clientId = process.env.PUBLIC_TESLA_OAUTH_CLIENT_ID;

  const uri = `https://auth.tesla.com/oauth2/v3/authorize?&locale=en-US&response_type=code&scope=${scopes}&state=${state}&redirect_uri=${callbackUrl}&client_id=${clientId}&nonce=${nonce}&prompt=login`;

  redirect(uri);
}
