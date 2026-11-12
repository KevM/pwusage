import type { PoolClient } from 'pg';
import { pool } from './db';
import type { SiteTariffReattributionRow, Tariff } from './db-types';
import { accountFingerprint, errorFields, flushLogEvents, logEvent } from './observability';
import { CompactHistoryStore, HAS_SAMPLES_SQL } from './prototypes/compact-history-store';
import {
  deriveDayAttribution,
  isAttributionComplete,
  segmentsEqual,
  type DayAttribution,
} from './prototypes/day-attribution';
import { Schedule } from './schedule';
import type { ReattributionStatusDTO } from './tariff-contract';
import { addCalendarDays, siteLocalDateString } from './tariff-timeline';
import { TariffTimelineRepo } from './tariff-timeline-repo';

export const REATTRIBUTION_CHUNK_DAYS = 15;
export const REATTRIBUTION_MAX_TIME_MS = 35_000;
export const REATTRIBUTION_AFTER_MAX_TIME_MS = 6_000;
export const REATTRIBUTION_MAX_ATTEMPTS = 5;
/** Start of history for a re-attribution that must reach back before the earliest plan. */
const REATTRIBUTION_HISTORY_START = '2015-01-01';

interface ArchiveMetadataScanRow {
  day_start: Date;
  day_end: Date;
  format_version: number;
  metadata_version: number;
  attribution_complete: boolean;
  attribution: DayAttribution | null;
}

function formatDateCol(val: string | Date | null): string | null {
  if (val === null) return null;
  if (typeof val === 'string') return val.slice(0, 10);
  return val.toISOString().slice(0, 10);
}

function toDTO(row: SiteTariffReattributionRow): ReattributionStatusDTO {
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

function sanitizedErrorToken(error: unknown): string {
  const fields = errorFields(error);
  const parts = [fields.errorName, fields.errorCode, fields.constraint]
    .filter((v): v is string => typeof v === 'string' && v.length > 0);
  return (parts.join(':') || 'UnknownError').slice(0, 120);
}

export async function getSiteReattributionStatus(siteId: string): Promise<ReattributionStatusDTO | null> {
  const res = await pool.query<SiteTariffReattributionRow>(
    'SELECT * FROM "SiteTariffReattribution" WHERE site_id = $1',
    [siteId]
  );
  const row = res.rows[0];
  if (!row || row.status === 'idle') return null;
  return toDTO(row);
}

export async function enqueueTariffReattribution(params: {
  siteId: string;
  fromDate: string;
  toDate: string | null;
  requestedByUserId: string | null;
  trigger: 'create' | 'update' | 'delete' | 'retry';
}): Promise<ReattributionStatusDTO> {
  const client = await pool.connect();
  let dto: ReattributionStatusDTO;
  let coalesced = false;
  let effectiveFrom = params.fromDate;
  let effectiveTo = params.toDate;
  let totalDays = 0;

  try {
    await client.query('BEGIN');
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
    dto = toDTO(upsertRes.rows[0]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  logEvent('info', 'tariff.reattribution.enqueued', {
    trigger: params.trigger,
    fromDate: effectiveFrom,
    toDate: effectiveTo,
    totalDays,
    coalesced,
    accountId: params.requestedByUserId ? accountFingerprint(params.requestedByUserId) : null,
  });
  return dto;
}

export async function runSiteReattribution(params: {
  siteId: string;
  trigger: 'after' | 'cron';
  maxTimeMs?: number;
  chunkDays?: number;
  clock?: () => number;
}): Promise<{ outcome: 'idle' | 'partial' | 'busy' | 'failed'; processedDays: number; updatedDays: number }> {
  const clock = params.clock ?? Date.now;
  const maxTimeMs = params.maxTimeMs ?? REATTRIBUTION_MAX_TIME_MS;
  const chunkDays = params.chunkDays ?? REATTRIBUTION_CHUNK_DAYS;
  const startedAt = clock();

  const claimRes = await pool.query<SiteTariffReattributionRow>(
    `UPDATE "SiteTariffReattribution"
     SET status = 'running', updated_at = now()
     WHERE site_id = $1
       AND (status = 'pending' OR (status = 'running' AND updated_at < now() - interval '2 minutes'))
     RETURNING *`,
    [params.siteId]
  );
  const job = claimRes.rows[0];
  if (!job) {
    return { outcome: 'busy', processedDays: 0, updatedDays: 0 };
  }

  const expectedGeneration = Number(job.generation);
  const fromDate = formatDateCol(job.from_date) ?? REATTRIBUTION_HISTORY_START;
  const toDate = formatDateCol(job.to_date);
  let cursorDayStart: Date | null = job.cursor_day_start ? new Date(job.cursor_day_start) : null;
  let processedDays = Number(job.processed_days);
  let updatedDays = Number(job.updated_days);
  const attemptCount = Number(job.attempt_count);

  logEvent('info', 'tariff.reattribution.site.started', {
    trigger: params.trigger,
    fromDate,
    toDate,
    totalDays: Number(job.total_days),
    attemptCount,
  });

  const timelineRepo = new TariffTimelineRepo();
  const store = new CompactHistoryStore(pool, 15_000);

  try {
    const siteRes = await pool.query<{ timezone: string }>(
      'SELECT timezone FROM "Site" WHERE id = $1',
      [params.siteId]
    );
    const timezone = siteRes.rows[0]?.timezone || 'UTC';
    let outcome: 'idle' | 'partial' | 'busy' = 'idle';

    while (maxTimeMs - (clock() - startedAt) > 0) {
      const scanStart = clock();
      const scanRes = await pool.query<ArchiveMetadataScanRow>(
        `SELECT day_start, day_end, format_version, metadata_version, attribution_complete, attribution
         FROM "EnergyDayArchive"
         WHERE site_id = $1
           AND ${HAS_SAMPLES_SQL()}
           AND (day_start AT TIME ZONE $2)::date >= $3::date
           AND ($4::date IS NULL OR (day_start AT TIME ZONE $2)::date <= $4::date)
           AND ($5::timestamptz IS NULL OR day_start < $5::timestamptz)
         ORDER BY day_start DESC
         LIMIT $6`,
        [params.siteId, timezone, fromDate, toDate, cursorDayStart, chunkDays]
      );
      const scannedRows = scanRes.rows;

      if (scannedRows.length === 0) {
        const finalizeRes = await pool.query(
          `UPDATE "SiteTariffReattribution"
           SET status = 'idle', cursor_day_start = NULL, updated_at = now()
           WHERE site_id = $1 AND generation = $2`,
          [params.siteId, expectedGeneration]
        );
        if ((finalizeRes.rowCount ?? 0) === 0) {
          logEvent('info', 'tariff.reattribution.superseded', { generation: expectedGeneration });
          outcome = 'partial';
        } else {
          outcome = 'idle';
        }
        break;
      }

      const candidates: Array<{ dayStart: Date; dayEnd: Date; tariffs: Tariff[] }> = [];
      const tariffCache = new Map<string, Tariff[]>();

      for (const row of scannedRows) {
        const dayStart = new Date(row.day_start);
        const dayEnd = new Date(row.day_end);
        const localDate = siteLocalDateString(dayStart, timezone);
        let tariffs = tariffCache.get(localDate);
        if (!tariffs) {
          const resolved = await timelineRepo.resolveTariffForDate(pool, params.siteId, localDate);
          tariffs = resolved.tariffs;
          tariffCache.set(localDate, tariffs);
        }
        if (tariffs.length === 0) continue;

        const nextAttribution = deriveDayAttribution(
          new Schedule(tariffs, timezone),
          Number(tariffs[0].id),
          dayStart,
          dayEnd
        );
        const expectedComplete = isAttributionComplete(nextAttribution);
        const matches = row.format_version === 2
          && row.metadata_version === 3
          && segmentsEqual(row.attribution?.segments, nextAttribution.segments)
          && row.attribution_complete === expectedComplete;
        if (!matches) {
          candidates.push({ dayStart, dayEnd, tariffs });
        }
      }
      const scanMs = Math.max(0, clock() - scanStart);
      const skippedDays = scannedRows.length - candidates.length;

      const oldestInChunk = new Date(scannedRows[scannedRows.length - 1].day_start);
      const nextProcessed = processedDays + scannedRows.length;
      const doneThisChunk = scannedRows.length < chunkDays;
      const remainingAfterScan = maxTimeMs - (clock() - startedAt);
      const willStopOnBudget = !doneThisChunk && remainingAfterScan <= 0;
      const nextStatus = doneThisChunk ? 'idle' : (willStopOnBudget ? 'pending' : 'running');
      const nextCursor = doneThisChunk ? null : oldestInChunk;

      const rewriteStart = clock();
      const applyCheckpoint = async (client: PoolClient, rewritten: number): Promise<boolean> => {
        const res = await client.query(
          `UPDATE "SiteTariffReattribution"
           SET processed_days = $3,
               updated_days = $4,
               cursor_day_start = $5,
               status = $6,
               updated_at = now()
           WHERE site_id = $1 AND generation = $2`,
          [
            params.siteId,
            expectedGeneration,
            nextProcessed,
            updatedDays + rewritten,
            nextCursor,
            nextStatus,
          ]
        );
        return (res.rowCount ?? 0) === 1;
      };

      const chunkRes = await store.reattributeArchiveChunk({
        siteId: params.siteId,
        timezone,
        candidates,
        checkpoint: async (client) => applyCheckpoint(client, candidates.length),
      });
      const rewriteMs = Math.max(0, clock() - rewriteStart);

      if (chunkRes.status === 'busy') {
        await pool.query(
          `UPDATE "SiteTariffReattribution"
           SET status = 'pending', updated_at = now()
           WHERE site_id = $1 AND generation = $2`,
          [params.siteId, expectedGeneration]
        );
        logEvent('info', 'tariff.reattribution.chunk', {
          chunkDays: scannedRows.length,
          skippedDays,
          rewrittenDays: 0,
          scanMs,
          rewriteMs,
          remainingMs: Math.max(0, maxTimeMs - (clock() - startedAt)),
          claimBusy: true,
        });
        flushLogEvents();
        outcome = 'busy';
        break;
      }

      if (chunkRes.status === 'superseded') {
        logEvent('info', 'tariff.reattribution.superseded', { generation: expectedGeneration });
        flushLogEvents();
        outcome = 'partial';
        break;
      }

      processedDays = nextProcessed;
      updatedDays += chunkRes.rewrittenDays;
      cursorDayStart = nextCursor;

      const remainingMs = Math.max(0, maxTimeMs - (clock() - startedAt));
      const stoppedReason = doneThisChunk ? undefined : (remainingMs <= 0 ? 'time-budget' : undefined);
      logEvent('info', 'tariff.reattribution.chunk', {
        chunkDays: scannedRows.length,
        skippedDays,
        rewrittenDays: chunkRes.rewrittenDays,
        scanMs,
        rewriteMs,
        remainingMs,
        claimBusy: false,
        ...(stoppedReason ? { stoppedReason } : {}),
      });
      flushLogEvents();

      if (doneThisChunk) {
        outcome = 'idle';
        break;
      }
      if (remainingMs <= 0) {
        if (nextStatus !== 'pending') {
          await pool.query(
            `UPDATE "SiteTariffReattribution"
             SET status = 'pending', updated_at = now()
             WHERE site_id = $1 AND generation = $2`,
            [params.siteId, expectedGeneration]
          );
        }
        outcome = 'partial';
        break;
      }
    }

    logEvent('info', 'tariff.reattribution.site.completed', {
      trigger: params.trigger,
      outcome,
      processedDays,
      updatedDays,
      durationMs: Math.max(0, clock() - startedAt),
      attemptCount,
    });
    flushLogEvents();
    return { outcome, processedDays, updatedDays };
  } catch (error) {
    const nextAttempt = attemptCount + 1;
    const nextStatus = nextAttempt >= REATTRIBUTION_MAX_ATTEMPTS ? 'failed' : 'pending';
    const token = sanitizedErrorToken(error);
    await pool.query(
      `UPDATE "SiteTariffReattribution"
       SET status = $4, attempt_count = $3, last_error = $5, updated_at = now()
       WHERE site_id = $1 AND generation = $2`,
      [params.siteId, expectedGeneration, nextAttempt, nextStatus, token]
    ).catch(() => undefined);

    if (nextAttempt >= REATTRIBUTION_MAX_ATTEMPTS) {
      logEvent('error', 'tariff.reattribution.site.failed', {
        trigger: params.trigger,
        attemptCount: nextAttempt,
        ...errorFields(error),
      });
    }
    logEvent('info', 'tariff.reattribution.site.completed', {
      trigger: params.trigger,
      outcome: 'failed',
      processedDays,
      updatedDays,
      durationMs: Math.max(0, clock() - startedAt),
      attemptCount: nextAttempt,
      error: errorFields(error),
    });
    flushLogEvents();
    return { outcome: 'failed', processedDays, updatedDays };
  }
}

export async function runPendingReattributionsCron(options: {
  maxTimeMs?: number;
  chunkDays?: number;
  clock?: () => number;
} = {}): Promise<{
  checked: number;
  stopped?: 'time-budget';
  sites: Array<{ siteId: string; outcome: string; processedDays: number; updatedDays: number }>;
}> {
  const clock = options.clock ?? Date.now;
  const maxTimeMs = options.maxTimeMs ?? REATTRIBUTION_MAX_TIME_MS;
  const startedAt = clock();

  const dueRes = await pool.query<{ site_id: string }>(
    `SELECT site_id FROM "SiteTariffReattribution"
     WHERE status = 'pending'
        OR (status = 'running' AND updated_at < now() - interval '2 minutes')
     ORDER BY updated_at ASC`
  );

  const sites: Array<{ siteId: string; outcome: string; processedDays: number; updatedDays: number }> = [];
  let stopped: 'time-budget' | undefined;

  for (const row of dueRes.rows) {
    const remaining = maxTimeMs - (clock() - startedAt);
    if (remaining <= 0) {
      stopped = 'time-budget';
      break;
    }
    const res = await runSiteReattribution({
      siteId: row.site_id,
      trigger: 'cron',
      maxTimeMs: remaining,
      chunkDays: options.chunkDays,
      clock,
    });
    sites.push({ siteId: row.site_id, ...res });
    flushLogEvents();
  }

  return {
    checked: dueRes.rows.length,
    ...(stopped ? { stopped } : {}),
    sites,
  };
}
