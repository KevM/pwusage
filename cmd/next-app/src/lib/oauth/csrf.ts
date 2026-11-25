import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { getAppBaseUrl } from '@/lib/url-utils';

const CSRF_TTL_SECONDS = 30 * 60;

function getCsrfSecret(): string {
    const secret = process.env.AUTH_SECRET?.trim();
    if (
        process.env.NODE_ENV === 'production'
        && (!secret || secret === 'default-dev-secret-do-not-use-in-prod')
    ) {
        throw new Error('AUTH_SECRET environment variable is required in production');
    }
    return secret || 'default-dev-secret-do-not-use-in-prod';
}

function signPayload(payloadB64: string): string {
    return createHmac('sha256', getCsrfSecret())
        .update(`oauth-csrf:${payloadB64}`)
        .digest('base64url');
}

export function createOAuthCsrfToken(userId: string): string {
    const exp = Math.floor(Date.now() / 1000) + CSRF_TTL_SECONDS;
    const nonce = randomBytes(16).toString('base64url');
    const payloadB64 = Buffer.from(JSON.stringify({ uid: userId, exp, nonce }), 'utf8').toString('base64url');
    const sig = signPayload(payloadB64);
    return `${payloadB64}.${sig}`;
}

export async function verifyOAuthCsrfToken(token: string, userId: string): Promise<boolean> {
    if (!token || !userId) return false;
    const parts = token.split('.');
    if (parts.length !== 2) return false;
    const [payloadB64, sig] = parts;
    if (!payloadB64 || !sig) return false;

    const expectedSig = signPayload(payloadB64);
    const a = Buffer.from(sig);
    const b = Buffer.from(expectedSig);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return false;

    try {
        const parsed = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as {
            uid?: unknown;
            exp?: unknown;
        };
        if (parsed.uid !== userId) return false;
        if (typeof parsed.exp !== 'number' || parsed.exp < Math.floor(Date.now() / 1000)) return false;
        return true;
    } catch {
        return false;
    }
}

export function isSameOriginPost(request: Request): boolean {
    const expectedOrigin = new URL(getAppBaseUrl(request)).origin;
    const secFetchSite = request.headers.get('sec-fetch-site');
    if (secFetchSite && secFetchSite !== 'same-origin' && secFetchSite !== 'none') {
        return false;
    }
    const originHeader = request.headers.get('origin');
    if (originHeader) {
        return originHeader === expectedOrigin;
    }
    const refererHeader = request.headers.get('referer');
    if (refererHeader) {
        try {
            return new URL(refererHeader).origin === expectedOrigin;
        } catch {
            return false;
        }
    }
    return false;
}
