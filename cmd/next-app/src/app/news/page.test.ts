import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ latest: null as { content: string } | null, fail: false }));

vi.mock('@/lib/announcement-repo', () => ({
    AnnouncementRepo: class {
        async getLatest() {
            if (h.fail) throw new Error('db down');
            return h.latest;
        }
    },
}));
vi.mock('@/lib/auth-checks', () => ({ getDefaultSiteId: async () => null }));
vi.mock('@/lib/site-repo', () => ({ SiteRepo: class {} }));

import { generateMetadata } from './page';

describe('news metadata', () => {
    beforeEach(() => {
        h.latest = null;
        h.fail = false;
    });

    it('uses the latest post image as a large card', async () => {
        h.latest = { content: 'New screen.\n\n![Demo](/news/demo.png)' };
        const meta = await generateMetadata();

        expect(meta.twitter).toMatchObject({ card: 'summary_large_image' });
        expect(meta.openGraph?.images).toEqual([{ url: '/news/demo.png', alt: 'Demo' }]);
    });

    it('falls back to the small card when the post has no image', async () => {
        h.latest = { content: 'Just text.' };
        const meta = await generateMetadata();

        expect(meta.twitter).toMatchObject({ card: 'summary' });
        expect(meta.openGraph?.images).toEqual([{ url: '/icon.png', width: 1024, height: 1024 }]);
    });

    it('falls back to the small card when announcements cannot load', async () => {
        h.fail = true;
        const meta = await generateMetadata();

        expect(meta.twitter).toMatchObject({ card: 'summary' });
        expect(JSON.stringify(meta)).not.toContain('/opengraph-image');
    });
});
