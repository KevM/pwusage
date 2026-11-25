import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
    expectedMcpResource,
    isValidCodeChallenge,
    isValidMcpResource,
    parseRequestedScopes,
    validateRedirectUri,
    verifyPkceS256,
} from './validation';

describe('oauth validation', () => {
    it('verifies valid PKCE S256 verifier against challenge', () => {
        const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
        const challenge = createHash('sha256').update(verifier).digest('base64url');
        expect(isValidCodeChallenge(challenge)).toBe(true);
        expect(verifyPkceS256(verifier, challenge)).toBe(true);
        expect(verifyPkceS256(`${verifier}x`, challenge)).toBe(false);
    });

    it('rejects short or invalid PKCE verifiers', () => {
        const short = 'too-short';
        const challenge = createHash('sha256').update(short).digest('base64url');
        expect(verifyPkceS256(short, challenge)).toBe(false);
    });

    it('accepts https, loopback http, and safe custom schemes for redirect_uri', () => {
        expect(validateRedirectUri('https://claude.ai/api/mcp/auth_callback').ok).toBe(true);
        expect(validateRedirectUri('http://127.0.0.1:6274/oauth/callback').ok).toBe(true);
        expect(validateRedirectUri('http://localhost:3000/callback').ok).toBe(true);
        expect(validateRedirectUri('cursor://anysphere.cursor-mcp/oauth/callback').ok).toBe(true);
    });

    it('rejects insecure http, fragments, javascript:, and data: redirect_uris', () => {
        expect(validateRedirectUri('http://evil.example/cb').ok).toBe(false);
        expect(validateRedirectUri('https://claude.ai/cb#frag').ok).toBe(false);
        expect(validateRedirectUri('javascript:alert(1)').ok).toBe(false);
        expect(validateRedirectUri('data:text/html,hi').ok).toBe(false);
    });

    it('defaults empty scope to all v1 read scopes and rejects unknown scopes', () => {
        expect(parseRequestedScopes(null)).toEqual({ ok: true, scopes: ['billing:read', 'usage:read'] });
        expect(parseRequestedScopes('billing:read')).toEqual({ ok: true, scopes: ['billing:read'] });
        expect(parseRequestedScopes('billing:read battery:write').ok).toBe(false);
    });

    it('validates RFC 8707 resource matches canonical /api/mcp URL', () => {
        expect(expectedMcpResource('https://pwusage.fm.rodeo')).toBe('https://pwusage.fm.rodeo/api/mcp');
        expect(isValidMcpResource('https://pwusage.fm.rodeo/api/mcp', 'https://pwusage.fm.rodeo')).toBe(true);
        expect(isValidMcpResource('https://other.example/api/mcp', 'https://pwusage.fm.rodeo')).toBe(false);
        expect(isValidMcpResource(null, 'https://pwusage.fm.rodeo')).toBe(false);
    });
});
