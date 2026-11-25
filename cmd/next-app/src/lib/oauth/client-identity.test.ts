import { describe, expect, it } from 'vitest';
import { describeClientIdentity } from './client-identity';
import type { OAuthClientMetadata } from './types';

const dcr = (overrides: Partial<OAuthClientMetadata> = {}): OAuthClientMetadata => ({
    clientId: 'pwu_client_1',
    clientName: 'Claude',
    redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
    clientUri: 'https://claude.ai',
    kind: 'dcr',
    ...overrides,
});

describe('describeClientIdentity', () => {
    it('never vouches for a self-registered app whose homepage is on another site than its redirect', () => {
        // The consent-phishing shape: name and homepage claim Claude, the code goes to the attacker.
        const identity = describeClientIdentity(
            dcr({ clientUri: 'https://claude.ai', redirectUris: ['https://attacker.example/cb'] }),
            'https://attacker.example/cb',
        );
        expect(identity).toEqual({
            name: 'Claude',
            verified: false,
            publisherHost: null,
            returnTo: { kind: 'web', host: 'attacker.example' },
            homepageHost: null,
        });
    });

    it('shows the homepage of a self-registered app when it is on the same site as the redirect', () => {
        const identity = describeClientIdentity(dcr(), 'https://claude.ai/api/mcp/auth_callback');
        expect(identity.verified).toBe(false);
        expect(identity.returnTo).toEqual({ kind: 'web', host: 'claude.ai' });
        expect(identity.homepageHost).toBe('claude.ai');
    });

    it('accepts a homepage on a parent or child domain of the redirect host', () => {
        expect(describeClientIdentity(
            dcr({ clientUri: 'https://www.example.com', redirectUris: ['https://auth.example.com/cb'] }),
            'https://auth.example.com/cb',
        ).homepageHost).toBeNull(); // siblings: neither contains the other
        expect(describeClientIdentity(
            dcr({ clientUri: 'https://example.com', redirectUris: ['https://auth.example.com/cb'] }),
            'https://auth.example.com/cb',
        ).homepageHost).toBe('example.com');
        // A look-alike suffix is not a subdomain.
        expect(describeClientIdentity(
            dcr({ clientUri: 'https://claude.ai', redirectUris: ['https://evilclaude.ai/cb'] }),
            'https://evilclaude.ai/cb',
        ).homepageHost).toBeNull();
    });

    it('treats a metadata-document app as published by the host that serves its client_id', () => {
        const identity = describeClientIdentity({
            clientId: 'https://claude.ai/oauth/mcp-client.json',
            clientName: 'Claude',
            redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
            clientUri: 'https://claude.ai',
            kind: 'cimd',
        }, 'https://claude.ai/api/mcp/auth_callback');
        expect(identity).toMatchObject({ verified: true, publisherHost: 'claude.ai', homepageHost: 'claude.ai' });
    });

    it('labels loopback and custom-scheme redirects as apps on the device', () => {
        expect(describeClientIdentity(
            dcr({ clientUri: 'https://claude.ai', redirectUris: ['http://127.0.0.1:33418/callback'] }),
            'http://127.0.0.1:33418/callback',
        )).toMatchObject({ returnTo: { kind: 'device' }, homepageHost: null });
        expect(describeClientIdentity(
            dcr({ clientName: 'Cursor', clientUri: 'https://cursor.com', redirectUris: ['cursor://anysphere.cursor-mcp/oauth/callback'] }),
            'cursor://anysphere.cursor-mcp/oauth/callback',
        )).toMatchObject({ returnTo: { kind: 'app', scheme: 'cursor' }, homepageHost: null });
    });
});
