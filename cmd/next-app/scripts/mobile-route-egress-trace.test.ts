import dotenv from 'dotenv';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

dotenv.config({ path: path.resolve(process.cwd(), '.env'), quiet: true });

const devDatabaseUrl = process.env.DEV_DATABASE_URL?.trim();
const guardedSiteId = process.env.EGRESS_SITE_ID?.trim();
const canTrace = Boolean(devDatabaseUrl && guardedSiteId && process.env.NODE_ENV !== 'production');
if (canTrace && devDatabaseUrl) process.env.DATABASE_URL = devDatabaseUrl;

const traceMocks = vi.hoisted(() => ({ siteToken: '' }));
vi.mock('next/headers', () => ({
    cookies: async () => ({ get: (name: string) => name === 'site_auth' ? { value: traceMocks.siteToken } : undefined }),
}));
vi.mock('@/lib/today-refresh', () => ({
    // Keep the opt-in trace read-only even when mobile history is stale.
    refreshTodayData: async () => ({ status: 'throttled' }),
    refreshLiveStatus: async () => ({
        status: 'cached',
        fetchedAt: Date.now(),
        liveStatus: {
            solar_power: 1200, load_power: 900, battery_power: -100, grid_power: 200,
            percentage_charged: 73, timestamp: new Date().toISOString(),
        },
    }),
}));

interface TraceQuery { label: string; rows: number; jsonBytes: number }
interface TracePass { name: string; queries: TraceQuery[]; rows: number; jsonBytes: number }

function labelQuery(sql: string): string {
    const normalized = sql.replace(/\s+/g, ' ').toLowerCase();
    if (normalized.includes('"user"')) return 'authorization/user';
    if (normalized.includes('"site"')) return 'site/config';
    if (normalized.includes('date_bin')) return 'live energy buckets';
    if (normalized.includes('date_trunc')) return 'cycle energy aggregates';
    if (normalized.includes('"energydata"')) return 'energy rows';
    if (normalized.includes('"tariff"')) return 'tariff versions';
    if (normalized.includes('"schedule"')) return 'schedule versions';
    return 'other select';
}

describe.skipIf(!canTrace)('opt-in read-only mobile route egress trace', () => {
    let closePool: (() => Promise<void>) | undefined;
    afterAll(async () => { await closePool?.(); });

    it('compares web/mobile live and bill route queries against the guarded dev database', async () => {
        if (!devDatabaseUrl || !guardedSiteId) throw new Error('Trace guard state changed unexpectedly.');
        if (process.env.NODE_ENV === 'production') throw new Error('Refusing production trace.');

        const { getDb } = await import('../src/lib/db');
        const pool = getDb();
        closePool = async () => pool.end();
        const setup = await pool.query<{ user_id: string | null }>('SELECT user_id FROM "Site" WHERE id = $1', [guardedSiteId]);
        const userId = setup.rows[0]?.user_id;
        if (!userId) throw new Error('Guarded development site has no linked user.');
        const { signSiteToken } = await import('../src/lib/auth-jwt');
        traceMocks.siteToken = signSiteToken([guardedSiteId], [], userId);

        const asOf = new Date(process.env.EGRESS_AT ?? Date.now());
        if (!Number.isFinite(asOf.getTime())) throw new Error('EGRESS_AT must be a valid ISO timestamp.');
        vi.setSystemTime(asOf);
        const { pool: queryPool } = await import('../src/lib/db');
        const mutablePool = queryPool as unknown as {
            query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
        };
        const originalQuery = mutablePool.query.bind(mutablePool);
        let collecting: TraceQuery[] | null = null;
        mutablePool.query = async (sql, values) => {
            const result = await originalQuery(sql, values);
            if (collecting) {
                collecting.push({ label: labelQuery(sql), rows: result.rows.length, jsonBytes: Buffer.byteLength(JSON.stringify(result.rows)) });
            }
            return result;
        };
        try {
        const run = async (name: string, action: () => Promise<Response>): Promise<TracePass> => {
            collecting = [];
            const response = await action();
            if (!response.ok) throw new Error(`${name} route returned HTTP ${response.status}.`);
            await response.arrayBuffer();
            const queries = collecting;
            collecting = null;
            return {
                name, queries,
                rows: queries.reduce((sum, query) => sum + query.rows, 0),
                jsonBytes: queries.reduce((sum, query) => sum + query.jsonBytes, 0),
            };
        };

        const { GET: liveGet } = await import('../src/app/api/site-live-data/route');
        const { GET: billGet } = await import('../src/app/api/mobile/bill-summary/route');
        const clearCaches = async () => {
            const { clearCycleRollupCache } = await import('../src/lib/cycle-rollup-cache');
            const { SiteRepo } = await import('../src/lib/site-repo');
            clearCycleRollupCache();
            new SiteRepo().invalidateCache(guardedSiteId);
        };
        const url = (view: 'web' | 'mobile') => new Request(
            `https://trace.invalid/api/site-live-data?siteId=${encodeURIComponent(guardedSiteId)}${view === 'mobile' ? '&view=mobile' : ''}`
        );
        const passes: TracePass[] = [];
        for (const view of ['web', 'mobile'] as const) {
            await clearCaches();
            passes.push(await run(`${view} live cold`, () => liveGet(url(view))));
            passes.push(await run(`${view} live warm`, () => liveGet(url(view))));
        }
        await clearCaches();
        passes.push(await run('bill cold', () => billGet(new Request(
            `https://trace.invalid/api/mobile/bill-summary?siteId=${encodeURIComponent(guardedSiteId)}`
        ))));
        passes.push(await run('bill warm', () => billGet(new Request(
            `https://trace.invalid/api/mobile/bill-summary?siteId=${encodeURIComponent(guardedSiteId)}`
        ))));
        console.log(JSON.stringify({
            asOf: asOf.toISOString(),
            warning: 'JSON bytes serialize node-postgres result rows; they are a row-value proxy, not PostgreSQL wire bytes.',
            passes,
        }, null, 2));
        expect(passes).toHaveLength(6);
        const querySummary = (pass: TracePass) => pass.queries
            .map(query => `${query.label}:${query.rows}:${query.jsonBytes}`)
            .sort();
        expect(querySummary(passes[0])).toEqual(querySummary(passes[2]));
        } finally {
            collecting = null;
            mutablePool.query = originalQuery;
            vi.useRealTimers();
        }
    }, 120_000);
});

if (!canTrace && process.env.NODE_ENV === 'production') console.error('Skipping route trace: NODE_ENV=production is explicitly refused.');
