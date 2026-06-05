/**
 * Pure helpers for the /continue auth interstitial, kept separate from the page
 * component so the security-relevant bits (open-redirect guard, device sniffing)
 * are unit-testable without rendering React or mocking next/headers.
 */

/**
 * Only allow forwarding to same-origin, absolute internal paths. Rejects
 * protocol-relative ("//evil"), backslash tricks ("/\\evil"), and absolute URLs
 * so /continue can never be used as an open redirect. Falls back to "/".
 */
export function safeInternalPath(to: string | undefined | null): string {
  if (!to || !to.startsWith('/') || to.startsWith('//') || to.startsWith('/\\')) {
    return '/';
  }
  return to;
}

/** True for iOS devices (iPhone/iPad/iPod), which is where the lock-screen /
 *  Control Center QR scanner runs links in a cookie-less context. */
export function isIOSUserAgent(ua: string | null | undefined): boolean {
  if (!ua) return false;
  return /iPhone|iPad|iPod/i.test(ua);
}

/**
 * Build the absolute /continue gate URL for a QR/deep-link that should forward
 * to `internalPath`. Used by both the battery-hold QR and the TRMNL device QR so
 * deep links share one shape and the same lock-screen-scanner mitigation.
 */
export function continueUrl(origin: string, internalPath: string): string {
  return `${origin}/continue?to=${encodeURIComponent(internalPath)}`;
}
