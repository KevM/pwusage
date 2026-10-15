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
// A delivery claim outlives any run (see the delivery service budget), so only a dead worker's rows are re-claimed.
export const DELIVERY_CLAIM_LEASE_SECONDS = 120;

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

/** One claimed registration and exactly the desired version it must send. */
export interface ClaimedActivity {
  id: number; pushToken: string; apnsEnvironment: ApnsEnvironment;
  version: number; snapshot: unknown; expiresAt: Date; attempts: number;
}

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
   * registration stays disabled and loses its token; an ended one keeps none. 'hold_ended' means the
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
          SET push_token = CASE WHEN a.delivery_state IN ('ended', 'disabled') OR a.expires_at <= now() THEN NULL ELSE EXCLUDED.push_token END,
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
   * check never replaces a newer one. A terminal snapshot clears any retry
   * backoff so the end is sent on the next delivery run. Returns the number of rows advanced.
   */
  async syncDesired(holdId?: number): Promise<number> {
    const result = await pool.query(`UPDATE "BatteryHoldActivity" a
      SET desired_snapshot = l.snapshot, desired_version = a.desired_version + 1,
          delivery_state = 'pending', updated_at = now(),
          next_attempt_at = CASE WHEN l.snapshot->>'status' <> 'active' THEN NULL ELSE a.next_attempt_at END
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

  /**
   * Claims up to `limit` due registrations for `owner`, terminal snapshots first.
   * Re-gates the APNs environment and current site access (an ineligible row is
   * skipped and left for expiry), and returns the exact desired version and
   * snapshot to send. SKIP LOCKED plus the lease keeps overlapping workers apart.
   */
  async claimForDelivery(params: { owner: string; environments: readonly ApnsEnvironment[]; limit: number; leaseSeconds?: number }): Promise<ClaimedActivity[]> {
    if (!params.environments.length || params.limit <= 0) return [];
    const { rows } = await pool.query(`WITH picked AS (
        SELECT a.id FROM "BatteryHoldActivity" a
          JOIN "BatteryHold" h ON h.id = a.hold_id
          JOIN "Site" s ON s.id = h.site_id
          JOIN "User" u ON u.id = a.user_id
        WHERE a.delivery_state = 'pending' AND a.desired_version > a.delivered_version
          AND a.desired_snapshot IS NOT NULL AND a.push_token IS NOT NULL AND a.expires_at > now()
          AND a.apns_environment = ANY($1::text[])
          AND (a.next_attempt_at IS NULL OR a.next_attempt_at <= now())
          AND (a.claim_expires_at IS NULL OR a.claim_expires_at <= now())
          AND u.is_active = true AND (s.user_id = u.id OR 'admin' = ANY(COALESCE(u.roles, '{}')))
        ORDER BY (a.desired_snapshot->>'status' = 'active'), a.next_attempt_at NULLS FIRST, a.id
        LIMIT $2
        FOR UPDATE OF a SKIP LOCKED)
      UPDATE "BatteryHoldActivity" a
      SET claim_owner = $3::uuid, claim_expires_at = now() + make_interval(secs => $4)
      FROM picked WHERE a.id = picked.id
      RETURNING a.id, a.push_token, a.apns_environment, a.desired_version, a.desired_snapshot, a.expires_at, a.attempt_count`,
    [params.environments, params.limit, params.owner, params.leaseSeconds ?? DELIVERY_CLAIM_LEASE_SECONDS]);
    return rows
      .map(r => ({
        id: Number(r.id), pushToken: r.push_token, apnsEnvironment: r.apns_environment as ApnsEnvironment,
        version: Number(r.desired_version), snapshot: r.desired_snapshot, expiresAt: new Date(r.expires_at),
        attempts: Number(r.attempt_count),
      }))
      .sort((a, b) => Number((a.snapshot as { status?: string })?.status === 'active') - Number((b.snapshot as { status?: string })?.status === 'active') || a.id - b.id);
  }

  /**
   * APNs accepted `version`, sent to `token`, for the claim held by `owner`.
   * Advance-only: a stale or duplicate completion just releases the claim and
   * leaves backoff alone. If the app rotated the token mid-send, the acceptance
   * says nothing about the new token: the claim is released without advancing
   * so the same version goes to the new token next run. A newer desired
   * version stays pending; an accepted end drops the token; ended/disabled
   * never revive. Returns true when the version was acknowledged.
   */
  async completeDelivery(id: number, owner: string, version: number, token: string): Promise<boolean> {
    const { rows } = await pool.query(`WITH c AS (
        SELECT id, push_token IS NOT DISTINCT FROM $4 AND push_token IS NOT NULL AS sent
        FROM "BatteryHoldActivity"
        WHERE id = $1 AND claim_owner = $2::uuid AND $3 > 0 AND $3 <= desired_version
        FOR UPDATE)
      UPDATE "BatteryHoldActivity" a
      SET delivered_version = CASE WHEN c.sent THEN GREATEST(a.delivered_version, $3) ELSE a.delivered_version END,
          delivery_state = CASE
            WHEN NOT c.sent OR a.delivery_state IN ('ended', 'disabled') OR $3 <= a.delivered_version THEN a.delivery_state
            WHEN a.desired_version > $3 THEN 'pending'
            WHEN a.desired_snapshot->>'status' <> 'active' THEN 'ended'
            ELSE 'current' END,
          push_token = CASE
            WHEN c.sent AND $3 > a.delivered_version AND a.desired_version = $3 AND a.desired_snapshot->>'status' <> 'active' THEN NULL
            ELSE a.push_token END,
          attempt_count = CASE WHEN c.sent AND $3 > a.delivered_version THEN 0 ELSE a.attempt_count END,
          next_attempt_at = CASE WHEN c.sent AND $3 > a.delivered_version THEN NULL ELSE a.next_attempt_at END,
          last_error = CASE WHEN c.sent AND $3 > a.delivered_version THEN NULL ELSE a.last_error END,
          claim_owner = NULL, claim_expires_at = NULL, updated_at = now()
      FROM c WHERE a.id = c.id
      RETURNING c.sent`, [id, owner, version, token]);
    return rows[0]?.sent === true;
  }

  /**
   * A retryable failure of `version`: counts the attempt, backs off until
   * `retryAt` and records a token-free reason. A newer terminal version that
   * arrived meanwhile keeps its immediate retry.
   */
  async deferDelivery(id: number, owner: string, version: number, failure: { error: string; retryAt: Date }): Promise<boolean> {
    const result = await pool.query(`UPDATE "BatteryHoldActivity"
      SET attempt_count = attempt_count + 1, last_error = $4,
          next_attempt_at = CASE
            WHEN desired_version > $3 AND desired_snapshot->>'status' <> 'active' THEN NULL ELSE $5::timestamptz END,
          claim_owner = NULL, claim_expires_at = NULL, updated_at = now()
      WHERE id = $1 AND claim_owner = $2::uuid`, [id, owner, version, failure.error, failure.retryAt]);
    return result.rowCount === 1;
  }

  /**
   * APNs rejected `token` as invalid: disables the registration and clears it.
   * If the app rotated the token meanwhile, only releases the claim so the new
   * token is tried next run. Returns true when the row was disabled.
   */
  async disableInvalidToken(id: number, owner: string, token: string, reason: string): Promise<boolean> {
    const result = await pool.query(`UPDATE "BatteryHoldActivity"
      SET delivery_state = CASE WHEN push_token = $3 THEN 'disabled' ELSE delivery_state END,
          disabled_reason = CASE WHEN push_token = $3 THEN $4 ELSE disabled_reason END,
          push_token = CASE WHEN push_token = $3 THEN NULL ELSE push_token END,
          claim_owner = NULL, claim_expires_at = NULL, updated_at = now()
      WHERE id = $1 AND claim_owner = $2::uuid
      RETURNING delivery_state`, [id, owner, token, reason]);
    return result.rows[0]?.delivery_state === 'disabled';
  }

  /** Releases an unattempted claim without counting an attempt or backing off. */
  async releaseClaim(id: number, owner: string): Promise<boolean> {
    const result = await pool.query(`UPDATE "BatteryHoldActivity" SET claim_owner = NULL, claim_expires_at = NULL
      WHERE id = $1 AND claim_owner = $2::uuid`, [id, owner]);
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
