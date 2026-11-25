import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ClientIdentity } from '@/lib/oauth/client-identity';
import { ClientIdentityNotice } from './ClientIdentityNotice';

const render = (identity: ClientIdentity) => renderToStaticMarkup(<ClientIdentityNotice identity={identity} />);

describe('ClientIdentityNotice', () => {
    it('flags a self-registered app and names where the browser returns', () => {
        const html = render({
            name: 'Claude', verified: false, publisherHost: null,
            returnTo: { kind: 'web', host: 'attacker.example' }, homepageHost: null,
        });
        expect(html).toContain('Unverified app');
        expect(html).toContain('attacker.example');
        expect(html).not.toContain('claude.ai');
    });

    it('names the publisher of a metadata-document app', () => {
        const html = render({
            name: 'Claude', verified: true, publisherHost: 'claude.ai',
            returnTo: { kind: 'web', host: 'claude.ai' }, homepageHost: 'claude.ai',
        });
        expect(html).toContain('Published by');
        expect(html).toContain('claude.ai');
        expect(html).not.toContain('Unverified app');
    });

    it('describes device and app-scheme returns', () => {
        expect(render({
            name: 'Tool', verified: false, publisherHost: null, returnTo: { kind: 'device' }, homepageHost: null,
        })).toContain('an app on this device');
        expect(render({
            name: 'Cursor', verified: false, publisherHost: null, returnTo: { kind: 'app', scheme: 'cursor' }, homepageHost: null,
        })).toContain('cursor://');
    });
});
