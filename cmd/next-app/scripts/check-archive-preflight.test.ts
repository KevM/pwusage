import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const { query, connect } = vi.hoisted(() => ({ query: vi.fn(), connect: vi.fn() }));
vi.mock('../src/lib/db', () => ({ pool: { query, connect, end: vi.fn() } }));
import { runArchivePreflight } from './check-archive-preflight';

const expectedTables = ['EnergyDayArchive', 'EnergyDaySummary', 'HistoryArchiveControl', 'HistoryArchiveRetry'];
let tables: string[];
let pruningError: Error | null;
let appliedTimeout: string | undefined;

beforeEach(() => {
    tables = [...expectedTables];
    pruningError = null;
    appliedTimeout = '15s';
    process.exitCode = 0;
    vi.stubEnv('DATABASE_URL', 'postgres://test@localhost/test');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    query.mockImplementation(async (sql: string) => {
        if (sql.includes('server_version')) return { rows: [{ server_version: '17.6', server_version_num: '170006' }] };
        if (sql.includes('transaction_timeout')) return { rows: [{ transaction_timeout: '15s' }] };
        if (sql.includes('information_schema')) return { rows: tables.map(name => ({ name })) };
        if (sql.includes('raw_pruned')) {
            if (pruningError) throw pruningError;
            return { rows: [{ days: 0 }] };
        }
        return { rows: [{ paused: true, trim: false, site_ids: [] }] };
    });
    connect.mockImplementation(async () => ({
        query: vi.fn(async (sql: string) => ({ rows: sql.includes('advisory') ? [{ xact: true }] : [{ transaction_timeout: appliedTimeout }] })),
        release: vi.fn(),
    }));
});

afterEach(() => {
    process.exitCode = 0;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

it('fails preflight when pruning cannot be checked and preserves the error', async () => {
    pruningError = new Error('permission denied for raw_pruned');
    await runArchivePreflight();
    expect(process.exitCode).toBe(1);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('permission denied for raw_pruned'));
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('pruned_days'));
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('Preflight passed'));
});

it.each([{ missing: ['HistoryArchiveRetry'] }, { missing: expectedTables }])('reports only absent tables: $missing', async ({ missing }) => {
    tables = expectedTables.filter(name => !missing.includes(name));
    await runArchivePreflight();
    expect(process.exitCode).toBe(1);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining(`missing: ${missing.join(', ')}`));
});

it('passes when every probe succeeds', async () => {
    await runArchivePreflight();
    expect(process.exitCode).toBe(0);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Preflight passed'));
});

it.each(['0', '0s', 'unknown', '10s', undefined])('fails preflight when applied transaction timeout is %s', async (readback) => {
    appliedTimeout = readback;
    await runArchivePreflight();
    expect(process.exitCode).toBe(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('set_local_transaction_timeout'));
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('Preflight passed'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining(`expected 15s, got ${readback ?? 'unknown'}`));
});

it('passes preflight when applied transaction timeout is 15000ms', async () => {
    appliedTimeout = '15000ms';
    await runArchivePreflight();
    expect(process.exitCode).toBe(0);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Preflight passed'));
});
