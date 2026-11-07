import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Footer } from './Footer';

describe('Footer', () => {
    it('points visitors to the iOS app page', () => {
        const html = renderToStaticMarkup(<Footer />);
        expect(html).toContain('href="/ios"');
        expect(html).toContain('iPhone App (Beta)');
    });
});
