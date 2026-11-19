import crypto from 'node:crypto';
import { pool } from '@/lib/db';
import { isValidMobileLoginExchangeParameters, isValidMobileLoginParameters } from './mobile-login-validation';

export { isValidMobileLoginExchangeParameters, isValidMobileLoginParameters } from './mobile-login-validation';

const CODE_TTL_MINUTES = 5;
const CLEANUP_BATCH_SIZE = 100;

export interface CreateMobileLoginHandoffInput {
  attemptId: string;
  codeChallenge: string;
  appState: string;
  userId: string;
  siteIds: string[];
  roles: string[];
}

export interface ConsumeMobileLoginHandoffInput {
  attemptId: string;
  code: string;
  verifier: string;
  appState: string;
}

export interface MobileLoginHandoffClaims {
  userId: string;
  siteIds: string[];
  roles: string[];
  /** The account's session_version when the handoff was created. */
  sessionVersion: number;
}

export function createCodeChallenge(verifier: string): string {
  if (verifier.length < 43 || verifier.length > 128 || !/^[A-Za-z0-9_-]+$/.test(verifier)) {
    throw new Error('Invalid mobile login verifier');
  }
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

export async function createMobileLoginHandoff(
  input: CreateMobileLoginHandoffInput,
): Promise<{ code: string; attemptId: string }> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.attemptId)
    || !isValidMobileLoginParameters(input.codeChallenge, input.appState)) {
    throw new Error('Invalid mobile login attempt');
  }

  const code = crypto.randomBytes(32).toString('base64url');
  const codeHash = crypto.createHash('sha256').update(code).digest('hex');

  // This login-only cleanup is bounded so abandoned handoffs cannot grow the table indefinitely.
  await pool.query(`
    DELETE FROM "MobileLoginHandoff"
    WHERE attempt_id IN (
      SELECT attempt_id
      FROM "MobileLoginHandoff"
      WHERE expires_at <= now()
      ORDER BY expires_at
      LIMIT $1
    )
  `, [CLEANUP_BATCH_SIZE]);

  // Bind the handoff to the account's session_version in the statement that
  // writes it: a sign out everywhere before this point is captured here, and
  // one after it makes the exchange refuse the handoff.
  const inserted = await pool.query(`
    INSERT INTO "MobileLoginHandoff"
      (attempt_id, code_hash, code_challenge, app_state, user_id, site_ids, roles, expires_at, session_version)
    SELECT $1, $2, $3, $4, u.id, $6::text[], $7::text[], now() + ($8 * interval '1 minute'), u.session_version
    FROM "User" u
    WHERE u.id = $5
  `, [
    input.attemptId,
    codeHash,
    input.codeChallenge,
    input.appState,
    input.userId,
    input.siteIds,
    input.roles,
    CODE_TTL_MINUTES,
  ]);
  if (inserted.rowCount !== 1) throw new Error('Mobile login account not found');

  return { code, attemptId: input.attemptId };
}

export async function consumeMobileLoginHandoff(
  input: ConsumeMobileLoginHandoffInput,
): Promise<MobileLoginHandoffClaims | null> {
  if (!isValidMobileLoginExchangeParameters(input.attemptId, input.code, input.verifier, input.appState)) return null;
  const codeChallenge = createCodeChallenge(input.verifier);

  const codeHash = crypto.createHash('sha256').update(input.code).digest('hex');
  // A handoff whose session_version no longer matches the account was revoked
  // by sign out everywhere; one without a version predates the binding.
  // Neither is consumable.
  const { rows } = await pool.query(`
    UPDATE "MobileLoginHandoff" h
    SET consumed_at = now()
    FROM "User" u
    WHERE h.attempt_id = $1
      AND h.code_hash = $2
      AND h.code_challenge = $3
      AND h.app_state = $4
      AND h.expires_at > now()
      AND h.consumed_at IS NULL
      AND u.id = h.user_id
      AND h.session_version IS NOT NULL
      AND h.session_version = u.session_version
    RETURNING h.user_id, h.site_ids, h.roles, h.session_version
  `, [input.attemptId, codeHash, codeChallenge, input.appState]);

  if (rows.length !== 1) return null;
  const row = rows[0] as { user_id: string; site_ids: string[]; roles: string[]; session_version: number };
  return { userId: row.user_id, siteIds: row.site_ids, roles: row.roles, sessionVersion: row.session_version };
}
