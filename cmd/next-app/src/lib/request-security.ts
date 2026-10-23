import type { NextRequest } from 'next/server';

/**
 * Whether a cookie set in response to this request must carry `Secure`.
 *
 * `NODE_ENV` alone is not enough: a TLS deployment that is not built as
 * production would otherwise issue an insecure session cookie. Trust the
 * proxy's forwarded protocol when present, fall back to the parsed request URL,
 * and leave plain-HTTP local development working.
 */
export function isSecureRequest(request: NextRequest): boolean {
    if (process.env.NODE_ENV === 'production') return true;

    const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',', 1)[0]?.trim().toLowerCase();
    return forwardedProto === 'https' || request.nextUrl.protocol === 'https:';
}
