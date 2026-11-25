import { createHash, timingSafeEqual } from 'node:crypto';
import { getAppBaseUrl } from '../url-utils';
import { OAUTH_SCOPES, type OAuthScope } from './types';

const PKCE_VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
const PKCE_CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
const FORBIDDEN_SCHEMES = new Set([
    'javascript:', 'data:', 'vbscript:', 'file:', 'blob:',
    // PWUsage's own iOS sign-in callback: a client must not borrow or impersonate it.
    'pwusage:',
    // Network schemes that would carry the code in plaintext or off the loopback rule.
    'ws:', 'wss:', 'ftp:', 'ftps:',
    // Browser and OS handlers.
    'chrome:', 'chrome-extension:', 'edge:', 'safari-extension:', 'moz-extension:', 'intent:', 'about:', 'view-source:',
]);
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
        if (!parsed.hostname) return { ok: false, error: 'Missing host' };
        // A code sent to PWUsage itself has no client to receive it; at best it
        // makes the consent screen show PWUsage as the destination.
        if (parsed.origin === appOrigin()) return { ok: false, error: 'redirect_uri must not be PWUsage itself' };
        return { ok: true, uri: raw };
    }
    if (parsed.protocol === 'http:') {
        const isLoopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '[::1]';
        return isLoopback
            ? { ok: true, uri: raw }
            : { ok: false, error: 'Non-loopback http redirect_uri is not allowed' };
    }
    // Custom native app schemes (RFC 8252 §7.1): cursor://…, vscode://…, or
    // reverse-domain com.example.app:/path. Must be hierarchical (scheme:/…), which
    // rules out opaque handlers such as mailto:, tel: and sms:. Reverse-domain is
    // preferred but not required: Cursor and VS Code use plain schemes.
    if (/^[a-z][a-z0-9+.-]*:$/.test(parsed.protocol) && raw.slice(parsed.protocol.length).startsWith('/')) {
        return { ok: true, uri: raw };
    }
    return { ok: false, error: 'Unsupported redirect_uri scheme' };
}

function appOrigin(): string | null {
    try {
        return new URL(getAppBaseUrl()).origin;
    } catch {
        return null;
    }
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
