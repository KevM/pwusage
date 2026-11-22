import { describe, expect, it } from 'vitest';
import { DEFAULT_DESCRIPTION, SITE_NAME, socialMetadata } from './social-metadata';

describe('socialMetadata', () => {
    it('defaults to a small card with the square app icon', () => {
        const meta = socialMetadata({ title: 'Powerwall Usage', description: DEFAULT_DESCRIPTION });

        expect(meta.twitter).toMatchObject({ card: 'summary', title: 'Powerwall Usage', description: DEFAULT_DESCRIPTION });
        expect(meta.openGraph).toMatchObject({
            title: 'Powerwall Usage',
            description: DEFAULT_DESCRIPTION,
            siteName: SITE_NAME,
            images: [{ url: '/icon.png', width: 1024, height: 1024 }],
        });
    });

    it('uses a large card with the given hero image', () => {
        const meta = socialMetadata({
            title: 'Home',
            description: 'd',
            hero: { url: '/og/home', alt: 'Dashboard summary' },
        });

        expect(meta.twitter).toMatchObject({ card: 'summary_large_image' });
        expect(meta.openGraph?.images).toEqual([{ url: '/og/home', width: 1200, height: 630, alt: 'Dashboard summary' }]);
    });

    it('keeps the default copy free of repeated product names', () => {
        expect(DEFAULT_DESCRIPTION).not.toMatch(/powerwall/i);
    });
});
