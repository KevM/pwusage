import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    getCurrentUser: vi.fn(),
    getSites: vi.fn(),
    redirect: vi.fn((url: string) => { throw new Error(`redirect:${url}`); }),
}));

vi.mock('@/lib/auth-checks', () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock('@/lib/account-deletion-service', () => ({ getAccountDeletionSites: mocks.getSites }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));

import AccountDeletePage, { metadata } from './page';

const render = async () => renderToStaticMarkup(await AccountDeletePage());

describe('/account-delete', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getCurrentUser.mockResolvedValue({ id: 'user-1' });
        mocks.getSites.mockResolvedValue([
            { id: 's1', name: 'Lake House', shared: false, otherMembers: [], batterySaverReserve: null, restoredOnLeave: true },
        ]);
    });

    it('sends signed-out visitors through login and back', async () => {
        mocks.getCurrentUser.mockResolvedValue(null);
        await expect(render()).rejects.toThrow('redirect:/login?callback=/account-delete');
    });

    it('stays out of search results', () => {
        expect(metadata.robots).toEqual({ index: false, follow: false });
    });

    it('lists sole-member sites that will be deleted and starts with the button disabled', async () => {
        const html = await render();
        expect(html).toContain('Lake House');
        expect(html).not.toContain('Battery Saver is on');
        expect(html).toMatch(/<button[^>]*disabled[^>]*>Permanently Delete Account/);
        expect(html).toContain('href="/account-delete/cancel"');
    });

    it('distinguishes shared sites that stay available to other members', async () => {
        mocks.getSites.mockResolvedValue([
            { id: 's1', name: 'Lake House', shared: false, otherMembers: [], batterySaverReserve: null, restoredOnLeave: true },
            { id: 's2', name: 'Main Home', shared: true, otherMembers: ['sam@example.com', 'lee@example.com'], batterySaverReserve: null, restoredOnLeave: false },
        ]);
        const html = await render();
        expect(html).toContain('Lake House');
        expect(html).toContain('Main Home');
        expect(html).toContain('stay available to the other members');
        expect(html).toContain('Main Home is shared');
        expect(html).toContain('Also has access: sam@example.com, lee@example.com');
        expect(html).toContain('Remove me from this site');
        expect(html).toContain('Delete this site for everyone');
        expect(html).not.toContain('Lake House is shared');
    });

    it('warns about an active Battery Saver session with the reserve it restores', async () => {
        mocks.getSites.mockResolvedValue([
            { id: 's1', name: 'Lake House', shared: false, otherMembers: [], batterySaverReserve: 20, restoredOnLeave: true },
        ]);
        const html = await render();
        expect(html).toContain('Battery Saver is on for Lake House');
        expect(html).toContain('restores your backup reserve to 20%');
    });

    it('says Battery Saver keeps running for others when a shared site has another usable member', async () => {
        mocks.getSites.mockResolvedValue([
            { id: 's2', name: 'Main Home', shared: true, otherMembers: ['sam@example.com'], batterySaverReserve: 20, restoredOnLeave: false },
        ]);
        const html = await render();
        expect(html).toContain('keeps running for the other members');
        expect(html).toContain('If you delete the site for everyone');
    });

    it('explains an account with no sites', async () => {
        mocks.getSites.mockResolvedValue([]);
        expect(await render()).toContain('No sites are linked to this account');
    });
});
