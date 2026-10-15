import { pool } from './db';
import type { BatteryHoldMonitoring } from './battery-hold-monitoring';
import { BatteryHold } from './db';

function mapRow(row: {
  monitoring?: BatteryHoldMonitoring | null;
  restore_attempted_at?: Date | string | null;
  id: number; site_id: string | number; status: string; mode: string | null;
  original_reserve: number; target_reserve: number;
  parked_soc: number | string; baseline_load_w: number | string;
  restore_reason: string | null; created_at: string | Date;
  restored_at: string | Date | null; safety_expires_at: string | Date;
  acknowledged_at: string | Date | null;
  cancelled_observed_reserve: number | string | null;
}): BatteryHold {
  return {
    monitoring: row.monitoring ?? null,
    restore_attempted_at: row.restore_attempted_at ? new Date(row.restore_attempted_at) : null,
    id: Number(row.id),
    site_id: row.site_id.toString(),
    status: row.status as BatteryHold['status'],
    mode: (row.mode ?? 'auto') as BatteryHold['mode'],
    original_reserve: Number(row.original_reserve),
    target_reserve: Number(row.target_reserve),
    parked_soc: Number(row.parked_soc),
    baseline_load_w: Number(row.baseline_load_w),
    restore_reason: row.restore_reason as BatteryHold['restore_reason'],
    created_at: new Date(row.created_at),
    restored_at: row.restored_at === null ? null : new Date(row.restored_at),
    safety_expires_at: new Date(row.safety_expires_at),
    acknowledged_at: row.acknowledged_at == null ? null : new Date(row.acknowledged_at),
    cancelled_observed_reserve: row.cancelled_observed_reserve === null || row.cancelled_observed_reserve === undefined ? null : Number(row.cancelled_observed_reserve),
  };
}

export class BatteryHoldRepo {
  async clearRestoreAttempt(id: number, owner: string): Promise<boolean> {
    const result = await pool.query(`UPDATE "BatteryHold" SET restore_attempted_at = NULL, restore_reason = NULL
      WHERE id = $1 AND status = 'active' AND processing_owner = $2::uuid
        AND processing_expires_at > clock_timestamp()`, [id, owner]);
    return result.rowCount === 1;
  }

  async claimHold(id: number, owner: string): Promise<boolean> {
    const result = await pool.query(`UPDATE "BatteryHold"
      SET processing_owner = $2::uuid, processing_expires_at = clock_timestamp() + interval '120 seconds'
      WHERE id = $1 AND status = 'active'
        AND (processing_expires_at IS NULL OR processing_expires_at <= clock_timestamp())`, [id, owner]);
    return result.rowCount === 1;
  }

  async releaseHold(id: number, owner: string): Promise<void> {
    await pool.query(`UPDATE "BatteryHold" SET processing_owner = NULL, processing_expires_at = NULL
      WHERE id = $1 AND processing_owner = $2::uuid`, [id, owner]);
  }

  async ownsHold(id: number, owner: string): Promise<boolean> {
    const result = await pool.query(`SELECT id FROM "BatteryHold" WHERE id = $1 AND status = 'active'
      AND processing_owner = $2::uuid AND processing_expires_at > clock_timestamp()`, [id, owner]);
    return result.rows.length === 1;
  }

  async recordRestoreAttempt(id: number, owner: string, reason: 'load_ended' | 'manual' | 'safety_timeout' | 'timer_elapsed'): Promise<boolean> {
    const result = await pool.query(`UPDATE "BatteryHold" SET restore_attempted_at = clock_timestamp(), restore_reason = $3
      WHERE id = $1 AND status = 'active' AND processing_owner = $2::uuid
        AND processing_expires_at > clock_timestamp()
        AND (restore_attempted_at IS NULL OR restore_attempted_at <= clock_timestamp() - interval '15 minutes')`, [id, owner, reason]);
    return result.rowCount === 1;
  }

  async getActiveHold(siteId: string): Promise<BatteryHold | null> {
    const { rows } = await pool.query(`
      SELECT * FROM "BatteryHold"
      WHERE site_id = $1 AND status = 'active'
      ORDER BY created_at DESC
      LIMIT 1
    `, [siteId]);
    return rows.length ? mapRow(rows[0]) : null;
  }

  async getLatestRestoredHold(siteId: string): Promise<BatteryHold | null> {
    const { rows } = await pool.query(`
      SELECT * FROM "BatteryHold"
      WHERE site_id = $1 AND status = 'restored' AND restored_at IS NOT NULL
      ORDER BY restored_at DESC, id DESC
      LIMIT 1
    `, [siteId]);
    return rows.length ? mapRow(rows[0]) : null;
  }

  async getAllActiveHolds(): Promise<BatteryHold[]> {
    const { rows } = await pool.query(`
      SELECT * FROM "BatteryHold" WHERE status = 'active' ORDER BY created_at ASC
    `);
    return rows.map(mapRow);
  }

  async createHold(params: {
    siteId: string; originalReserve: number; targetReserve: number;
    parkedSoc: number; baselineLoadW: number; safetyExpiresAt: Date;
    mode?: 'auto' | 'timer';
  }): Promise<BatteryHold> {
    // Share the activity registration lock, before allocating/inserting a new
    // hold. The CTE keeps the site lock until this statement commits.
    const { rows } = await pool.query(`
      WITH locked_site AS (
        SELECT id FROM "Site" WHERE id = $1 FOR NO KEY UPDATE
      )
      INSERT INTO "BatteryHold"
        (site_id, original_reserve, target_reserve, parked_soc, baseline_load_w, safety_expires_at, mode)
      SELECT id, $2, $3, $4, $5, $6, $7 FROM locked_site
      RETURNING *
    `, [
      params.siteId, params.originalReserve, params.targetReserve,
      params.parkedSoc, params.baselineLoadW, params.safetyExpiresAt,
      params.mode ?? 'auto',
    ]);
    return mapRow(rows[0]);
  }

  async recordMonitoring(id: number, monitoring: BatteryHoldMonitoring): Promise<void> {
    await pool.query(`UPDATE "BatteryHold" SET monitoring = $2::jsonb
      WHERE id = $1 AND status = 'active'
        AND (monitoring IS NULL OR monitoring->>'checked_at' <= $3)`,
    [id, JSON.stringify(monitoring), monitoring.checked_at]);
  }

  async markRestored(id: number, reason: 'load_ended' | 'manual' | 'safety_timeout' | 'timer_elapsed', owner?: string): Promise<boolean> {
    const result = await pool.query(`
      UPDATE "BatteryHold"
      SET status = 'restored', restore_reason = $2, restored_at = now()
      WHERE id = $1 AND status = 'active'
        AND ($3::uuid IS NULL OR (processing_owner = $3::uuid AND processing_expires_at > clock_timestamp()))
    `, [id, reason, owner ?? null]);
    return result.rowCount === 1;
  }

  async markCancelled(id: number, reason: 'reserve_changed', observedReserve: number, owner?: string): Promise<boolean> {
    const result = await pool.query(`
      UPDATE "BatteryHold"
      SET status = 'cancelled', restore_reason = $2, restored_at = now(), cancelled_observed_reserve = $3
      WHERE id = $1 AND status = 'active'
        AND ($4::uuid IS NULL OR (processing_owner = $4::uuid AND processing_expires_at > clock_timestamp()))
    `, [id, reason, observedReserve, owner ?? null]);
    return result.rowCount === 1;
  }

  async getLatestCancelledUnacked(siteId: string): Promise<BatteryHold | null> {
    const { rows } = await pool.query(`
      SELECT * FROM "BatteryHold"
      WHERE site_id = $1 AND status = 'cancelled'
        AND restore_reason = 'reserve_changed' AND acknowledged_at IS NULL
      ORDER BY restored_at DESC NULLS LAST, created_at DESC
      LIMIT 1
    `, [siteId]);
    return rows.length ? mapRow(rows[0]) : null;
  }

  async acknowledge(id: number): Promise<void> {
    await pool.query(`UPDATE "BatteryHold" SET acknowledged_at = now() WHERE id = $1`, [id]);
  }
}
