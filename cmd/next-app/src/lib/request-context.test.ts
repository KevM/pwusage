import { describe, it, expect } from 'vitest';
import { withRequestContext, getRequestContext } from './request-context';
import type { SiteWithTariffs } from './db';

describe('request-context', () => {
    const createTestSite = (id: string, name: string = 'Test Site'): SiteWithTariffs => ({
        id,
        user_id: 'user-1',
        name,
        utility: 'PG&E',
        updated: new Date(),
        installed: new Date(),
        timezone: 'America/Los_Angeles',
        billing_start_day: 1,
        timezone_display_mode: 'SITE',
        json: null,
        tariffs: [],
    });

    it('provides a fresh siteCache map inside withRequestContext', async () => {
        await withRequestContext(async () => {
            const ctx = getRequestContext();
            expect(ctx.siteCache).toBeInstanceOf(Map);
            expect(ctx.siteCache.size).toBe(0);

            ctx.siteCache.set('site-1', createTestSite('site-1', 'Home'));
            expect(ctx.siteCache.size).toBe(1);
        });
    });

    it('provides isolated maps across separate withRequestContext calls', async () => {
        // First request populates request cache (and persistent cache)
        await withRequestContext(async () => {
            const ctx = getRequestContext();
            ctx.siteCache.set('site-1', createTestSite('site-1', 'A'));
        });

        // Second request: should start fresh
        await withRequestContext(async () => {
            const ctx = getRequestContext();
            expect(ctx.siteCache.size).toBe(0);
        });
    });

    it('returns a no-op fallback context when called outside withRequestContext', () => {
        const ctx = getRequestContext();
        expect(ctx.siteCache).toBeInstanceOf(Map);
        // Writes to fallback are allowed but not persisted across calls
        ctx.siteCache.set('throwaway', createTestSite('throwaway', 'X'));

        const ctx2 = getRequestContext();
        // Each call outside the context returns a fresh map
        expect(ctx2.siteCache.has('throwaway')).toBe(false);
    });

    it('preserves context across awaited async work', async () => {
        await withRequestContext(async () => {
            const ctx = getRequestContext();
            ctx.siteCache.set('site-1', createTestSite('site-1', 'A'));

            await new Promise(resolve => setTimeout(resolve, 5));

            const ctxAfter = getRequestContext();
            expect(ctxAfter.siteCache.has('site-1')).toBe(true);
            expect(ctxAfter).toBe(ctx);
        });
    });

    it('isolates concurrent contexts via Promise.all', async () => {
        const results = await Promise.all([
            withRequestContext(async () => {
                const ctx = getRequestContext();
                ctx.siteCache.set('test-site', createTestSite('A', 'Site A'));
                // Simulate some async work to interleave the two contexts
                await new Promise(resolve => setTimeout(resolve, 10));
                return ctx.siteCache.get('test-site');
            }),
            withRequestContext(async () => {
                const ctx = getRequestContext();
                ctx.siteCache.set('test-site', createTestSite('B', 'Site B'));
                return ctx.siteCache.get('test-site');
            }),
        ]);

        expect(results[0]?.name).toBe('Site A');
        expect(results[1]?.name).toBe('Site B');
    });
});
