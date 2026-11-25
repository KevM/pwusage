import { describe, expect, it } from 'vitest';
import nextConfig from '../next.config';

describe('next.config security headers', () => {
    it('forbids framing the OAuth consent pages (clickjacking)', async () => {
        const rules = (await nextConfig.headers?.()) ?? [];
        const oauth = rules.find(rule => rule.source === '/oauth/:path*');
        expect(oauth?.headers).toEqual(expect.arrayContaining([
            { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
            { key: 'X-Frame-Options', value: 'DENY' },
        ]));
    });
});
