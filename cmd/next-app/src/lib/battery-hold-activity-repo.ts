import { pool } from './db';
import { withIoDeadline } from './io-deadline';

export const APNS_ENVIRONMENTS = ['sandbox', 'production'] as const;
export type ApnsEnvironment = typeof APNS_ENVIRONMENTS[number];
export type ActivityDeliveryState = 'pending' | 'current' | 'ended' | 'disabled';
// 8h live Live Activity + up to 4h ended display on the Lock Screen.
export const ACTIVITY_LIFETIME_HOURS = 12;
export const ENDED_HOLD_REGISTRATION_WINDOW_MS = 4 * 60 * 60 * 1000;
export const ACTIVITY_SYNC_BUDGET_MS = 2000;
// Devices one user may observe a hold from; bounds the rows every reconcile scans.
export const MAX_LIVE_REGISTRATIONS_PER_HOLD = 5;
// Disabled or expired rows are deleted after this, so the table stays small.
export const ACTIVITY_RETENTION_HOURS = 24;

/** Production APNs only on the production deployment; beta, preview and local accept sandbox only. */
export function allowedApnsEnvironments(env: Readonly<Record<string, string | undefined>> = process.env): ApnsEnvironment[] {
  return env.VERCEL_ENV === 'production' ? ['sandbox', 'production'] : ['sandbox'];
}

/**
 * Token-free cause for swallowed bookkeeping failures: the SQLSTATE, 'deadline',
 * or the error name. Never the message or pg detail, which can echo a row (the token).
 */
export function activityErrorTag(e: unknown): string {
  const code = (e as { code?: unknown } | null | undefined)?.code;
  if (typeof code === 'string') return code;
  if (e instanceof Error) return e.message === 'I/O deadline exceeded' ? 'deadline' : e.name;
  return 'unknown';
}

const iso = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
// Projection of the authoritative hold row; the APNs sender maps it to the content state.
const SNAPSHOT = `jsonb_build_object(
  'hold_id', h.id, 'status', h.status, 'mode', h.mode,
  'original_reserve', h.original_reserve, 'target_reserve', h.target_reserve,
  'created_at', ${iso('h.created_at')}, 'safety_expires_at', ${iso('h.safety_expires_at')},
  'restored_at', ${iso('h.restored_at')}, 'restore_reason', h.restore_reason,
  'cancelled_observed_reserve', h.cancelled_observed_reserve, 'monitoring', h.monitoring)`;

/** A registration's delivery state, or why the registration was refused. */
export type RegisterResult = ActivityDeliveryState | 'conflict' | 'limit' | 'hold_ended';

export interface ActivityRegistration {
  holdId: number; userId: string; registrationId: string;
  pushToken: string; apnsEnvironment: ApnsEnvironment;
}

export class BatteryHoldActivityRepo {
  /** Current DB access, not the possibly stale session claim. */
  async userCanAccessSite(userId: string, siteId: string): Promise<boolean> {
    const { rows } = await pool.query(`SELECT 1 FROM "User" u JOIN "Site" s ON s.id = $2
      WHERE u.id = $1 AND u.is_active = true
        AND (s.user_id = u.id OR 'admin' = ANY(COALESCE(u.roles, '{}')))`, [userId, siteId]);
    return rows.length === 1;
  }

  /** `latest` is false once a newer hold exists for the site (a site has at most one active hold). */
  async getHoldForSite(holdId: number, siteId: string): Promise<{ id: number; status: string; restored_at: Date | null; latest: boolean } | null> {
    const { rows } = await pool.query(`SELECT h.id, h.status, h.restored_at,
        NOT EXISTS (SELECT 1 FROM "BatteryHold" n WHERE n.site_id = h.site_id AND n.id > h.id) AS latest
      FROM "BatteryHold" h WHERE h.id = $1 AND h.site_id = $2`, [holdId, siteId]);
    if (!rows.length) return null;
    return { id: Number(rows[0].id), status: rows[0].status, restored_at: rows[0].restored_at ? new Date(rows[0].restored_at) : null, latest: rows[0].latest };
  }

  /**
   * Idempotent per (user, registration); a repeat rotates the token. Returns the
   * delivery state; 'conflict' when the registration id belongs to another hold
   * or APNs environment; 'limit' when a new registration would exceed
   * MAX_LIVE_REGISTRATIONS_PER_HOLD for this user. A disabled or expired
   * registration stays disabled and loses its token. 'hold_ended' means the
   * hold was superseded or is outside the ended registration window.
   */
  async register(r: ActivityRegistration): Promise<RegisterResult> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Same site-first lock order as createHold. Recheck in a separate statement
      // after acquiring it, so a replacement committed during the wait is visible.
      await client.query(`SELECT s.id FROM "Site" s JOIN "BatteryHold" h ON h.site_id = s.id
        WHERE h.id = $1 FOR NO KEY UPDATE OF s`, [r.holdId]);
      // Also lock the hold against terminal transitions and serialize its quota.
      const { rows: [hold] } = await client.query<{ status: string; restored_at: Date | null; latest: boolean }>(
        `SELECT h.status, h.restored_at,
            NOT EXISTS (SELECT 1 FROM "BatteryHold" n WHERE n.site_id = h.site_id AND n.id > h.id) AS latest
          FROM "BatteryHold" h WHERE h.id = $1 FOR NO KEY UPDATE OF h`, [r.holdId]);
      if (!hold || !hold.latest || (hold.status !== 'active'
        && (hold.restored_at === null || Date.now() - hold.restored_at.getTime() > ENDED_HOLD_REGISTRATION_WINDOW_MS))) {
        await client.query('ROLLBACK');
        return 'hold_ended';
      }
      const existing = await client.query(`SELECT 1 FROM "BatteryHoldActivity" WHERE user_id = $1 AND registration_id = $2::uuid`,
        [r.userId, r.registrationId]);
      if (!existing.rows.length) {
        const { rows: [{ live }] } = await client.query(`SELECT count(*)::int AS live FROM "BatteryHoldActivity"
          WHERE user_id = $1 AND hold_id = $2 AND delivery_state <> 'disabled' AND expires_at > now()`, [r.userId, r.holdId]);
        if (live >= MAX_LIVE_REGISTRATIONS_PER_HOLD) {
          await client.query('ROLLBACK');
          return 'limit';
        }
      }
      const { rows } = await client.query(`INSERT INTO "BatteryHoldActivity" AS a
          (hold_id, user_id, registration_id, push_token, apns_environment, expires_at)
        VALUES ($1, $2, $3::uuid, $4, $5, now() + make_interval(hours => $6))
        ON CONFLICT (user_id, registration_id) DO UPDATE
          SET push_token = CASE WHEN a.delivery_state = 'disabled' OR a.expires_at <= now() THEN NULL ELSE EXCLUDED.push_token END,
              delivery_state = CASE WHEN a.expires_at <= now() THEN 'disabled' ELSE a.delivery_state END,
              disabled_reason = CASE WHEN a.delivery_state <> 'disabled' AND a.expires_at <= now() THEN 'expired' ELSE a.disabled_reason END,
              updated_at = now()
          WHERE a.hold_id = EXCLUDED.hold_id AND a.apns_environment = EXCLUDED.apns_environment
        RETURNING delivery_state`,
      [r.holdId, r.userId, r.registrationId, r.pushToken, r.apnsEnvironment, ACTIVITY_LIFETIME_HOURS]);
      await client.query('COMMIT');
      return rows.length ? rows[0].delivery_state as ActivityDeliveryState : 'conflict';
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  async remove(userId: string, siteId: string, registrationId: string): Promise<boolean> {
    const result = await pool.query(`DELETE FROM "BatteryHoldActivity" a USING "BatteryHold" h
      WHERE a.hold_id = h.id AND h.site_id = $2 AND a.user_id = $1 AND a.registration_id = $3::uuid`,
    [userId, siteId, registrationId]);
    return result.rowCount === 1;
  }

  /**
   * Copies the authoritative hold state into each live registration's desired
   * snapshot (all holds when holdId is omitted, including ones no longer active).
   * Monotonic: a terminal snapshot is never replaced, and an older monitoring
   * check never replaces a newer one. Returns the number of rows advanced.
   */
  async syncDesired(holdId?: number): Promise<number> {
    const result = await pool.query(`UPDATE "BatteryHoldActivity" a
      SET desired_snapshot = l.snapshot, desired_version = a.desired_version + 1,
          delivery_state = 'pending', updated_at = now()
      FROM (SELECT a2.id, ${SNAPSHOT} AS snapshot
            FROM "BatteryHoldActivity" a2 JOIN "BatteryHold" h ON h.id = a2.hold_id
            WHERE ($1::bigint IS NULL OR a2.hold_id = $1)
              AND a2.delivery_state IN ('pending', 'current') AND a2.expires_at > now()) l
      WHERE a.id = l.id
        AND a.delivery_state IN ('pending', 'current') AND a.expires_at > now()
        AND a.desired_snapshot IS DISTINCT FROM l.snapshot
        AND COALESCE(a.desired_snapshot->>'status', 'active') = 'active'
        AND (l.snapshot->>'status' <> 'active' OR a.desired_snapshot IS NULL
             OR COALESCE(l.snapshot->'monitoring'->>'checked_at', '')
                >= COALESCE(a.desired_snapshot->'monitoring'->>'checked_at', ''))`,
    [holdId ?? null]);
    return result.rowCount ?? 0;
  }

  /** Acknowledges one delivered version. A newer desired version stays pending; ended/disabled never revive. */
  async acknowledgeDelivery(id: number, version: number): Promise<boolean> {
    const result = await pool.query(`UPDATE "BatteryHoldActivity"
      SET delivered_version = GREATEST(delivered_version, $2),
          delivery_state = CASE
            WHEN delivery_state IN ('ended', 'disabled') THEN delivery_state
            WHEN desired_version > GREATEST(delivered_version, $2) THEN 'pending'
            WHEN desired_snapshot->>'status' <> 'active' THEN 'ended'
            ELSE 'current' END,
          attempt_count = 0, next_attempt_at = NULL, last_error = NULL, updated_at = now()
      WHERE id = $1 AND $2 > 0 AND $2 <= desired_version`, [id, version]);
    return result.rowCount === 1;
  }

  /** Disables registrations past their display lifetime and clears their tokens. */
  async expireStale(): Promise<number> {
    const result = await pool.query(`UPDATE "BatteryHoldActivity"
      SET delivery_state = 'disabled', disabled_reason = 'expired', push_token = NULL, updated_at = now()
      WHERE delivery_state <> 'disabled' AND expires_at <= now()`);
    return result.rowCount ?? 0;
  }

  /** Deletes rows disabled or expired longer than the retention window. */
  async pruneRetired(): Promise<number> {
    const result = await pool.query(`DELETE FROM "BatteryHoldActivity"
      WHERE expires_at <= now() - make_interval(hours => $1)
         OR (delivery_state = 'disabled' AND updated_at <= now() - make_interval(hours => $1))`, [ACTIVITY_RETENTION_HOURS]);
    return result.rowCount ?? 0;
  }
}

/**
 * Push bookkeeping only: bounded, isolated from the caller's (possibly expired)
 * deadline, and never throws, so it can never block or fail reserve restoration.
 * Without a hold id it also expires stale registrations and prunes retired ones.
 */
export async function reconcileBatteryHoldActivities(holdId?: number): Promise<number | null> {
  try {
    return await withIoDeadline(ACTIVITY_SYNC_BUDGET_MS, async () => {
      const repo = new BatteryHoldActivityRepo();
      if (holdId === undefined) {
        await repo.expireStale();
        await repo.pruneRetired();
      }
      return repo.syncDesired(holdId);
    }, null);
  } catch (e) {
    console.warn(`[BatteryHold] Activity state sync deferred${holdId === undefined ? '' : ` for hold ${holdId}`}`, activityErrorTag(e));
    return null;
  }
}
