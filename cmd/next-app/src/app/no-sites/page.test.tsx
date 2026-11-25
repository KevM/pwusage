import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockResolveOAuthClient = vi.fn();

vi.mock('@/lib/oauth/client-resolver', () => ({
    resolveOAuthClient: (...args: unknown[]) => mockResolveOAuthClient(...args),
}));

import NoSitesPage from './page';

describe('NoSitesPage', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('renders switch_account=1 and validated cancel link for /oauth/authorize callback', async () => {
        mockResolveOAuthClient.mockResolvedValueOnce({
            clientId: 'pwu_client_1',
            clientName: 'Claude',
            redirectUris: ['https://claude.ai/cb'],
            clientUri: null,
            kind: 'dcr',
        });

        const callback = '/oauth/authorize?client_id=pwu_client_1&redirect_uri=https%3A%2F%2Fclaude.ai%2Fcb&state=xyz';
        const element = await NoSitesPage({
            searchParams: Promise.resolve({ reason: 'no-products', callback }),
        });
        const html = renderToStaticMarkup(element);

        expect(html).toContain('Try a different Tesla account');
        expect(html).toContain(`/login?switch_account=1&amp;callback=${encodeURIComponent(callback)}`);
        expect(html).toContain('Cancel and return to app');
        expect(html).toContain('https://claude.ai/cb?error=access_denied&amp;state=xyz');
    });

    it('omits cancel link when OAuth client or redirect_uri fails validation', async () => {
        mockResolveOAuthClient.mockResolvedValueOnce({
            clientId: 'pwu_client_1',
            clientName: 'Claude',
            redirectUris: ['https://claude.ai/cb'],
            clientUri: null,
            kind: 'dcr',
        });

        const callback = '/oauth/authorize?client_id=pwu_client_1&redirect_uri=https%3A%2F%2Fevil.example%2Fcb&state=xyz';
        const element = await NoSitesPage({
            searchParams: Promise.resolve({ reason: 'no-products', callback }),
        });
        const html = renderToStaticMarkup(element);

        expect(html).toContain('Try a different Tesla account');
        expect(html).not.toContain('Cancel and return to app');
        expect(html).not.toContain('access_denied');
        expect(html).not.toContain('href="https://evil.example');
    });
});
