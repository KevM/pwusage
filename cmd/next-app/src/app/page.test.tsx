import { beforeEach, describe, expect, it, vi } from 'vitest';

// Real auth-checks, SiteRepo, UserRepo and AnnouncementRepo run against a fake
// pool, so these tests count the SQL a Home visit issues on a cold cache.
const h = vi.hoisted(() => ({
    queries: [] as string[],
    token: null as Record<string, unknown> | null,
    cookie: 'jwt' as string | undefined,
    authState: { is_active: true, session_version: 0, roles: ['user'], created_at_seconds: null } as Record<string, unknown> | null,
    siteRows: [] as { id: string; name: string }[],
    memos: [] as Map<string, unknown>[],
    redirect: vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`); }),
}));

vi.mock('react', async importOriginal => ({
    ...await importOriginal<typeof import('react')>(),
    // React's request memo, reset per test (vitest has no RSC request scope).
    cache: <A extends unknown[], R>(fn: (...args: A) => R) => {
        const memo = new Map<string, R>();
        h.memos.push(memo as Map<string, unknown>);
        return (...args: A) => {
            const key = JSON.stringify(args);
            if (!memo.has(key)) memo.set(key, fn(...args));
            return memo.get(key)!;
        };
    },
}));

vi.mock('@/lib/db', async importOriginal => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
        h.queries.push(sql);
        if (sql.includes('FROM "User"')) return { rows: h.authState ? [h.authState] : [] };
        if (sql.includes('SELECT id, name FROM "Site"')) {
            const ids = /ANY/.test(sql) ? (params as [string[]])[0] : null;
            return { rows: ids ? h.siteRows.filter(r => ids.includes(r.id)) : h.siteRows };
        }
        if (sql.includes('"SystemAnnouncement"')) return { rows: [{ id: 'a1', message: 'Hello' }] };
        throw new Error(`unexpected query: ${sql}`);
    });
    return { ...await importOriginal<typeof import('@/lib/db')>(), pool: { query }, getDb: () => ({ query }) };
});
vi.mock('next/headers', () => ({
    cookies: async () => ({ get: (name: string) => name === 'site_auth' && h.cookie ? { value: h.cookie } : undefined }),
}));
vi.mock('next/navigation', () => ({ redirect: h.redirect }));
vi.mock('@/lib/auth-jwt', async importOriginal => ({
    ...await importOriginal<typeof import('@/lib/auth-jwt')>(),
    verifySiteToken: () => h.token,
}));

import Home, { metadata } from './page';

const siteQueries = () => h.queries.filter(q => q.includes('"Site"'));

describe('Home', () => {
    beforeEach(() => {
        h.queries.length = 0;
        h.memos.forEach(m => m.clear());
        h.cookie = 'jwt';
        h.token = { sub: 'user-1', sites: [], roles: ['user'], sv: 0 };
        h.authState = { is_active: true, session_version: 0, roles: ['user'], created_at_seconds: null };
        h.siteRows = [];
        h.redirect.mockClear();
    });

    it('reads the announcement only for the login screen', async () => {
        h.cookie = undefined;
        expect(await Home()).toBeTruthy();
        expect(h.queries).toHaveLength(1);
        expect(h.queries[0]).toContain('"SystemAnnouncement"');
    });

    it('sends a revoked session to login after one auth query', async () => {
        h.authState = { is_active: true, session_version: 2, roles: ['user'], created_at_seconds: null };
        await expect(Home()).rejects.toThrow('REDIRECT:/login');
        expect(h.queries).toHaveLength(1);
        expect(h.queries[0]).toContain('FROM "User"');
    });

    it.each([
        ['zero sites (car-only)', [], '/products'],
        ['one site', [{ id: 's1', name: 'Home' }], '/site/s1'],
        ['several sites', [{ id: 's1', name: 'Home' }, { id: 's2', name: 'Cabin' }], '/products'],
    ])('redirects %s with one auth and one narrow site query', async (_label, rows, destination) => {
        h.siteRows = rows;
        await expect(Home()).rejects.toThrow(`REDIRECT:${destination}`);
        expect(h.queries).toHaveLength(2);
        expect(siteQueries()).toHaveLength(1);
        expect(siteQueries()[0]).toMatch(/SELECT id, name FROM "Site"/);
        expect(h.queries.some(q => q.includes('Tariff') || q.includes('SystemAnnouncement'))).toBe(false);
    });

    it('drops a legacy token\'s stale site IDs before choosing the redirect', async () => {
        h.token = { sites: ['gone', 's1'], roles: ['user'] };
        h.siteRows = [{ id: 's1', name: 'Home' }];
        await expect(Home()).rejects.toThrow('REDIRECT:/site/s1');
        expect(h.queries).toHaveLength(1);
        expect(h.queries[0]).toContain('WHERE id = ANY($1::text[])');
    });

    it('sends a legacy token whose sites are all gone to products', async () => {
        h.token = { sites: ['gone'], roles: ['user'] };
        await expect(Home()).rejects.toThrow('REDIRECT:/products');
    });

    it('unfurls as a large card with the dashboard summary', () => {
        expect(metadata.twitter).toMatchObject({ card: 'summary_large_image' });
        expect(metadata.openGraph).toMatchObject({ images: [{ url: '/og/home', width: 1200, height: 630 }] });
    });
});
