import crypto from 'node:crypto';
import { pool } from '@/lib/db';

export const TRMNL_MANAGE_BINDING_COOKIE = 'trmnl_manage_binding';
export const TRMNL_MANAGE_HANDOFF_TTL_SECONDS = 10 * 60;
const CLEANUP_BATCH_SIZE = 100;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CreateTrmnlManageHandoffInput {
  deviceUuid: string;
  trmnlToken: string;
}

export interface ConsumeTrmnlManageHandoffInput {
  handoffId: string;
  deviceUuid: string;
  browserBinding: string;
}

function hashBinding(binding: string): string {
  return crypto.createHash('sha256').update(binding).digest('hex');
}

export async function createTrmnlManageHandoff(
  input: CreateTrmnlManageHandoffInput,
): Promise<{ handoffId: string; browserBinding: string }> {
  const deviceUuid = input.deviceUuid.trim();
  const trmnlToken = input.trmnlToken.trim();
  if (!deviceUuid || !trmnlToken) {
    throw new Error('Invalid TRMNL manage handoff input');
  }

  const handoffId = crypto.randomUUID();
  const browserBinding = crypto.randomBytes(32).toString('base64url');
  const browserBindingHash = hashBinding(browserBinding);

  // Bounded cleanup so abandoned handoffs cannot grow the table indefinitely.
  await pool.query(`
    DELETE FROM "TrmnlManageHandoff"
    WHERE id IN (
      SELECT id
      FROM "TrmnlManageHandoff"
      WHERE expires_at <= now()
      ORDER BY expires_at
      LIMIT $1
    )
  `, [CLEANUP_BATCH_SIZE]);

  await pool.query(`
    INSERT INTO "TrmnlManageHandoff"
      (id, device_uuid, browser_binding_hash, trmnl_token, expires_at)
    VALUES ($1, $2, $3, $4, now() + ($5 * interval '1 second'))
  `, [handoffId, deviceUuid, browserBindingHash, trmnlToken, TRMNL_MANAGE_HANDOFF_TTL_SECONDS]);

  return { handoffId, browserBinding };
}

export async function consumeTrmnlManageHandoff(
  input: ConsumeTrmnlManageHandoffInput,
): Promise<string | null> {
  const handoffId = input.handoffId.trim();
  const deviceUuid = input.deviceUuid.trim();
  const browserBinding = input.browserBinding.trim();
  if (!UUID_RE.test(handoffId) || !deviceUuid || !browserBinding) {
    return null;
  }

  const browserBindingHash = hashBinding(browserBinding);
  const { rows } = await pool.query(`
    UPDATE "TrmnlManageHandoff"
    SET consumed_at = now()
    WHERE id = $1
      AND device_uuid = $2
      AND browser_binding_hash = $3
      AND expires_at > now()
      AND consumed_at IS NULL
    RETURNING trmnl_token
  `, [handoffId, deviceUuid, browserBindingHash]);

  if (rows.length !== 1) return null;
  const row = rows[0] as { trmnl_token: string };
  return row.trmnl_token;
}
