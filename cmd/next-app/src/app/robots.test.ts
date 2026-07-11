import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import robots from './robots';

describe('robots', () => {
  const prev = process.env.NEXT_PUBLIC_APP_URL;

  beforeEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://pwusage.fm.rodeo';
  });

  afterEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = prev;
  });

  it('disallows the auth-gated and API routes', () => {
    const rule = robots().rules;
    const disallow = Array.isArray(rule) ? rule[0].disallow : rule.disallow;
    expect(disallow).toEqual(
      expect.arrayContaining(['/api/', '/admin/', '/profile/', '/logout/'])
    );
  });

  it('points the sitemap at the current base URL', () => {
    expect(robots().sitemap).toBe('https://pwusage.fm.rodeo/sitemap.xml');
  });

  it('derives the sitemap URL from NEXT_PUBLIC_APP_URL (no trailing slash)', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://pwusagebeta.fm.rodeo/';
    expect(robots().sitemap).toBe('https://pwusagebeta.fm.rodeo/sitemap.xml');
  });
});
