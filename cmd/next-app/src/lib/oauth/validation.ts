import { createHash, timingSafeEqual } from 'node:crypto';
import { OAUTH_SCOPES, type OAuthScope } from './types';

const PKCE_VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
const PKCE_CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
const FORBIDDEN_SCHEMES = new Set(['javascript:', 'data:', 'vbscript:', 'file:', 'blob:']);
const ALLOWED_SCOPES = new Set<string>(OAUTH_SCOPES);

export function isValidCodeChallenge(challenge: string): boolean {
    return PKCE_CHALLENGE_RE.test(challenge);
}

export function verifyPkceS256(verifier: string, challenge: string): boolean {
    if (!PKCE_VERIFIER_RE.test(verifier) || !PKCE_CHALLENGE_RE.test(challenge)) return false;
    const computed = createHash('sha256').update(verifier).digest('base64url');
    const a = Buffer.from(computed);
    const b = Buffer.from(challenge);
    return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Checks a redirect_uri and returns it unchanged. OAuth 2.1 compares redirect
 * URIs as exact strings, so the value is never rewritten (URL.href would, for
 * example, turn http://localhost:8080 into http://localhost:8080/).
 */
export function validateRedirectUri(raw: string): { ok: true; uri: string } | { ok: false; error: string } {
    if (!raw || raw.length > 2048) return { ok: false, error: 'Invalid redirect_uri length' };
    let parsed: URL;
    try {
        parsed = new URL(raw);
    } catch {
        return { ok: false, error: 'Malformed redirect_uri' };
    }
    if (parsed.hash) return { ok: false, error: 'redirect_uri must not contain a fragment' };
    if (FORBIDDEN_SCHEMES.has(parsed.protocol)) return { ok: false, error: 'Forbidden redirect_uri scheme' };
    if (parsed.protocol === 'https:') {
        return parsed.hostname ? { ok: true, uri: raw } : { ok: false, error: 'Missing host' };
    }
    if (parsed.protocol === 'http:') {
        const isLoopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '[::1]';
        return isLoopback
            ? { ok: true, uri: raw }
            : { ok: false, error: 'Non-loopback http redirect_uri is not allowed' };
    }
    // Custom native app schemes (e.g. cursor://, vscode://)
    if (/^[a-z][a-z0-9+.-]*:$/.test(parsed.protocol)) {
        return { ok: true, uri: raw };
    }
    return { ok: false, error: 'Unsupported redirect_uri scheme' };
}

export function parseRequestedScopes(
    rawScope: string | null,
): { ok: true; scopes: OAuthScope[] } | { ok: false; error: string } {
    const trimmed = rawScope?.trim();
    if (!trimmed) return { ok: true, scopes: [...OAUTH_SCOPES] };
    const unique: OAuthScope[] = [];
    for (const token of trimmed.split(/\s+/)) {
        if (!ALLOWED_SCOPES.has(token)) {
            return { ok: false, error: `Unsupported scope: ${token}` };
        }
        const scope = token as OAuthScope;
        if (!unique.includes(scope)) unique.push(scope);
    }
    return unique.length > 0 ? { ok: true, scopes: unique } : { ok: false, error: 'Empty scope' };
}

export function expectedMcpResource(origin: string): string {
    return new URL('/api/mcp', origin).href;
}

export function isValidMcpResource(resource: string | null, origin: string): boolean {
    if (!resource) return false;
    try {
        return new URL(resource).href === expectedMcpResource(origin);
    } catch {
        return false;
    }
}
