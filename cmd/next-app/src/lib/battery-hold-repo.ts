import { pool } from './db';
import { BatteryHold } from './db';

function mapRow(row: {
  id: number; site_id: string | number; status: string; mode: string | null;
  original_reserve: number; target_reserve: number;
  parked_soc: number | string; baseline_load_w: number | string;
  restore_reason: string | null; created_at: string | Date;
  restored_at: string | Date | null; safety_expires_at: string | Date;
  acknowledged_at: string | Date | null;
}): BatteryHold {
  return {
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
  };
}

export class BatteryHoldRepo {
  async getActiveHold(siteId: string): Promise<BatteryHold | null> {
    const { rows } = await pool.query(`
      SELECT * FROM "BatteryHold"
      WHERE site_id = $1 AND status = 'active'
      ORDER BY created_at DESC
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
    const { rows } = await pool.query(`
      INSERT INTO "BatteryHold"
        (site_id, original_reserve, target_reserve, parked_soc, baseline_load_w, safety_expires_at, mode)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `, [
      params.siteId, params.originalReserve, params.targetReserve,
      params.parkedSoc, params.baselineLoadW, params.safetyExpiresAt,
      params.mode ?? 'auto',
    ]);
    return mapRow(rows[0]);
  }

  async markRestored(id: number, reason: 'load_ended' | 'manual' | 'safety_timeout' | 'timer_elapsed'): Promise<void> {
    await pool.query(`
      UPDATE "BatteryHold"
      SET status = 'restored', restore_reason = $2, restored_at = now()
      WHERE id = $1
    `, [id, reason]);
  }

  async markCancelled(id: number, reason: 'reserve_changed'): Promise<void> {
    await pool.query(`
      UPDATE "BatteryHold"
      SET status = 'cancelled', restore_reason = $2, restored_at = now()
      WHERE id = $1
    `, [id, reason]);
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
