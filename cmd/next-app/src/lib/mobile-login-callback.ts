import { NextResponse } from 'next/server';

/**
 * Error codes the iOS client may receive on its `pwusage://auth/callback` URL.
 *
 * The app currently maps *any* `error` parameter to `AuthError.serverRejectedLogin`
 * (MobileAuthService.swift), so these strings are a server-side contract rather
 * than something either side branches on yet. They are still typed: the point is
 * that adding a call site with a misspelled code is a compile error, not a
 * silently unrecognised status the app renders as a generic failure.
 */
export type MobileLoginErrorCode =
  | 'login_unavailable'
  | 'missing_code_or_state'
  | 'access_denied'
  | 'invalid_login_attempt'
  | 'state_mismatch'
  | 'token_exchange_failed'
  | 'invalid_id_token'
  | 'nonce_mismatch'
  | 'no_sites';

/**
 * Either a failure (which the app surfaces as `AuthError.serverRejectedLogin`)
 * or the one-time PKCE handoff exchange. Every payload carries `state` so the app
 * can match the response against the sign-in it started.
 */
export type MobileCallbackParams =
  | { error: MobileLoginErrorCode; state: string }
  | { code: string; attempt: string; state: string };

/**
 * Build the `pwusage://auth/callback` redirect the iOS app is waiting on.
 *
 * Shared by `/login` and `/auth/tesla-callback`: both need to end a mobile
 * attempt by redirecting to the app, and both must set the same no-store headers
 * so a cached redirect cannot be replayed as a successful sign-in.
 */
export function mobileCallbackResponse(params: MobileCallbackParams): NextResponse {
  const callback = new URL('pwusage://auth/callback');
  for (const [key, value] of Object.entries(params)) callback.searchParams.set(key, value);
  const response = NextResponse.redirect(callback);
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('Pragma', 'no-cache');
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
}
