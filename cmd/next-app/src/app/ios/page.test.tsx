import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import IosPage, { metadata } from './page';
import { TESTFLIGHT_JOIN_URL } from '@/lib/ios-beta';

describe('iOS beta page', () => {
    it('links to the public TestFlight invite', async () => {
        expect(TESTFLIGHT_JOIN_URL).toBe('https://testflight.apple.com/join/sCnRnstC');
        const html = renderToStaticMarkup(await IosPage());
        expect(html).toContain(`href="${TESTFLIGHT_JOIN_URL}"`);
    });

    it('has a canonical URL for /ios', () => {
        expect(metadata.alternates?.canonical).toBe('/ios');
    });

    it('unfurls as a large card with the iPhone screenshots', () => {
        expect(metadata.twitter).toMatchObject({ card: 'summary_large_image' });
        expect(metadata.openGraph).toMatchObject({
            title: 'iPhone app beta',
            siteName: 'pwusage',
            images: [{ url: '/og/ios', width: 1200, height: 630 }],
        });
    });

    it('leads with an iPhone screenshot, not the iPad one', async () => {
        const html = renderToStaticMarkup(await IosPage());
        expect(html).not.toContain('ipad-home');
    });
});
