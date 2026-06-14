import { pool } from '../db';
import type { RollupBackfill } from '../db';

/** Inclusive whole-day span between two 'YYYY-MM-DD' strings. */
export function daySpan(oldest: string, newest: string): number {
  const a = Date.UTC(+oldest.slice(0, 4), +oldest.slice(5, 7) - 1, +oldest.slice(8, 10));
  const b = Date.UTC(+newest.slice(0, 4), +newest.slice(5, 7) - 1, +newest.slice(8, 10));
  return Math.floor((b - a) / 86400000) + 1;
}

const SELECT_COLS = `site_id, status,
  oldest_date::text AS oldest_date, cursor_date::text AS cursor_date, newest_date::text AS newest_date,
  days_done, days_total, genesis_anchored, last_error`;

export class RollupBackfillRepo {
  async get(siteId: string): Promise<RollupBackfill | null> {
    const res = await pool.query(`SELECT ${SELECT_COLS} FROM "RollupBackfill" WHERE site_id = $1`, [siteId]);
    return (res.rows[0] as RollupBackfill) ?? null;
  }

  /** Opt-in / heal-from-scratch: create or reset a pending row from oldest..newest. */
  async enqueue(siteId: string, oldestDate: string, newestDate: string): Promise<void> {
    const total = daySpan(oldestDate, newestDate);
    await pool.query(
      `INSERT INTO "RollupBackfill"(site_id, oldest_date, cursor_date, newest_date, status, days_done, days_total)
       VALUES ($1, $2, $2, $3, 'pending', 0, $4)
       ON CONFLICT (site_id) DO UPDATE SET
         status = 'pending', oldest_date = EXCLUDED.oldest_date, cursor_date = EXCLUDED.oldest_date,
         newest_date = EXCLUDED.newest_date, days_done = 0, days_total = EXCLUDED.days_total,
         genesis_anchored = false, last_error = NULL, updated_at = now()`,
      [siteId, oldestDate, newestDate, total],
    );
  }

  /** Atomically claim one incomplete site (oldest opt-in first); reclaim stale 'running' or 'error' rows. */
  async claimNext(staleMinutes = 10): Promise<RollupBackfill | null> {
    const res = await pool.query(
      `UPDATE "RollupBackfill" SET status = 'running', updated_at = now()
       WHERE site_id = (
         SELECT site_id FROM "RollupBackfill"
         WHERE status = 'pending'
            OR (status = 'running' AND updated_at < now() - ($1 || ' minutes')::interval)
            OR (status = 'error' AND updated_at < now() - interval '1 hour')
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       RETURNING ${SELECT_COLS}`,
      [staleMinutes],
    );
    return (res.rows[0] as RollupBackfill) ?? null;
  }

  async recordProgress(siteId: string, cursorDate: string, daysDone: number, genesisAnchored: boolean): Promise<void> {
    await pool.query(
      `UPDATE "RollupBackfill"
       SET cursor_date = $2, days_done = $3, genesis_anchored = $4, status = 'running', updated_at = now()
       WHERE site_id = $1`,
      [siteId, cursorDate, daysDone, genesisAnchored],
    );
  }

  async markComplete(siteId: string): Promise<void> {
    await pool.query(`UPDATE "RollupBackfill" SET status = 'complete', last_error = NULL, updated_at = now() WHERE site_id = $1`, [siteId]);
  }

  async markError(siteId: string, message: string): Promise<void> {
    await pool.query(`UPDATE "RollupBackfill" SET status = 'error', last_error = $2, updated_at = now() WHERE site_id = $1`, [siteId, message.slice(0, 500)]);
  }

  /** Heal-on-return: re-open a complete row whose coverage no longer reaches `target`. Keeps genesis_anchored. */
  async reopenIfBehind(siteId: string, targetNewestDate: string): Promise<boolean> {
    const res = await pool.query(
      `UPDATE "RollupBackfill"
       SET status = 'pending', newest_date = $2,
           days_total = days_total + (($2::date - newest_date) ), updated_at = now()
       WHERE site_id = $1 AND status = 'complete' AND newest_date < $2`,
      [siteId, targetNewestDate],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /** Manual retry: reset an error row to pending and advance the newest target, preserving cursor progress. */
  async retry(siteId: string, newestDate: string): Promise<void> {
    await pool.query(
      `UPDATE "RollupBackfill"
       SET status = 'pending', newest_date = $2,
           days_total = days_total + ($2::date - newest_date),
           last_error = NULL, updated_at = now()
       WHERE site_id = $1 AND status = 'error'`,
      [siteId, newestDate],
    );
  }
}
