import type { PoolClient } from 'pg';
import type { SiteTariffReattributionRow } from './db-types';
import { accountFingerprint, logEvent } from './observability';
import { HAS_SAMPLES_SQL } from './prototypes/compact-history-store';
import type { ReattributionStatusDTO } from './tariff-contract';
import { addCalendarDays } from './tariff-timeline';

/** Start of history for a re-attribution that must reach back before the earliest plan. */
export const REATTRIBUTION_HISTORY_START = '2015-01-01';

export interface EnqueueReattributionParams {
  siteId: string;
  fromDate: string;
  toDate: string | null;
  requestedByUserId: string | null;
  trigger: 'create' | 'update' | 'delete' | 'retry' | 'tesla_sync';
}

export interface EnqueuedReattribution {
  dto: ReattributionStatusDTO;
  coalesced: boolean;
  fromDate: string;
  toDate: string | null;
  totalDays: number;
}

export function formatDateCol(val: string | Date | null): string | null {
  if (val === null) return null;
  if (typeof val === 'string') return val.slice(0, 10);
  return val.toISOString().slice(0, 10);
}

export function toDTO(row: SiteTariffReattributionRow): ReattributionStatusDTO {
  return {
    status: row.status,
    fromDate: formatDateCol(row.from_date) ?? '',
    toDate: formatDateCol(row.to_date),
    totalDays: Number(row.total_days),
    processedDays: Number(row.processed_days),
    updatedDays: Number(row.updated_days),
    lastError: row.last_error,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : new Date(row.updated_at).toISOString(),
  };
}

function minDate(a: string, b: string): string {
  return a <= b ? a : b;
}

function maxNullableDate(a: string | null, b: string | null): string | null {
  if (a === null || b === null) return null;
  return a >= b ? a : b;
}


/**
 * Queue (or widen) the site's re-attribution job on `client`, inside the caller's transaction.
 * A tariff mutation calls this before it commits so the edit and its job land together or not at all.
 */
export async function enqueueReattributionOnClient(
  client: PoolClient,
  params: EnqueueReattributionParams
): Promise<EnqueuedReattribution> {
  let coalesced = false;
  let effectiveFrom = params.fromDate;
  let effectiveTo = params.toDate;
  let totalDays = 0;

  const siteRes = await client.query<{ timezone: string }>(
    'SELECT timezone FROM "Site" WHERE id = $1 FOR UPDATE',
    [params.siteId]
  );
  const timezone = siteRes.rows[0]?.timezone || 'UTC';

  const existingRes = await client.query<SiteTariffReattributionRow>(
    'SELECT * FROM "SiteTariffReattribution" WHERE site_id = $1 FOR UPDATE',
    [params.siteId]
  );
  const existing = existingRes.rows[0];
  // A failed job still has unfinished work, so its range must survive the replacement upsert.
  if (existing && (existing.status === 'pending' || existing.status === 'running' || existing.status === 'failed')) {
    coalesced = true;
    const oldFrom = formatDateCol(existing.from_date) ?? params.fromDate;
    const oldTo = formatDateCol(existing.to_date);
    effectiveFrom = minDate(oldFrom, params.fromDate);
    effectiveTo = maxNullableDate(oldTo, params.toDate);
  }

  // Dates in a gap after this range are priced from the nearest earlier plan (the fallback in
  // resolveTariffForDate), so an edit to that plan changes them too: carry the range through
  // the gap up to the next explicit period, or without end when none follows.
  if (effectiveTo !== null) {
    const nextRes = await client.query<{ next_from: string | null }>(
      `SELECT MIN(effective_from)::text AS next_from FROM "TariffEffectivePeriod"
       WHERE site_id = $1 AND effective_from > $2::date`,
      [params.siteId, effectiveTo]
    );
    if (nextRes.rows.length > 0) {
      const nextFrom = nextRes.rows[0].next_from?.slice(0, 10) ?? null;
      if (nextFrom === null) {
        effectiveTo = null;
      } else if (nextFrom > addCalendarDays(effectiveTo, 1)) {
        effectiveTo = addCalendarDays(nextFrom, -1);
      }
    }
  }

  // Days before the earliest plan are priced from it, so editing it changes them too.
  const earliestRes = await client.query<{ earliest_from: string | null }>(
    'SELECT MIN(effective_from)::text AS earliest_from FROM "TariffEffectivePeriod" WHERE site_id = $1',
    [params.siteId]
  );
  const earliestFrom = earliestRes.rows[0]?.earliest_from?.slice(0, 10);
  if (earliestFrom && effectiveFrom <= earliestFrom) {
    effectiveFrom = REATTRIBUTION_HISTORY_START;
  }

  const countRes = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM "EnergyDayArchive"
     WHERE site_id = $1
       AND ${HAS_SAMPLES_SQL()}
       AND (day_start AT TIME ZONE $2)::date >= $3::date
       AND ($4::date IS NULL OR (day_start AT TIME ZONE $2)::date <= $4::date)`,
    [params.siteId, timezone, effectiveFrom, effectiveTo]
  );
  totalDays = Number(countRes.rows[0]?.count ?? 0);

  const upsertRes = await client.query<SiteTariffReattributionRow>(
    `INSERT INTO "SiteTariffReattribution" (
       site_id, status, generation, from_date, to_date, cursor_day_start,
       total_days, processed_days, updated_days, attempt_count, last_error, requested_by_user_id, updated_at
     )
     VALUES ($1, 'pending', 1, $2::date, $3::date, NULL, $4, 0, 0, 0, NULL, $5, now())
     ON CONFLICT (site_id) DO UPDATE SET
       status = 'pending',
       generation = "SiteTariffReattribution".generation + 1,
       from_date = EXCLUDED.from_date,
       to_date = EXCLUDED.to_date,
       cursor_day_start = NULL,
       total_days = EXCLUDED.total_days,
       processed_days = 0,
       updated_days = 0,
       attempt_count = 0,
       last_error = NULL,
       requested_by_user_id = EXCLUDED.requested_by_user_id,
       updated_at = now()
     RETURNING *`,
    [params.siteId, effectiveFrom, effectiveTo, totalDays, params.requestedByUserId]
  );
  const dto = toDTO(upsertRes.rows[0]);

  return { dto, coalesced, fromDate: effectiveFrom, toDate: effectiveTo, totalDays };
}

export function logReattributionEnqueued(params: EnqueueReattributionParams, queued: EnqueuedReattribution): void {
  logEvent('info', 'tariff.reattribution.enqueued', {
    trigger: params.trigger,
    fromDate: queued.fromDate,
    toDate: queued.toDate,
    totalDays: queued.totalDays,
    coalesced: queued.coalesced,
    accountId: params.requestedByUserId ? accountFingerprint(params.requestedByUserId) : null,
  });
}
