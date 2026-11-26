import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { UserOAuthGrantSummary } from '@/lib/oauth/oauth-repo';
import {
    ConnectionsList,
    CreatedToken,
    requestConnections,
    requestCreateToken,
    requestRevoke,
    withCreated,
    withoutGrant,
} from './Connections';

const app: UserOAuthGrantSummary = {
    id: 'app-1', kind: 'app', clientId: 'https://claude.ai/oauth/client.json', clientName: 'Claude', clientUri: null,
    scopes: ['billing:read', 'usage:read'], createdAt: '2026-11-25T00:00:00Z', lastUsedAt: null,
    maxExpiresAt: '2027-02-23T00:00:00Z', siteCount: 1, publisherHost: 'claude.ai',
};
const token: UserOAuthGrantSummary = {
    id: 'token-1', kind: 'token', clientId: 'pwu_integration', clientName: 'ecobee aux', clientUri: null,
    scopes: ['billing:read'], createdAt: '2026-11-24T00:00:00Z', lastUsedAt: '2026-11-25T12:00:00Z',
    maxExpiresAt: null, siteCount: 1, publisherHost: null,
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const noop = () => undefined;
const renderList = (grants: UserOAuthGrantSummary[]) => renderToStaticMarkup(
    <ConnectionsList grants={grants} busyId={null} onRevoke={noop} />,
);

describe('Connections', () => {
    it('lists apps and tokens from one request', async () => {
        const fetchFn = vi.fn().mockResolvedValue(json({ grants: [app, token] }));
        const grants = await requestConnections('home 1', fetchFn);
        expect(fetchFn).toHaveBeenCalledTimes(1);
        expect(fetchFn.mock.calls[0][0]).toBe('/api/oauth/grants?siteId=home%201');

        const html = renderList(grants);
        expect(html).toContain('Claude');
        expect(html).toContain('App details from claude.ai');
        expect(html).toMatch(/aria-label="Disconnect Claude"[^>]*>Disconnect</);
        expect(html).toContain('ecobee aux');
        expect(html).toContain('Integration token · Billing');
        expect(html).toMatch(/aria-label="Revoke ecobee aux"[^>]*>Revoke</);
    });

    it('renders a token with null maxExpiresAt without "Invalid Date"', () => {
        const html = renderList([token]);
        expect(html).not.toContain('Invalid Date');
        expect(html).toContain('Last used');
    });

    it('shows a created token once and adds it to the list', async () => {
        const fetchFn = vi.fn().mockResolvedValue(json({ grant: token, token: 'pwu_int_secret' }, 201));
        const created = await requestCreateToken('home', 'ecobee aux', fetchFn);
        expect(fetchFn).toHaveBeenCalledWith('/api/oauth/grants', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ siteId: 'home', name: 'ecobee aux' }),
        });
        expect(created.token).toBe('pwu_int_secret');
        expect(withCreated([app], created.grant).map(g => g.id)).toEqual(['token-1', 'app-1']);

        const html = renderToStaticMarkup(<CreatedToken token={created.token} copied={false} onCopy={noop} />);
        expect(html).toContain('Copy this token now. It’s shown once.');
        expect(html).toContain('value="pwu_int_secret"');
    });

    it('shows the server’s reason when a token can’t be created', async () => {
        const fetchFn = vi.fn().mockResolvedValue(json({ error: 'This home already has 5 integration tokens. Revoke one first.' }, 409));
        await expect(requestCreateToken('home', 'Script', fetchFn))
            .rejects.toThrow('This home already has 5 integration tokens. Revoke one first.');
    });

    it('revoking removes the row', async () => {
        const fetchFn = vi.fn().mockResolvedValue(json({ error: 'Grant not found' }, 404));
        expect(await requestRevoke('token-1', fetchFn)).toBe(true);
        expect(fetchFn).toHaveBeenCalledWith('/api/oauth/grants/token-1', { method: 'DELETE' });
        expect(withoutGrant([app, token], 'token-1')).toEqual([app]);

        fetchFn.mockResolvedValue(json({ error: 'nope' }, 500));
        expect(await requestRevoke('token-1', fetchFn)).toBe(false);
    });
});
