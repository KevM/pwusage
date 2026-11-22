import { describe, expect, it, vi } from 'vitest';

vi.mock('next/font/local', () => ({ default: () => ({ variable: 'font' }) }));

import { metadata } from './layout';

describe('root metadata', () => {
    it('unfurls as a small card by default', () => {
        expect(metadata.twitter).toMatchObject({ card: 'summary' });
    });

    it('names Powerwall once across the card', () => {
        const og = metadata.openGraph as { title?: string; description?: string; siteName?: string };
        const text = [og.siteName, og.title, og.description].join(' ');
        expect(text.match(/powerwall/gi)).toHaveLength(1);
    });
});
