import { describe, expect, it } from 'vitest';
import { homeHeroImage, iosHeroImage, trmnlHeroImage } from './og-hero-images';

describe('link-preview hero images', () => {
    it.each([
        ['home', homeHeroImage],
        ['ios', iosHeroImage],
        ['trmnl', trmnlHeroImage],
    ])('renders the %s hero as a PNG', async (_name, render) => {
        const response = render();
        const bytes = new Uint8Array(await response.arrayBuffer());

        expect(response.headers.get('content-type')).toBe('image/png');
        // PNG signature, then IHDR width/height (big-endian) at bytes 16–23.
        expect(Array.from(bytes.slice(1, 4))).toEqual([0x50, 0x4e, 0x47]);
        const view = new DataView(bytes.buffer);
        expect([view.getUint32(16), view.getUint32(20)]).toEqual([1200, 630]);
    }, 30_000);
});
