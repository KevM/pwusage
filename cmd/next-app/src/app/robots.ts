import type { MetadataRoute } from 'next';
import { getAppBaseUrl } from '@/lib/url-utils';

// Auth-gated and API routes are kept out of crawlers; the sitemap URL is
// derived per-environment so preview/beta domains reference their own sitemap.
export default function robots(): MetadataRoute.Robots {
  const baseUrl = getAppBaseUrl();
  return {
    rules: {
      userAgent: '*',
      disallow: ['/api/', '/admin/', '/profile/', '/logout/'],
    },
    sitemap: `${baseUrl}/sitemap.xml`,
  };
}
