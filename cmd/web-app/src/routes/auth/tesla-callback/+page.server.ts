import type { PageServerLoad } from "./$types";
import {env as private_env} from '$env/dynamic/private';
import {env as public_env} from '$env/dynamic/public';

export const load : PageServerLoad = (async (event) => {
  const code = event.url.searchParams.get("code") || "";
  const nonce = event.url.searchParams.get("nonce") || "";
  const state = event.url.searchParams.get("state") || "";

  // post to tesla to get the access and refresh tokens
  const response = await fetch("https://auth.tesla.com/oauth2/v3/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: public_env.PUBLIC_TESLA_OAUTH_CLIENT_ID,
      client_secret: private_env.TESLA_OAUTH_SECRET,
      audience: public_env.PUBLIC_TESLA_OAUTH_AUDIENCE,
      redirect_uri: public_env.PUBLIC_TESLA_CALLBACK_URL,
      grant_type: "authorization_code",
      code: code,
    }),
  });

  if (!response.ok) {
    console.error(`Error: ${response.status}`);
    return;
  }

  const auth = (await response.json()) as AuthResponse;

  if (auth.state !== state) {
    console.error("State from auth token POST does not match.");
    return {
      status: 401,
      body: 'Authentication failed: state mismatch.'
    };
  }
  auth.nonce = nonce;

  return {
    auth: auth,
  };

}) satisfies PageServerLoad;

interface AuthResponse {
  access_token: string;
  refresh_token: string;
  id_token: string;
  expires_in: number;
  state: string;
  token_type: string;
  nonce: string;
}