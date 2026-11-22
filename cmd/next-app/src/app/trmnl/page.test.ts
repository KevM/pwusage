import { describe, expect, it } from 'vitest';
import { metadata } from './page';

describe('TRMNL page metadata', () => {
    it('unfurls as a large card with the demo screen', () => {
        expect(metadata.twitter).toMatchObject({ card: 'summary_large_image' });
        expect(metadata.openGraph).toMatchObject({ title: 'TRMNL display', siteName: 'pwusage' });
        expect(metadata.alternates?.canonical).toBe('/trmnl');
    });
});
