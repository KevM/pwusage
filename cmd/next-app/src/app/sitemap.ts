import type { MetadataRoute } from 'next';
import { getAppBaseUrl } from '@/lib/url-utils';

// Public, crawlable content pages only. Excluded on purpose:
//   /products — redirects anonymous visitors to /login (auth-gated)
//   /login    — an OAuth action handler (302s to Tesla), not content
//   /help     — has no page; the real help page lives at /help/trmnl
// Auth-gated areas (/site, /admin, /profile) and /api are also excluded and
// disallowed in robots.ts.
const PUBLIC_PATHS = ['', '/about', '/news', '/help/trmnl', '/privacy', '/support'];

export default function sitemap(): MetadataRoute.Sitemap {
  const baseUrl = getAppBaseUrl();
  return PUBLIC_PATHS.map((path) => ({
    url: `${baseUrl}${path}`,
    lastModified: new Date(),
  }));
}
