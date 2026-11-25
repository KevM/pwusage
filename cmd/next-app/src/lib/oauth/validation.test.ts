import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
    expectedMcpResource,
    isValidCodeChallenge,
    parseRequestedScopes,
    validateRedirectUri,
    verifyPkceS256,
    resolveMcpResource,
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

    it('keeps a valid redirect_uri exactly as sent (OAuth 2.1 exact string matching)', () => {
        // URL.href would append "/" here, so a code stored with the rewritten form
        // failed the token exchange against the client's original string.
        for (const uri of ['http://localhost:8080', 'https://claude.ai', 'cursor://anysphere.cursor-mcp/oauth/callback', 'https://claude.ai/cb?x=1']) {
            expect(validateRedirectUri(uri)).toEqual({ ok: true, uri });
        }
    });

    it('rejects insecure http, fragments, javascript:, and data: redirect_uris', () => {
        expect(validateRedirectUri('http://evil.example/cb').ok).toBe(false);
        expect(validateRedirectUri('https://claude.ai/cb#frag').ok).toBe(false);
        expect(validateRedirectUri('javascript:alert(1)').ok).toBe(false);
        expect(validateRedirectUri('data:text/html,hi').ok).toBe(false);
    });

    it("rejects PWUsage's own origin and app scheme, network and opaque schemes", () => {
        vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://pwusage.fm.rodeo');
        try {
            for (const uri of [
                'pwusage://auth/callback', // the iOS app's own sign-in callback
                'https://pwusage.fm.rodeo/oauth/cb',
                'ws://evil.example/cb', 'wss://evil.example/cb', 'ftp://evil.example/cb', 'ftps://evil.example/cb',
                'mailto:attacker@evil.example', 'tel:5551234', 'sms:5551234', 'about:blank',
                'view-source:https://evil.example', 'chrome://settings', 'intent://scan#Intent;end',
            ]) {
                expect(validateRedirectUri(uri).ok, uri).toBe(false);
            }
            // Native apps in the wild use plain hierarchical schemes (RFC 8252 prefers reverse-domain but does not require it).
            expect(validateRedirectUri('cursor://anysphere.cursor-mcp/oauth/callback').ok).toBe(true);
            expect(validateRedirectUri('vscode://vscode.github-authentication/did-authenticate').ok).toBe(true);
            expect(validateRedirectUri('com.example.app:/oauth2redirect').ok).toBe(true);
        } finally {
            vi.unstubAllEnvs();
        }
    });

    it('resolves any spelling of the MCP resource to the one canonical string, and rejects others', () => {
        const origin = 'https://pwusage.fm.rodeo';
        const canonical = 'https://pwusage.fm.rodeo/api/mcp';
        for (const raw of [null, '', canonical, 'https://pwusage.fm.rodeo:443/api/mcp', 'HTTPS://PWUSAGE.fm.rodeo/api/mcp']) {
            expect(resolveMcpResource(raw, origin), String(raw)).toBe(canonical);
        }
        for (const raw of ['https://pwusage.fm.rodeo/api/mcp/', 'https://evil.example/api/mcp', 'not a url']) {
            expect(resolveMcpResource(raw, origin), raw).toBeNull();
        }
    });

    it('defaults empty scope to all v1 read scopes and rejects unknown scopes', () => {
        expect(parseRequestedScopes(null)).toEqual({ ok: true, scopes: ['billing:read', 'usage:read'] });
        expect(parseRequestedScopes('billing:read')).toEqual({ ok: true, scopes: ['billing:read'] });
        expect(parseRequestedScopes('billing:read battery:write').ok).toBe(false);
    });

    it('validates RFC 8707 resource matches canonical /api/mcp URL', () => {
        expect(expectedMcpResource('https://pwusage.fm.rodeo')).toBe('https://pwusage.fm.rodeo/api/mcp');
        expect(resolveMcpResource('https://pwusage.fm.rodeo/api/mcp', 'https://pwusage.fm.rodeo')).toBe('https://pwusage.fm.rodeo/api/mcp');
        expect(resolveMcpResource('https://other.example/api/mcp', 'https://pwusage.fm.rodeo')).toBeNull();
    });
});
