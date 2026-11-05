import dotenv from 'dotenv';
import path from 'node:path';
import type { Pool, PoolClient, QueryResult } from 'pg';
import type { Readable } from 'node:stream';
import { statSync } from 'node:fs';
import { afterAll, describe, expect, it, vi } from 'vitest';

const localSocket = process.env.EGRESS_LOCAL_SOCKET;
if (!localSocket) dotenv.config({ path: path.resolve(process.cwd(), '.env'), quiet: true });

if (localSocket && (!/^\/(?:private\/)?tmp\/mobile-egress-pg-[A-Za-z0-9-]+$/.test(localSocket)
    || (statSync(localSocket).mode & 0o777) !== 0o700)) throw new Error('Unsafe egress fixture socket.');
const devDatabaseUrl = localSocket
    ? `postgresql://egress@localhost:55447/postgres?sslmode=disable&host=${encodeURIComponent(localSocket)}`
    : process.env.DEV_DATABASE_URL?.trim();
const guardedSiteId = localSocket ? 'trace' : process.env.EGRESS_SITE_ID?.trim();
const canTrace = Boolean(devDatabaseUrl && guardedSiteId && process.env.NODE_ENV !== 'production');
if (canTrace && devDatabaseUrl) process.env.DATABASE_URL = devDatabaseUrl;

const traceMocks = vi.hoisted(() => ({
    siteToken: '',
    pools: [] as Pool[],
    onPool: undefined as ((pool: Pool) => void) | undefined,
    todaySampleCount: 151,
    fixtureFailure: false,
    fixtureRequests: 0,
}));
vi.mock('pg', async importOriginal => {
    const pg = await importOriginal<typeof import('pg')>();
    class MeasuredPool extends pg.Pool {
        constructor(config?: ConstructorParameters<typeof pg.Pool>[0]) {
            super(config);
            traceMocks.pools.push(this);
            traceMocks.onPool?.(this);
        }
    }
    return { ...pg, Pool: MeasuredPool };
});
vi.mock('next/headers', () => ({
    cookies: async () => ({ get: (name: string) => name === 'site_auth' ? { value: traceMocks.siteToken } : undefined }),
}));
vi.mock('@/lib/today-refresh', async importOriginal => process.env.EGRESS_LOCAL_SOCKET ? importOriginal() : ({
    // Keep the hosted trace read-only and independent of Tesla credentials.
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
vi.mock('@/lib/tesla-client-factory', () => ({
    createTeslaClientForSite: async () => ({
        getLiveStatus: async () => ({
            solar_power: 1200, load_power: 900, battery_power: 0, grid_power: -300,
            percentage_charged: 73, timestamp: new Date().toISOString(),
        }),
    }),
}));
vi.mock('@/lib/prototypes/compact-day-fetch', () => ({
    fetchDayForWrite: async (_importer: unknown, site: { id: string }, start: Date) => {
        traceMocks.fixtureRequests += 1;
        if (traceMocks.fixtureFailure) throw new Error('synthetic upstream failure');
        return { fetchedAt: new Date(), rows: fixtureSamples(site.id, start) };
    },
}));

function fixtureSamples(siteId: string, start: Date) {
    const count = +start < +new Date('2026-01-24T00:00:00Z') ? 288 : traceMocks.todaySampleCount;
    return Array.from({ length: count }, (_, index) => ({
        site_id: siteId, timestamp: new Date(+start + index * 300_000), tariff_id: 1, tariff_schedule_id: 1,
        load_power: 80 + index % 11, solar_power: index % 13, grid_power: 75 + index % 11,
        battery_power: 0, battery_soc: index % 12 === 0 ? 50 : null,
    }));
}

interface TraceQuery { label: string; rows: number; jsonBytes: number }
interface TracePass {
    name: string;
    status: number;
    protocolBytes: number;
    responseBytes: number;
    historyOutcome?: string;
    queries: TraceQuery[];
    rows: number;
    jsonBytes: number;
}

function labelQuery(sql: string): string {
    const normalized = sql.replace(/\s+/g, ' ').toLowerCase();
    if (normalized.includes('"energydayarchive"') && normalized.includes('payload,')) return 'archive detail';
    if (normalized.includes('"energydayarchive"')) return 'archive metadata';
    if (normalized.includes('"energydaysummary"')) return 'day summaries';
    if (normalized.includes('"user"')) return 'authorization/user';
    if (normalized.includes('"site"')) return 'site/config';
    if (normalized.includes('"tariff"')) return 'tariff versions';
    if (normalized.includes('"tariffschedule"')) return 'schedule versions';
    if (/^(begin|commit|rollback|set local)/.test(normalized)) return 'transaction control';
    return 'other query';
}

// pg uses the same client query entry point for pool.query and checked-out
// clients. Count incoming stream chunks before pg resolves the query. On a TLS
// connection the stream is the TLSSocket, so this counts decrypted protocol
// bytes and does not depend on the row representation exposed to JavaScript.
function tracePool(pool: Pool, activePass: () => TracePass | undefined): void {
    const tracedClients = new WeakSet<PoolClient>();
    pool.on('acquire', (client: PoolClient) => {
        if (tracedClients.has(client)) return;
        tracedClients.add(client);
        const { stream } = (client as PoolClient & { connection: { stream: Readable } }).connection;
        stream.prependListener('data', (chunk: Buffer) => {
            const pass = activePass();
            if (pass) pass.protocolBytes += chunk.length;
        });

        const query = client.query;
        client.query = function (this: PoolClient, ...args: unknown[]) {
            const pass = activePass();
            const sql = typeof args[0] === 'string' ? args[0] : (args[0] as { text: string }).text;
            const record = (result: QueryResult | QueryResult[]) => {
                if (!pass) return;
                const rows = (Array.isArray(result) ? result : [result]).flatMap(entry => entry.rows);
                const jsonBytes = Buffer.byteLength(JSON.stringify(rows));
                pass.queries.push({ label: labelQuery(sql), rows: rows.length, jsonBytes });
                pass.rows += rows.length;
                pass.jsonBytes += jsonBytes;
            };
            const callbackIndex = args.length - 1;
            const callback = args[callbackIndex];
            if (typeof callback === 'function') {
                args[callbackIndex] = (error: Error | null, result: QueryResult) => {
                    if (!error && result) record(result);
                    callback(error, result);
                };
                return Reflect.apply(query, this, args);
            }
            return (Reflect.apply(query, this, args) as Promise<QueryResult>).then(result => {
                record(result);
                return result;
            });
        } as PoolClient['query'];
    });
}

describe.skipIf(!canTrace)('opt-in mobile route egress trace', () => {
    afterAll(async () => { await Promise.all(traceMocks.pools.map(pool => pool.end())); });

    it('measures database-to-app protocol and HTTP bytes for the mobile routes', async () => {
        if (!devDatabaseUrl || !guardedSiteId || process.env.NODE_ENV === 'production') {
            throw new Error('Refusing trace without guarded development database configuration.');
        }
        let collecting: TracePass | undefined;
        traceMocks.onPool = pool => tracePool(pool, () => collecting);
        const pool = (await import('../src/lib/db')).getDb();
        const marker = await pool.query<{ name: string }>('SELECT name FROM pwusage_env.environment');
        if (marker.rows.length !== 1 || marker.rows[0].name !== 'dev') throw new Error('Missing dev database marker.');
        const setup = await pool.query<{ user_id: string; session_version: number }>(
            'SELECT u.id AS user_id, u.session_version FROM "Site" s JOIN "User" u ON u.id = s.user_id WHERE s.id = $1',
            [guardedSiteId],
        );
        const user = setup.rows[0];
        if (!user) throw new Error('Guarded development site has no linked user.');
        const asOf = new Date(localSocket ? '2026-01-24T12:42:00Z' : process.env.EGRESS_AT ?? Date.now());
        if (!Number.isFinite(+asOf)) throw new Error('EGRESS_AT must be a valid ISO timestamp.');
        vi.setSystemTime(asOf);
        const { signSiteToken } = await import('../src/lib/auth-jwt');
        traceMocks.siteToken = signSiteToken([guardedSiteId], [], user.user_id, undefined, user.session_version);

        const passes: TracePass[] = [];
        const run = async (name: string, action: () => Promise<Response>) => {
            const pass: TracePass = { name, status: 0, protocolBytes: 0, responseBytes: 0, queries: [], rows: 0, jsonBytes: 0 };
            collecting = pass;
            try {
                const response = await action();
                pass.status = response.status;
                if (!response.ok && response.status !== 304) throw new Error(`${name} returned HTTP ${response.status}.`);
                const bytes = await response.arrayBuffer();
                pass.responseBytes = bytes.byteLength;
                expect(pass.protocolBytes).toBeGreaterThan(0);
                passes.push(pass);
                const body = bytes.byteLength > 0 ? JSON.parse(Buffer.from(bytes).toString()) as {
                    revision?: string; historyRevision?: string; historyRefresh?: { status: string };
                } : {};
                pass.historyOutcome = response.headers.get('X-PWUsage-History-Refresh') ?? body.historyRefresh?.status;
                return body;
            } finally {
                collecting = undefined;
            }
        };

        try {
            const { GET: liveGet } = await import('../src/app/api/site-live-data/route');
            const { GET: billGet } = await import('../src/app/api/mobile/bill-summary/route');
            const { GET: powerGet } = await import('../src/app/api/mobile/live-power/route');
            const { clearCycleRollupCache } = await import('../src/lib/cycle-rollup-cache');
            const { SiteRepo } = await import('../src/lib/site-repo');
            const clearCaches = () => {
                clearCycleRollupCache();
                new SiteRepo().invalidateCache(guardedSiteId);
            };
            const request = (route: string, params: Record<string, string> = {}) =>
                new Request(`https://trace.invalid${route}?${new URLSearchParams({ siteId: guardedSiteId, ...params })}`);

            await run(localSocket ? 'power' : 'power (refresh service stubbed)', () => powerGet(request('/api/mobile/live-power')));
            if (localSocket) {
                const { CompactHistoryStore } = await import('../src/lib/prototypes/compact-history-store');
                const store = new CompactHistoryStore(pool);
                for (let day = 1; day <= 23; day += 1) {
                    const start = new Date(Date.UTC(2026, 0, day));
                    await store.writeDay(guardedSiteId, start, fixtureSamples(guardedSiteId, start), new Date(+start + 86_400_000), asOf);
                }
                const imported = await run('summary launch, new history', () => liveGet(request('/api/site-live-data', { view: 'mobile' })));
                expect(imported.historyRefresh?.status).toBe('changed');
                expect(imported.historyRevision).toBeTruthy();
                vi.setSystemTime(new Date(+asOf + 1000));
                clearCaches();
                const beforePull = traceMocks.fixtureRequests;
                await run('manual summary unchanged cold', () => liveGet(request('/api/site-live-data', {
                    view: 'mobile', refresh: '1', knownHistoryRevision: imported.historyRevision ?? '',
                })));
                expect(traceMocks.fixtureRequests).toBe(beforePull + 1);
                expect(passes.at(-1)).toMatchObject({ status: 304, responseBytes: 0, historyOutcome: 'current' });
                expect(passes.at(-1)?.queries.some(query => query.label === 'archive detail')).toBe(false);
                const conditionalManual = passes.at(-1)!;

                vi.setSystemTime(new Date(+asOf + 2000));
                clearCaches();
                await run('manual summary unchanged cold without validator', () => liveGet(request('/api/site-live-data', {
                    view: 'mobile', refresh: '1',
                })));
                const unconditionalManual = passes.at(-1)!;
                expect(unconditionalManual).toMatchObject({ status: 200, historyOutcome: 'current' });
                expect(unconditionalManual.queries.some(query => query.label === 'archive detail')).toBe(true);
                expect(conditionalManual.protocolBytes).toBeLessThan(unconditionalManual.protocolBytes);
                expect(traceMocks.fixtureRequests).toBe(beforePull + 2);

                await pool.query(
                    'UPDATE "Site" SET import_lock_id = $1, import_lock_expires = $2 WHERE id = $3',
                    ['other-instance', +asOf + 30_000, guardedSiteId],
                );
                await run('manual summary while another instance owns the import', () => liveGet(request('/api/site-live-data', {
                    view: 'mobile', refresh: '1', knownHistoryRevision: imported.historyRevision ?? '',
                })));
                expect(passes.at(-1)).toMatchObject({ status: 304, historyOutcome: 'pending' });
                expect(traceMocks.fixtureRequests).toBe(beforePull + 2);
                await pool.query(
                    'UPDATE "Site" SET import_lock_id = NULL, import_lock_expires = 0 WHERE id = $1',
                    [guardedSiteId],
                );
                await run('summary follow-up after the lease releases', () => liveGet(request('/api/site-live-data', {
                    view: 'mobile', historyCheck: '1', knownHistoryRevision: imported.historyRevision ?? '',
                })));
                expect(passes.at(-1)).toMatchObject({ status: 304, historyOutcome: 'current' });
                expect(traceMocks.fixtureRequests).toBe(beforePull + 2);

                traceMocks.fixtureFailure = true;
                vi.setSystemTime(new Date(+asOf + 3000));
                const failed = await run('manual summary upstream failure', () => liveGet(request('/api/site-live-data', {
                    view: 'mobile', refresh: '1',
                })));
                expect(failed.historyRefresh?.status).toBe('failed');
                traceMocks.fixtureFailure = false;
            }
            for (const [name, params] of [
                ['web live', {}],
                ['mobile summary', { view: 'mobile' }],
                [localSocket ? 'mobile manual summary' : 'mobile manual summary (import stubbed)', { view: 'mobile', refresh: '1' }],
            ] as const) {
                clearCaches();
                await run(`${name} cold`, () => liveGet(request('/api/site-live-data', params)));
                await run(`${name} warm`, () => liveGet(request('/api/site-live-data', params)));
            }
            clearCaches();
            const bill = await run('bill outlook cold', () => billGet(request('/api/mobile/bill-summary', { outlook: '1', knownRevision: '' })));
            const unconditionalBill = passes.at(-1)!;
            await run('bill outlook warm', () => billGet(request('/api/mobile/bill-summary', { outlook: '1' })));
            if (localSocket) expect(bill.revision).toBeTruthy();
            if (bill.revision) {
                clearCaches();
                await run('bill outlook unchanged cold', () => billGet(request('/api/mobile/bill-summary', {
                    outlook: '1', knownRevision: bill.revision!,
                })));
                expect(passes.at(-1)).toMatchObject({ status: 304, responseBytes: 0 });
                expect(passes.at(-1)?.queries.some(query => query.label === 'archive detail')).toBe(false);
                expect(passes.at(-1)?.protocolBytes).toBeLessThan(unconditionalBill.protocolBytes);
            }
            expect(passes.some(pass => pass.queries.some(query => query.label === 'archive detail'))).toBe(true);
            console.log(JSON.stringify({
                asOf: asOf.toISOString(),
                measurement: 'PostgreSQL application protocol bytes, excluding connection startup and TLS/TCP framing. HTTP bytes and JSON row estimates are separate.',
                mode: localSocket ? 'isolated PostgreSQL with deterministic upstream fixtures' : 'read-only Dev with refresh services stubbed',
                passes,
            }, null, 2));
        } finally {
            vi.useRealTimers();
        }
    }, 120_000);
});
