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
