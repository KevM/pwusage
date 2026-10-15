import { pool } from './db';
import { withIoDeadline } from './io-deadline';

export const APNS_ENVIRONMENTS = ['sandbox', 'production'] as const;
export type ApnsEnvironment = typeof APNS_ENVIRONMENTS[number];
export type ActivityDeliveryState = 'pending' | 'current' | 'ended' | 'disabled';
// 8h live Live Activity + up to 4h ended display on the Lock Screen.
export const ACTIVITY_LIFETIME_HOURS = 12;
export const ENDED_HOLD_REGISTRATION_WINDOW_MS = 4 * 60 * 60 * 1000;
export const ACTIVITY_SYNC_BUDGET_MS = 2000;

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

  async getHoldForSite(holdId: number, siteId: string): Promise<{ id: number; status: string; restored_at: Date | null } | null> {
    const { rows } = await pool.query(`SELECT id, status, restored_at FROM "BatteryHold" WHERE id = $1 AND site_id = $2`, [holdId, siteId]);
    if (!rows.length) return null;
    return { id: Number(rows[0].id), status: rows[0].status, restored_at: rows[0].restored_at ? new Date(rows[0].restored_at) : null };
  }

  /**
   * Idempotent per (user, registration); a repeat rotates the token. Returns the
   * delivery state, or null when the registration id belongs to another hold or
   * APNs environment. A disabled registration stays disabled.
   */
  async register(r: ActivityRegistration): Promise<ActivityDeliveryState | null> {
    const { rows } = await pool.query(`INSERT INTO "BatteryHoldActivity"
        (hold_id, user_id, registration_id, push_token, apns_environment, expires_at)
      VALUES ($1, $2, $3::uuid, $4, $5, now() + make_interval(hours => $6))
      ON CONFLICT (user_id, registration_id) DO UPDATE
        SET push_token = CASE WHEN "BatteryHoldActivity".delivery_state = 'disabled'
              THEN "BatteryHoldActivity".push_token ELSE EXCLUDED.push_token END,
            updated_at = now()
        WHERE "BatteryHoldActivity".hold_id = EXCLUDED.hold_id
          AND "BatteryHoldActivity".apns_environment = EXCLUDED.apns_environment
      RETURNING delivery_state`,
    [r.holdId, r.userId, r.registrationId, r.pushToken, r.apnsEnvironment, ACTIVITY_LIFETIME_HOURS]);
    return rows.length ? rows[0].delivery_state as ActivityDeliveryState : null;
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
            WHERE ($1::bigint IS NULL OR a2.hold_id = $1)) l
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
}

/**
 * Push bookkeeping only: bounded, isolated from the caller's (possibly expired)
 * deadline, and never throws, so it can never block or fail reserve restoration.
 * Without a hold id it reconciles every live registration and expires stale ones.
 */
export async function reconcileBatteryHoldActivities(holdId?: number): Promise<number | null> {
  try {
    return await withIoDeadline(ACTIVITY_SYNC_BUDGET_MS, async () => {
      const repo = new BatteryHoldActivityRepo();
      if (holdId === undefined) await repo.expireStale();
      return repo.syncDesired(holdId);
    }, null);
  } catch (e) {
    console.warn(`[BatteryHold] Activity state sync deferred${holdId === undefined ? '' : ` for hold ${holdId}`}`, activityErrorTag(e));
    return null;
  }
}
