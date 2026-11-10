import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AccountDeleteDonePage, { metadata } from './page';

describe('/account-delete/done', () => {
    beforeEach(() => { vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://pwusage.test'); });
    afterEach(() => { vi.unstubAllEnvs(); });

    it('links to the Tesla consent page and returns here', () => {
        vi.stubEnv('PUBLIC_TESLA_OAUTH_CLIENT_ID', 'client-123');
        const html = renderToStaticMarkup(<AccountDeleteDonePage />);
        expect(html).toContain('https://auth.tesla.com/user/revoke/consent?revoke_client_id=client-123');
        expect(html).toContain(encodeURIComponent('https://pwusage.test/account-delete/done'));
    });

    it('falls back to instructions without a client id', () => {
        vi.stubEnv('PUBLIC_TESLA_OAUTH_CLIENT_ID', '');
        const html = renderToStaticMarkup(<AccountDeleteDonePage />);
        expect(html).not.toContain('auth.tesla.com');
        expect(html).toContain('third-party app settings');
    });

    it('stays out of search results', () => {
        expect(metadata.robots).toEqual({ index: false, follow: false });
    });
});
