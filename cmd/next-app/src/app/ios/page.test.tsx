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
});
