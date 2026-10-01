import { describe, expect, it } from 'vitest';
import { mobileCallbackResponse } from './mobile-login-callback';

/** The redirect target NextResponse.redirect() was handed. */
function locationOf(response: Response): URL {
  return new URL(response.headers.get('location') as string);
}

describe('mobileCallbackResponse', () => {
  it('redirects to the app callback scheme carrying the error and state', () => {
    const response = mobileCallbackResponse({ error: 'login_unavailable', state: 'state-abc' });

    expect(response.status).toBe(307);
    const location = locationOf(response);
    expect(location.protocol).toBe('pwusage:');
    expect(location.host).toBe('auth');
    expect(location.pathname).toBe('/callback');
    expect(location.searchParams.get('error')).toBe('login_unavailable');
    expect(location.searchParams.get('state')).toBe('state-abc');
  });

  it('carries the PKCE handoff exchange on the success shape', () => {
    const response = mobileCallbackResponse({ code: 'handoff-code', attempt: 'attempt-id', state: 'state-abc' });

    const location = locationOf(response);
    expect(location.searchParams.get('code')).toBe('handoff-code');
    expect(location.searchParams.get('attempt')).toBe('attempt-id');
    expect(location.searchParams.get('state')).toBe('state-abc');
    expect(location.searchParams.get('error')).toBeNull();
  });

  // A cached redirect replayed into a later sign-in would hand the app a stale
  // code or error, so all three headers are asserted rather than just Cache-Control.
  it('marks the response no-store, no-cache and no-referrer', () => {
    const response = mobileCallbackResponse({ error: 'state_mismatch', state: 'state-abc' });

    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Pragma')).toBe('no-cache');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
  });
});
