const BASE64URL_VALUE = /^[A-Za-z0-9_-]+$/;
const ATTEMPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidAppState(appState: string): boolean {
  return appState.length >= 22
    && appState.length <= 128
    && BASE64URL_VALUE.test(appState);
}

export function isValidMobileLoginParameters(codeChallenge: string, appState: string): boolean {
  return codeChallenge.length === 43
    && BASE64URL_VALUE.test(codeChallenge)
    && isValidAppState(appState);
}

export function isValidMobileLoginExchangeParameters(
  attemptId: string,
  code: string,
  verifier: string,
  appState: string,
): boolean {
  return ATTEMPT_ID.test(attemptId)
    && code.length === 43
    && BASE64URL_VALUE.test(code)
    && verifier.length >= 43
    && verifier.length <= 128
    && BASE64URL_VALUE.test(verifier)
    && isValidAppState(appState);
}
