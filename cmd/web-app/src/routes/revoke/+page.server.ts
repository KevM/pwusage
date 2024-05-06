import {PUBLIC_WEBAPP_BASE_URL as PUBLIC_WEBAPP_BASE_URL, PUBLIC_TESLA_OAUTH_CLIENT_ID} from '$env/static/public';
import type { PageServerLoad } from './$types';
import { redirect } from '@sveltejs/kit';

export const load : PageServerLoad = (async (event) => {

  const uri = getRevokeUri();
  redirect(302, uri)

}) satisfies PageServerLoad;

function getRevokeUri() : string {
  const backUrl = `${PUBLIC_WEBAPP_BASE_URL}/login`
  const uri = `https://auth.tesla.com/user/revoke/consent?revoke_client_id=${PUBLIC_TESLA_OAUTH_CLIENT_ID}&back_url=${backUrl}`;
  return uri
}
