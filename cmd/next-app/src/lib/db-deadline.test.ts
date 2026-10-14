import { afterEach, expect, it, vi } from 'vitest';
import type { PoolConfig } from 'pg';
afterEach(() => { vi.doUnmock('pg'); vi.resetModules(); });
it('uses bounded connection, statement and lock timeouts only inside deadline scopes', async () => {
  const configs: PoolConfig[] = [];
  const query = vi.fn().mockResolvedValue({ rows: [] });
  const client = { query, release: vi.fn() };
  vi.doMock('pg', () => ({ Pool: class {
    constructor(config: PoolConfig) { configs.push(config); }
    on() {} setMaxListeners() {} query = query; connect = async () => client;
  } }));
  const { pool } = await import('./db');
  const { withIoDeadline } = await import('./io-deadline');
  await withIoDeadline(1000, () => pool.query('SELECT 1'));
  expect(configs[0]).toMatchObject({ connectionTimeoutMillis: 1000, query_timeout: 2000, statement_timeout: 1500, lock_timeout: 1000 });
});
it('blocks a delayed query continuation after its scope was cancelled', async () => {
  vi.useFakeTimers();
  const query = vi.fn().mockResolvedValue({ rows: [] });
  vi.doMock('pg', () => ({ Pool: class { on() {} setMaxListeners() {} query = query; } }));
  try {
    const { pool } = await import('./db'); const { withIoDeadline } = await import('./io-deadline');
    let finish: (() => void) | undefined;
    const pending = withIoDeadline(100, async () => { await new Promise<void>(r => { finish = r; }); await pool.query('UPDATE late'); });
    const assertion = expect(pending).rejects.toThrow('deadline');
    await vi.advanceTimersByTimeAsync(100); await assertion; finish?.(); await vi.runAllTimersAsync();
    expect(query).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});

it('does not execute a queued query when its connection arrives after cancellation', async () => {
  vi.useFakeTimers();
  const query = vi.fn().mockResolvedValue({ rows: [] }); const release = vi.fn();
  let connected: ((client: { query: typeof query; release: typeof release }) => void) | undefined;
  vi.doMock('pg', () => ({ Pool: class {
    on() {} setMaxListeners() {} query = query;
    connect = () => new Promise(resolve => { connected = resolve; });
  } }));
  try {
    const { pool } = await import('./db'); const { withIoDeadline } = await import('./io-deadline');
    const pending = withIoDeadline(100, () => pool.query('UPDATE queued'));
    const assertion = expect(pending).rejects.toThrow('deadline');
    await vi.advanceTimersByTimeAsync(100); await assertion;
    expect(connected).toBeDefined(); connected?.({ query, release }); await vi.runAllTimersAsync();
    expect(query).not.toHaveBeenCalled(); expect(release).toHaveBeenCalledWith(true);
  } finally { vi.useRealTimers(); }
});
