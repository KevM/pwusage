import type { PageServerLoad } from "./$types";
import {env as private_env} from '$env/dynamic/private';
import {env as public_env} from '$env/dynamic/public';
import { userAuthRepo } from '$lib/userRepo';
import jwt from 'jsonwebtoken';
import { redirect } from "@sveltejs/kit";

export const load : PageServerLoad = (async (event) => {
  const code = event.url.searchParams.get("code") || "";
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
      redirect_uri: public_env.PUBLIC_WEBAPP_BASE_URL + "/auth/tesla-callback",
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

  // load nonce and call back for state from db
  const ua = userAuthRepo.read(state);
  if (ua === undefined) {
    console.error("Error reading user auth from repo.");
    return {
      status: 500,
      body: 'Authentication failed: repo read error.'
    };
  }

  // verify the id token nonce 
  const decoded = jwt.decode(auth.id_token) as jwt.JwtPayload | null;
  if (decoded === null) {
    console.error("Error decoding id token");
    return {
      status: 401,
      body: 'Authentication failed: id token decode error.'
    };
  }
  const nonce  = decoded["nonce"];
  if (nonce !== ua.nonce) {
    console.error("Nonce from id token does not match.");
    return {
      status: 401,
      body: 'Authentication failed: nonce mismatch.'
    };
  }

  if (ua.callback != null) {
    redirect(302, ua.callback + `?auth=${auth.access_token}&refresh=${auth.refresh_token}&id=${auth.id_token}`);
  }

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
}