import type { Pool, PoolClient } from 'pg';
import { pool as defaultPool } from './db';

export type TeslaSyncStatus = 'sending' | 'confirmed' | 'unconfirmed' | 'rejected' | 'failed' | 'not_allowed';
export type TeslaSyncFinalStatus = Exclude<TeslaSyncStatus, 'sending'>;

/** A `sending` attempt older than this is treated as a crashed write and failed, so it cannot block the site. */
const STALE_SENDING_INTERVAL = '2 minutes';

export interface TeslaSyncAttempt {
  id: number;
  siteId: string;
  userId: string;
  fingerprint: string;
  selectionId: number | null;
  replacedTeslaTariffId: number | null;
  sentContent: unknown;
  status: TeslaSyncStatus;
  teslaResponse: unknown;
  createdAt: string;
  finishedAt: string | null;
}

export interface BeginAttemptInput {
  siteId: string;
  userId: string;
  fingerprint: string;
  selectionId: number | null;
  replacedTeslaTariffId: number | null;
  sentContent: unknown;
}

export type BeginAttemptResult = { id: number } | { inFlight: TeslaSyncAttempt };

interface AttemptRow {
  id: string;
  site_id: string;
  user_id: string;
  fingerprint: string;
  selection_id: string | null;
  replaced_tesla_tariff_id: string | null;
  sent_content: unknown;
  status: TeslaSyncStatus;
  tesla_response: unknown;
  created_at: Date;
  finished_at: Date | null;
}

const ATTEMPT_COLUMNS = `id, site_id, user_id, fingerprint, selection_id, replaced_tesla_tariff_id,
  sent_content, status, tesla_response, created_at, finished_at`;

function toAttempt(row: AttemptRow): TeslaSyncAttempt {
  return {
    id: Number(row.id),
    siteId: row.site_id,
    userId: row.user_id,
    fingerprint: row.fingerprint,
    selectionId: row.selection_id === null ? null : Number(row.selection_id),
    replacedTeslaTariffId: row.replaced_tesla_tariff_id === null ? null : Number(row.replaced_tesla_tariff_id),
    sentContent: row.sent_content,
    status: row.status,
    teslaResponse: row.tesla_response,
    createdAt: row.created_at.toISOString(),
    finishedAt: row.finished_at === null ? null : row.finished_at.toISOString(),
  };
}

type Queryable = Pick<Pool, 'query'>;

/**
 * Records each "Sync to Tesla" write. `beginAttempt` runs inside the caller's transaction while it
 * holds the Site row lock; the partial unique index on `sending` rows is the backstop for one
 * in-flight write per site.
 */
export class TeslaTariffSyncRepo {
  constructor(private readonly db: Queryable = defaultPool) {}

  async beginAttempt(client: Pick<PoolClient, 'query'>, input: BeginAttemptInput): Promise<BeginAttemptResult> {
    await client.query(
      `UPDATE "TeslaTariffSyncAttempt"
          SET status = 'failed', finished_at = clock_timestamp()
        WHERE site_id = $1 AND status = 'sending'
          AND created_at < clock_timestamp() - interval '${STALE_SENDING_INTERVAL}'`,
      [input.siteId],
    );

    const inFlight = await this.findInFlight(client, input.siteId);
    if (inFlight) return { inFlight };

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO "TeslaTariffSyncAttempt"
         (site_id, user_id, fingerprint, selection_id, replaced_tesla_tariff_id, sent_content, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'sending')
       ON CONFLICT (site_id) WHERE status = 'sending' DO NOTHING
       RETURNING id`,
      [
        input.siteId,
        input.userId,
        input.fingerprint,
        input.selectionId,
        input.replacedTeslaTariffId,
        JSON.stringify(input.sentContent),
      ],
    );
    if (inserted.rows[0]) return { id: Number(inserted.rows[0].id) };

    const raced = await this.findInFlight(client, input.siteId);
    if (!raced) throw new Error('Tesla sync attempt conflicted with a row that is no longer in flight');
    return { inFlight: raced };
  }

  /**
   * Records the outcome. Only a `sending` row can finish, so a settled attempt is never rewritten.
   * Returns false, and logs, when the row was no longer `sending` (for example the stale reaper got there first).
   */
  async finishAttempt(id: number, status: TeslaSyncFinalStatus, teslaResponse?: unknown): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE "TeslaTariffSyncAttempt"
          SET status = $2, tesla_response = $3, finished_at = clock_timestamp()
        WHERE id = $1 AND status = 'sending'`,
      [id, status, teslaResponse === undefined ? null : JSON.stringify(teslaResponse)],
    );
    if (result.rowCount === 1) return true;
    console.warn(`[TeslaSync] Attempt ${id} was no longer sending; its ${status} result was not recorded`);
    return false;
  }

  async latestForSite(siteId: string): Promise<TeslaSyncAttempt | null> {
    const { rows } = await this.db.query<AttemptRow>(
      `SELECT ${ATTEMPT_COLUMNS} FROM "TeslaTariffSyncAttempt"
        WHERE site_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      [siteId],
    );
    return rows[0] ? toAttempt(rows[0]) : null;
  }

  /** The site's attempts still awaiting a read-back, oldest first. */
  async listUnconfirmed(siteId: string): Promise<TeslaSyncAttempt[]> {
    const { rows } = await this.db.query<AttemptRow>(
      `SELECT ${ATTEMPT_COLUMNS} FROM "TeslaTariffSyncAttempt"
        WHERE site_id = $1 AND status = 'unconfirmed'
        ORDER BY created_at ASC, id ASC`,
      [siteId],
    );
    return rows.map(toAttempt);
  }

  /** Confirms one unconfirmed attempt once its sent plan is read back from Tesla. Returns false when it was not unconfirmed. */
  async confirmUnconfirmed(id: number): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE "TeslaTariffSyncAttempt"
          SET status = 'confirmed', finished_at = COALESCE(finished_at, clock_timestamp())
        WHERE id = $1 AND status = 'unconfirmed'`,
      [id],
    );
    return result.rowCount === 1;
  }

  private async findInFlight(client: Pick<PoolClient, 'query'>, siteId: string): Promise<TeslaSyncAttempt | null> {
    const { rows } = await client.query<AttemptRow>(
      `SELECT ${ATTEMPT_COLUMNS} FROM "TeslaTariffSyncAttempt"
        WHERE site_id = $1 AND status = 'sending'
        LIMIT 1`,
      [siteId],
    );
    return rows[0] ? toAttempt(rows[0]) : null;
  }
}
