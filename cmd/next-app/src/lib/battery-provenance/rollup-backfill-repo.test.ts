import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({ pool: { query: vi.fn() } }));
import { pool } from '../db';
import { RollupBackfillRepo, daySpan } from './rollup-backfill-repo';

const q = () => pool.query as ReturnType<typeof vi.fn>;

describe('RollupBackfillRepo', () => {
  beforeEach(() => q().mockReset());

  it('get returns null when no row', async () => {
    q().mockResolvedValueOnce({ rows: [] });
    expect(await new RollupBackfillRepo().get('s1')).toBeNull();
  });

  it('enqueue upserts a pending row with cursor = oldest and inclusive day total', async () => {
    q().mockResolvedValueOnce({ rows: [] });
    await new RollupBackfillRepo().enqueue('s1', '2026-06-01', '2026-06-05');
    const [sql, params] = q().mock.calls.at(-1)!;
    expect(sql).toContain('INSERT INTO "RollupBackfill"');
    expect(sql).toContain('ON CONFLICT');
    expect(params).toEqual(['s1', '2026-06-01', '2026-06-05', 5]); // inclusive day span
  });

  it('daySpan counts both endpoints inclusively across a month boundary', () => {
    expect(daySpan('2026-06-01', '2026-06-05')).toBe(5);
    expect(daySpan('2026-01-30', '2026-02-02')).toBe(4);
  });

  it('claimNext atomically flips one incomplete site to running', async () => {
    q().mockResolvedValueOnce({ rows: [{ site_id: 's1', status: 'running', oldest_date: '2021-06-01',
      cursor_date: '2021-06-01', newest_date: '2026-06-12', days_done: 0, days_total: 1837,
      genesis_anchored: false, last_error: null }] });
    const job = await new RollupBackfillRepo().claimNext(10);
    expect(job?.site_id).toBe('s1');
    const [sql] = q().mock.calls.at(-1)!;
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(sql).toContain("status = 'running'");
  });

  it('recordProgress writes cursor, days_done and genesis flag', async () => {
    q().mockResolvedValueOnce({ rows: [] });
    await new RollupBackfillRepo().recordProgress('s1', '2021-07-15', 44, true);
    const [, params] = q().mock.calls.at(-1)!;
    expect(params).toEqual(['s1', '2021-07-15', 44, true]);
  });

  it('markPending releases the row back to pending', async () => {
    q().mockResolvedValueOnce({ rows: [] });
    await new RollupBackfillRepo().markPending('s1');
    const [sql, params] = q().mock.calls.at(-1)!;
    expect(sql).toContain("status = 'pending'");
    expect(params).toEqual(['s1']);
  });

  it('reopenIfBehind re-opens a complete row when newest_date < target', async () => {
    q().mockResolvedValueOnce({ rowCount: 1, rows: [] });
    const reopened = await new RollupBackfillRepo().reopenIfBehind('s1', '2026-06-12');
    expect(reopened).toBe(true);
    const [sql, params] = q().mock.calls.at(-1)!;
    expect(sql).toContain("status = 'pending'");
    expect(sql).toContain('newest_date <'); // guard
    expect(params).toEqual(['s1', '2026-06-12']);
  });

  it('retry sets status=pending and updates newest_date and days_total for error rows', async () => {
    q().mockResolvedValueOnce({ rows: [] });
    await new RollupBackfillRepo().retry('s1', '2026-06-15');
    const [sql, params] = q().mock.calls.at(-1)!;
    expect(sql).toContain("status = 'pending'");
    expect(sql).toContain("status = 'error'");
    expect(params).toEqual(['s1', '2026-06-15']);
  });

  it('claimNext includes reclaiming error rows older than 1 hour and excluding attempts=5', async () => {
    q().mockResolvedValueOnce({ rows: [{ site_id: 's1' }] });
    await new RollupBackfillRepo().claimNext(10);
    const [sql] = q().mock.calls.at(-1)!;
    expect(sql).toContain("status = 'error' AND updated_at < now() - interval '1 hour' AND (last_error IS NULL OR last_error NOT LIKE '[attempts=5]%')");
    expect(sql).toContain("last_error = CASE");
    expect(sql).toContain("WHEN last_error LIKE '[attempts=%' THEN substring(last_error from '^\\\[attempts=\\d+\\\]') || ' (retrying...)'");
  });

  it('markError reads previous error and increments attempts prefix', async () => {
    // 1st mock: get() returns existing backfill with [attempts=2] prefix
    q().mockResolvedValueOnce({ rows: [{ site_id: 's1', last_error: '[attempts=2] something failed' }] });
    // 2nd mock: query for update
    q().mockResolvedValueOnce({ rows: [] });
    
    await new RollupBackfillRepo().markError('s1', 'new error message');
    
    const [sql, params] = q().mock.calls.at(-1)!;
    expect(sql).toContain('UPDATE "RollupBackfill" SET status = \'error\'');
    expect(params).toEqual(['s1', '[attempts=3] new error message']);
  });
});
