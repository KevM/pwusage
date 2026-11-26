import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { requestSignOutEverywhere, SignOutEverywherePanel } from './SignOutEverywhere';

const noop = () => undefined;
const render = (props: Partial<Parameters<typeof SignOutEverywherePanel>[0]> = {}) => renderToStaticMarkup(
    <SignOutEverywherePanel confirming={false} busy={false} error="" onStart={noop} onCancel={noop} onConfirm={noop} {...props} />,
);

describe('SignOutEverywherePanel', () => {
    it('offers the action with its consequence, without acting on the first click', () => {
        const html = render();
        expect(html).toContain('Sign out everywhere');
        expect(html).toContain('every device');
        expect(html).toContain('disconnects every connected app and revokes every integration token');
        expect(html).not.toContain('Cancel');
    });

    it('asks for confirmation before signing out', () => {
        const html = render({ confirming: true });
        expect(html).toContain('including this one');
        expect(html).toContain('Cancel');
        expect(html).toMatch(/<button[^>]*>Sign out everywhere<\/button>/);
    });

    it('disables both buttons while the request runs and shows an error', () => {
        const html = render({ confirming: true, busy: true, error: 'Couldn’t sign out everywhere. Try again.' });
        expect(html.match(/disabled=""/g)?.length).toBe(2);
        expect(html).toContain('role="alert"');
    });
});

describe('requestSignOutEverywhere', () => {
    it('posts to the sign-out-everywhere endpoint and reports success', async () => {
        const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
        expect(await requestSignOutEverywhere(fetchFn)).toBe(true);
        expect(fetchFn).toHaveBeenCalledWith('/api/auth/sign-out-everywhere', { method: 'POST' });
    });

    it('reports failure on an error status or a network error', async () => {
        expect(await requestSignOutEverywhere(vi.fn().mockResolvedValue(new Response(null, { status: 403 })))).toBe(false);
        expect(await requestSignOutEverywhere(vi.fn().mockRejectedValue(new Error('offline')))).toBe(false);
    });
});
