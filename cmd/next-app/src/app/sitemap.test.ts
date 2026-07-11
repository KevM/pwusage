import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import sitemap from './sitemap';

describe('sitemap', () => {
  const prev = process.env.NEXT_PUBLIC_APP_URL;

  beforeEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://pwusage.fm.rodeo';
  });

  afterEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = prev;
  });

  it('includes only genuinely public, crawlable pages as absolute URLs', () => {
    const urls = sitemap().map((e) => e.url);
    expect(urls).toContain('https://pwusage.fm.rodeo');
    for (const path of ['/about', '/news', '/help/trmnl']) {
      expect(urls).toContain(`https://pwusage.fm.rodeo${path}`);
    }
  });

  it('excludes routes that 404, redirect to auth, or are not content', () => {
    const urls = sitemap().map((e) => e.url);
    // /help has no page (only /help/trmnl), /products redirects anon users to
    // /login, and /login is an OAuth action handler — none are crawlable.
    // Plus the auth-gated/private areas.
    for (const path of [
      '/help',
      '/products',
      '/login',
      '/site',
      '/admin',
      '/profile',
      '/api',
      '/logout',
    ]) {
      expect(urls).not.toContain(`https://pwusage.fm.rodeo${path}`);
    }
  });

  it('respects NEXT_PUBLIC_APP_URL and emits no trailing-slash origins', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://example.test/';
    for (const url of sitemap().map((e) => e.url)) {
      expect(url.startsWith('https://example.test')).toBe(true);
      expect(url).not.toMatch(/\/$/);
    }
  });
});
