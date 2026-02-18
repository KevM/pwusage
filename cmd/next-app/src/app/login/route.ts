import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { NextRequest } from 'next/server';

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const callback = searchParams.get('callback');

  const state = Math.random().toString(36).substring(2, 15);
  const nonce = Math.random().toString(36).substring(2, 15);

  const cookieStore = await cookies();
  cookieStore.set('auth_state', state, { httpOnly: true, secure: process.env.NODE_ENV === 'production' });
  cookieStore.set('auth_nonce', nonce, { httpOnly: true, secure: process.env.NODE_ENV === 'production' });
  if (callback) {
    cookieStore.set('auth_callback', callback, { httpOnly: true, secure: process.env.NODE_ENV === 'production' });
  }

  const scopes = "openid%20energy_device_data%20offline_access%20user_data%20energy_cmds";
  const redirectBaseUrl = process.env.NEXT_PUBLIC_APP_URL || request.nextUrl.origin;
  const callbackUrl = `${redirectBaseUrl.replace(/\/$/, '')}/auth/tesla-callback`;
  const clientId = process.env.PUBLIC_TESLA_OAUTH_CLIENT_ID;

  const uri = `https://auth.tesla.com/oauth2/v3/authorize?&locale=en-US&response_type=code&scope=${scopes}&state=${state}&redirect_uri=${callbackUrl}&client_id=${clientId}&nonce=${nonce}&prompt=login`;

  redirect(uri);
}
