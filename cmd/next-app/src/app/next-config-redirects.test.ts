import { describe, expect, it } from 'vitest';
import nextConfig from '../../next.config';

describe('next.config redirects', () => {
  it('permanently redirects the old TRMNL help URL to /trmnl', async () => {
    const redirects = await nextConfig.redirects?.();
    // The TRMNL plugin listing and search results still link to /help/trmnl.
    expect(redirects).toContainEqual({ source: '/help/trmnl', destination: '/trmnl', permanent: true });
  });
});
