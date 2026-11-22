import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

// Real auth-checks and SiteRepo against a fake pool; the Tesla client is faked.
const h = vi.hoisted(() => ({
    queries: [] as string[],
    token: null as Record<string, unknown> | null,
    authState: { is_active: true, session_version: 0, roles: ['user'], created_at_seconds: null } as Record<string, unknown> | null,
    siteRows: [] as { id: string; name: string }[],
    memos: [] as Map<string, unknown>[],
    getProducts: vi.fn(),
    createClient: vi.fn(),
    redirect: vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`); }),
}));

vi.mock('react', async importOriginal => ({
    ...await importOriginal<typeof import('react')>(),
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
        throw new Error(`unexpected query: ${sql}`);
    });
    return { ...await importOriginal<typeof import('@/lib/db')>(), pool: { query }, getDb: () => ({ query }) };
});
vi.mock('next/headers', () => ({
    cookies: async () => ({ get: (name: string) => name === 'site_auth' ? { value: 'jwt' } : undefined }),
}));
vi.mock('next/navigation', () => ({ redirect: h.redirect }));
vi.mock('@/lib/auth-jwt', async importOriginal => ({
    ...await importOriginal<typeof import('@/lib/auth-jwt')>(),
    verifySiteToken: () => h.token,
}));
vi.mock('@/lib/tesla-client-factory', () => ({ createTeslaClientForUser: h.createClient }));

import ProductsPage from './page';

const props = () => ({ searchParams: Promise.resolve({}) });

/** The products handed to DashboardCards, or [] when the empty state renders. */
function cards(page: ReactElement): { id: string; site_name: string; type?: string }[] {
    let found: { id: string; site_name: string }[] = [];
    const walk = (node: unknown) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) return node.forEach(walk);
        const el = node as { props?: { initialProducts?: typeof found; children?: unknown } };
        if (el.props?.initialProducts) found = el.props.initialProducts;
        walk(el.props?.children);
    };
    walk(page);
    return found;
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe('ProductsPage', () => {
    beforeEach(() => {
        h.queries.length = 0;
        h.memos.forEach(m => m.clear());
        h.token = { sub: 'user-1', sites: [], roles: ['user'], sv: 0 };
        h.authState = { is_active: true, session_version: 0, roles: ['user'], created_at_seconds: null };
        h.siteRows = [];
        h.getProducts.mockReset().mockResolvedValue([]);
        h.createClient.mockReset().mockResolvedValue({ getProducts: h.getProducts });
        h.redirect.mockClear();
    });

    it('lists energy sites, then vehicles, from one auth and one narrow site query', async () => {
        h.siteRows = [{ id: 's1', name: 'Home' }, { id: 's2', name: 'Cabin' }];
        h.getProducts.mockResolvedValue([{ id: 'v', vehicle_id: 7, display_name: 'Model Y', vin: 'VIN1' }]);

        const page = await ProductsPage(props());

        expect(cards(page).map(c => [c.id, c.site_name])).toEqual([
            ['s1', 'Home'], ['s2', 'Cabin'], ['vehicle-7', 'Model Y'],
        ]);
        expect(h.queries).toHaveLength(2);
        expect(h.queries[1]).toMatch(/SELECT id, name FROM "Site"/);
        expect(h.queries.some(q => q.includes('Tariff'))).toBe(false);
    });

    it('finishes the site read while the vehicle lookup is still waiting on Tesla', async () => {
        h.siteRows = [{ id: 's1', name: 'Home' }];
        let releaseVehicles!: (value: unknown[]) => void;
        h.getProducts.mockReturnValue(new Promise(resolve => { releaseVehicles = resolve; }));

        let done = false;
        const pending = ProductsPage(props()).then(page => { done = true; return page; });
        await tick();

        expect(h.getProducts).toHaveBeenCalled();
        expect(h.queries.filter(q => q.includes('"Site"'))).toHaveLength(1);
        expect(done).toBe(false);

        releaseVehicles([{ id: 'v', vehicle_id: 7, display_name: 'Model Y' }]);
        expect(cards(await pending).map(c => c.id)).toEqual(['s1', 'vehicle-7']);
    });

    it('keeps the energy cards when the vehicle lookup fails', async () => {
        h.siteRows = [{ id: 's1', name: 'Home' }];
        h.getProducts.mockRejectedValue(new Error('Tesla down'));
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        expect(cards(await ProductsPage(props())).map(c => c.id)).toEqual(['s1']);
        expect(warn).toHaveBeenCalledWith('[ProductsPage] Failed to load vehicle products:', expect.any(Error));
        warn.mockRestore();
    });

    it('shows vehicles alone for a car-only user', async () => {
        h.getProducts.mockResolvedValue([{ id: 'v', vehicle_id: 7, display_name: 'Model Y' }]);
        expect(cards(await ProductsPage(props())).map(c => c.id)).toEqual(['vehicle-7']);
    });

    it('sends a revoked session to login without reading sites or Tesla', async () => {
        h.authState = { is_active: false, session_version: 0, roles: ['user'], created_at_seconds: null };
        await expect(ProductsPage(props())).rejects.toThrow('REDIRECT:/login');
        expect(h.queries).toHaveLength(1);
        expect(h.createClient).not.toHaveBeenCalled();
    });

    it('drops a legacy token\'s stale site IDs and skips the vehicle lookup', async () => {
        h.token = { sites: ['s2', 'gone', 's1'], roles: ['user'] };
        h.siteRows = [{ id: 's1', name: 'Home' }, { id: 's2', name: 'Cabin' }];

        expect(cards(await ProductsPage(props())).map(c => c.id)).toEqual(['s2', 's1']);
        expect(h.queries).toHaveLength(1);
        expect(h.createClient).not.toHaveBeenCalled();
    });
});
