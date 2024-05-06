import { userAuthRepo } from '$lib/userRepo';
import {PUBLIC_WEBAPP_BASE_URL, PUBLIC_TESLA_OAUTH_CLIENT_ID} from '$env/static/public';
import type { PageServerLoad } from './$types';
import { redirect } from '@sveltejs/kit';

export const load : PageServerLoad = (async (event) => {

  const state = Math.random().toString(36).substring(2, 12);
  const callback = event.url.searchParams.get("callback") || undefined;
  const nonce = event.url.searchParams.get("nonce") || Math.random().toString(36).substring(2, 12);

  userAuthRepo.write({state, nonce, callback: callback});

  const uri = getLoginUri(state, nonce);
  redirect(302, uri)

}) satisfies PageServerLoad;

function getLoginUri(state: string, nonce: string) : string {
  const scopes = "openid%20energy_device_data%20offline_access%20user_data%20energy_cmds"
  const callbackUrl = `${PUBLIC_WEBAPP_BASE_URL}/auth/tesla-callback`
  const uri = `https://auth.tesla.com/oauth2/v3/authorize?&locale=en-US&prompt=login&response_type=code&scope=${scopes}&state=${state}&redirect_uri=${callbackUrl}&client_id=${PUBLIC_TESLA_OAUTH_CLIENT_ID}&nonce=${nonce}`;
  return uri
}
