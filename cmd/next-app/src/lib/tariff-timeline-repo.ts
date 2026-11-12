import type { PoolClient } from 'pg';
import { pool } from './db';
import type {
  SiteTariffReattributionRow,
  Tariff,
  TariffSchedule,
  TariffSeason,
  TariffSource,
} from './db-types';
import { tariffContentHash, type ParsedTariff } from './importer/tariff-parser';
import { accountFingerprint, logEvent } from './observability';
import { observedHolidayDates } from './holidays';
import { SiteRepo } from './site-repo';
import { enqueueReattributionOnClient, logReattributionEnqueued, type EnqueuedReattribution, type EnqueueReattributionParams } from './tariff-reattribution-queue';
import type {
  ReattributionStatusDTO,
  SiteTariffsTimelineResponse,
  TariffPeriodDTO,
  TariffSeasonInput,
} from './tariff-contract';
import {
  addCalendarDays,
  compileSeasonsToParsedTariff,
  computeSpanMutations,
  decompileTariffToSeasons,
  MAX_EFFECTIVE_PERIODS_PER_SITE,
  siteLocalDateString,
  TariffValidationError,
  validateEffectiveDates,
  validateTariffPlanInput,
  type ExistingSpan,
  type NewSpanRow,
  type SpanMutationPlan,
  type TariffPlanWriteInput,
} from './tariff-timeline';

export class TariffNotFoundError extends Error {
  readonly status = 404;
}

interface PeriodQueryRow {
  period_id: number;
  tariff_id: number;
  effective_from: string;
  effective_to: string | null;
  source: TariffSource;
  updated_by_user_id: string | null;
  updated_by_email: string | null;
  name: string | null;
  version: number;
  content_hash: string | null;
}

function toReattributionDTO(row: SiteTariffReattributionRow | undefined): ReattributionStatusDTO | null {
  if (!row || row.status === 'idle') return null;
  return {
    status: row.status,
    fromDate: typeof row.from_date === 'string' ? row.from_date.slice(0, 10) : String(row.from_date).slice(0, 10),
    toDate: row.to_date ? (typeof row.to_date === 'string' ? row.to_date.slice(0, 10) : String(row.to_date).slice(0, 10)) : null,
    totalDays: Number(row.total_days),
    processedDays: Number(row.processed_days),
    updatedDays: Number(row.updated_days),
    lastError: row.last_error,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : new Date(row.updated_at).toISOString(),
  };
}

export async function insertTariffGraph(
  client: PoolClient,
  siteId: string,
  parsed: ParsedTariff,
  source: TariffSource,
  createdByUserId: string | null,
  isCurrent: boolean,
  contentHash = tariffContentHash(parsed)
): Promise<number> {
  const verRes = await client.query<{ next: number }>(
    'SELECT COALESCE(MAX(version), 0) + 1 AS next FROM "Tariff" WHERE site_id = $1',
    [siteId]
  );
  const tariffId = (await client.query<{ id: number }>(
    `INSERT INTO "Tariff"(site_id, name, version, is_current, content_hash, source, created_by_user_id, updated)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW()) RETURNING id`,
    [siteId, parsed.name, verRes.rows[0].next, isCurrent, contentHash, source, createdByUserId]
  )).rows[0].id;

  for (const season of parsed.seasons) {
    const seasonId = (await client.query<{ id: number }>(
      `INSERT INTO "TariffSeason"(tariff_id, name, from_month, from_day, to_month, to_day, buy_rate, sell_rate)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [tariffId, season.name, season.from_month, season.from_day, season.to_month, season.to_day, season.buy_rate, season.sell_rate]
    )).rows[0].id;
    for (const sch of season.schedules) {
      await client.query(
        `INSERT INTO "TariffSchedule"(season_id, name, buy_rate, sell_rate, from_day_of_week, to_day_of_week, from_hour, from_minute, to_hour, to_minute)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [seasonId, sch.name, sch.buy_rate, sch.sell_rate, sch.from_day_of_week, sch.to_day_of_week, sch.from_hour, sch.from_minute, sch.to_hour, sch.to_minute]
      );
    }
  }
  return tariffId;
}

export async function loadExistingSpans(client: PoolClient, siteId: string): Promise<ExistingSpan[]> {
  const res = await client.query<{
    id: number;
    tariff_id: number;
    source: TariffSource;
    effective_from: string;
    effective_to: string | null;
    updated_by_user_id: string | null;
  }>(
    `SELECT id, tariff_id, source, effective_from::text, effective_to::text, updated_by_user_id
     FROM "TariffEffectivePeriod"
     WHERE site_id = $1
     ORDER BY effective_from ASC, id ASC`,
    [siteId]
  );
  return res.rows.map(r => ({
    id: Number(r.id),
    tariffId: Number(r.tariff_id),
    source: r.source,
    effectiveFrom: r.effective_from.slice(0, 10),
    effectiveTo: r.effective_to ? r.effective_to.slice(0, 10) : null,
    updatedByUserId: r.updated_by_user_id,
  }));
}

export async function applySpanMutationPlan(
  client: PoolClient,
  siteId: string,
  plan: SpanMutationPlan
): Promise<Array<{ id: number; source: TariffSource }>> {
  if (plan.deleteIds.length > 0) {
    await client.query(
      'DELETE FROM "TariffEffectivePeriod" WHERE site_id = $1 AND id = ANY($2::int[])',
      [siteId, plan.deleteIds]
    );
  }
  const inserted: Array<{ id: number; source: TariffSource }> = [];
  for (const row of plan.inserts) {
    const res = await client.query<{ id: number }>(
      `INSERT INTO "TariffEffectivePeriod"(site_id, tariff_id, effective_from, effective_to, source, updated_by_user_id)
       VALUES ($1, $2, $3::date, $4::date, $5, $6) RETURNING id`,
      [siteId, row.tariffId, row.effectiveFrom, row.effectiveTo, row.source, row.updatedByUserId]
    );
    inserted.push({ id: Number(res.rows[0]?.id ?? 0), source: row.source });
  }
  return inserted;
}

export async function recomputeIsCurrentTariff(
  client: PoolClient,
  siteId: string,
  todaySiteLocal: string
): Promise<number | null> {
  const active = await client.query<{ tariff_id: number }>(
    `SELECT tariff_id FROM "TariffEffectivePeriod"
     WHERE site_id = $1 AND effective_from <= $2::date AND (effective_to IS NULL OR effective_to >= $2::date)
     ORDER BY effective_from DESC LIMIT 1`,
    [siteId, todaySiteLocal]
  );
  // In a gap, price from the nearest earlier plan, and before the first plan from the earliest:
  // the same policy as resolveTariffForDate. Never a plan that has not started.
  const fallback = active.rows[0]?.tariff_id
    ?? (await client.query<{ tariff_id: number }>(
      `SELECT tariff_id FROM "TariffEffectivePeriod"
       WHERE site_id = $1 AND effective_to IS NOT NULL AND effective_to < $2::date
       ORDER BY effective_to DESC LIMIT 1`,
      [siteId, todaySiteLocal]
    )).rows[0]?.tariff_id
    ?? (await client.query<{ tariff_id: number }>(
      'SELECT tariff_id FROM "TariffEffectivePeriod" WHERE site_id = $1 ORDER BY effective_from ASC LIMIT 1',
      [siteId]
    )).rows[0]?.tariff_id
    ?? null;
  if (fallback === null) {
    // No period left (the last plan was deleted): nothing may stay current, or reads and archive
    // writes would keep pricing from a plan that is gone from the history. The tariff rows stay.
    await client.query('UPDATE "Tariff" SET is_current = FALSE WHERE site_id = $1 AND is_current = TRUE', [siteId]);
    return null;
  }
  // Demote before promoting so non-deferrable partial unique index tariff_current_uidx never trips on scan order.
  await client.query(
    'UPDATE "Tariff" SET is_current = FALSE WHERE site_id = $1 AND is_current = TRUE AND id <> $2',
    [siteId, fallback]
  );
  await client.query(
    'UPDATE "Tariff" SET is_current = TRUE WHERE id = $1 AND is_current = FALSE',
    [fallback]
  );
  return Number(fallback);
}

function toIsoOrNull(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function maxEnd(a: string | null, b: string | null): string | null {
  if (a === null || b === null) return null;
  return a >= b ? a : b;
}

function minDate(a: string, b: string): string {
  return a <= b ? a : b;
}

async function healVacatedIntervalWithTesla(
  client: PoolClient,
  siteId: string,
  vacatedFrom: string,
  vacatedTo: string | null
): Promise<void> {
  const spans = await loadExistingSpans(client, siteId);
  const left = spans.find(s => s.effectiveTo === addCalendarDays(vacatedFrom, -1));
  const right = vacatedTo !== null ? spans.find(s => s.effectiveFrom === addCalendarDays(vacatedTo, 1)) : undefined;

  if (left?.source === 'tesla' && right?.source === 'tesla' && left.tariffId === right.tariffId) {
    await applySpanMutationPlan(client, siteId, {
      deleteIds: [left.id, right.id],
      inserts: [{
        tariffId: left.tariffId,
        source: 'tesla',
        effectiveFrom: left.effectiveFrom,
        effectiveTo: right.effectiveTo,
        updatedByUserId: left.updatedByUserId,
      }],
    });
    return;
  }
  if (left?.source === 'tesla') {
    await applySpanMutationPlan(client, siteId, {
      deleteIds: [left.id],
      inserts: [{
        tariffId: left.tariffId,
        source: 'tesla',
        effectiveFrom: left.effectiveFrom,
        effectiveTo: vacatedTo,
        updatedByUserId: left.updatedByUserId,
      }],
    });
    return;
  }
  if (right?.source === 'tesla') {
    await applySpanMutationPlan(client, siteId, {
      deleteIds: [right.id],
      inserts: [{
        tariffId: right.tariffId,
        source: 'tesla',
        effectiveFrom: vacatedFrom,
        effectiveTo: right.effectiveTo,
        updatedByUserId: right.updatedByUserId,
      }],
    });
  }
}

/** Rate plan names are unique per site (ignoring case and edge spaces) so they never get confused. */
async function assertPlanNameAvailable(
  client: PoolClient,
  siteId: string,
  name: string,
  exceptTariffId: number | null
): Promise<void> {
  const clash = await client.query(
    `SELECT 1 FROM "TariffEffectivePeriod" p JOIN "Tariff" t ON t.id = p.tariff_id
     WHERE p.site_id = $1 AND lower(btrim(t.name)) = lower(btrim($2))
       AND ($3::int IS NULL OR t.id <> $3)
     LIMIT 1`,
    [siteId, name, exceptTariffId]
  );
  if ((clash.rowCount ?? 0) > 0) {
    throw new TariffValidationError(`A rate plan named "${name.trim()}" already exists. Choose a different name.`);
  }
}

async function hydrateTariffs(
  queryable: { query: PoolClient['query'] },
  tariffIds: number[]
): Promise<Map<number, Tariff>> {
  const map = new Map<number, Tariff>();
  if (tariffIds.length === 0) return map;

  const tariffsRes = await queryable.query<Tariff>(
    'SELECT id, site_id, updated, name, version, is_current, content_hash, source, created_by_user_id FROM "Tariff" WHERE id = ANY($1::int[])',
    [tariffIds]
  );
  const seasonsRes = await queryable.query<TariffSeason>(
    'SELECT id, tariff_id, name, from_month, from_day, to_month, to_day, buy_rate, sell_rate FROM "TariffSeason" WHERE tariff_id = ANY($1::int[]) ORDER BY id ASC',
    [tariffIds]
  );
  const seasonIds = seasonsRes.rows.map(s => Number(s.id));
  const schedulesRes = seasonIds.length > 0
    ? await queryable.query<TariffSchedule>(
      `SELECT ts.id, ts.season_id, ts.name,
              COALESCE(ts.buy_rate, s.buy_rate) AS buy_rate,
              COALESCE(ts.sell_rate, s.sell_rate) AS sell_rate,
              ts.from_day_of_week, ts.from_hour, ts.from_minute,
              ts.to_day_of_week, ts.to_hour, ts.to_minute
       FROM "TariffSchedule" ts
       JOIN "TariffSeason" s ON ts.season_id = s.id
       WHERE ts.season_id = ANY($1::int[])
       ORDER BY ts.id ASC`,
      [seasonIds]
    )
    : { rows: [] as TariffSchedule[] };

  const schedulesBySeason = new Map<number, TariffSchedule[]>();
  for (const row of schedulesRes.rows) {
    const sid = Number(row.season_id);
    const list = schedulesBySeason.get(sid) ?? [];
    list.push({
      id: Number(row.id),
      season_id: sid,
      name: row.name,
      buy_rate: row.buy_rate === null ? null : Number(row.buy_rate),
      sell_rate: row.sell_rate === null ? null : Number(row.sell_rate),
      from_day_of_week: row.from_day_of_week === null ? null : Number(row.from_day_of_week),
      from_hour: row.from_hour === null ? null : Number(row.from_hour),
      from_minute: row.from_minute === null ? null : Number(row.from_minute),
      to_day_of_week: row.to_day_of_week === null ? null : Number(row.to_day_of_week),
      to_hour: row.to_hour === null ? null : Number(row.to_hour),
      to_minute: row.to_minute === null ? null : Number(row.to_minute),
    });
    schedulesBySeason.set(sid, list);
  }

  const seasonsByTariff = new Map<number, TariffSeason[]>();
  for (const row of seasonsRes.rows) {
    const tid = Number(row.tariff_id);
    const sid = Number(row.id);
    const list = seasonsByTariff.get(tid) ?? [];
    list.push({
      id: sid,
      tariff_id: tid,
      name: row.name,
      from_month: Number(row.from_month),
      from_day: Number(row.from_day),
      to_month: Number(row.to_month),
      to_day: Number(row.to_day),
      buy_rate: Number(row.buy_rate),
      sell_rate: Number(row.sell_rate),
      schedules: schedulesBySeason.get(sid) ?? [],
    });
    seasonsByTariff.set(tid, list);
  }

  for (const row of tariffsRes.rows) {
    const tid = Number(row.id);
    map.set(tid, {
      ...row,
      id: tid,
      version: row.version === undefined ? undefined : Number(row.version),
      seasons: seasonsByTariff.get(tid) ?? [],
    });
  }
  return map;
}

export class TariffTimelineRepo {
  async getTimeline(siteId: string, viewerUserId: string | null): Promise<SiteTariffsTimelineResponse> {
    const siteRes = await pool.query<{ id: string; timezone: string; currency: string | null }>(
      `SELECT id, timezone, COALESCE(json -> 'tariff_content_v2' ->> 'currency', json ->> 'currency', 'USD') AS currency
       FROM "Site" WHERE id = $1`,
      [siteId]
    );
    const siteRow = siteRes.rows[0];
    if (!siteRow) throw new TariffNotFoundError('Site not found');
    const timezone = siteRow.timezone || 'UTC';
    const currency = siteRow.currency || 'USD';
    const today = siteLocalDateString(new Date(), timezone);

    const periodsRes = await pool.query<PeriodQueryRow>(
      `SELECT p.id AS period_id, p.tariff_id, p.effective_from::text, p.effective_to::text,
              p.source, p.updated_by_user_id, u.email AS updated_by_email,
              t.name, t.version, t.content_hash
       FROM "TariffEffectivePeriod" p
       JOIN "Tariff" t ON t.id = p.tariff_id
       LEFT JOIN "User" u ON u.id = p.updated_by_user_id
       WHERE p.site_id = $1
       ORDER BY p.effective_from DESC, p.id DESC`,
      [siteId]
    );

    const tariffIds = [...new Set(periodsRes.rows.map(r => Number(r.tariff_id)))];
    const tariffMap = await hydrateTariffs(pool, tariffIds);

    const periods: TariffPeriodDTO[] = periodsRes.rows.map(r => {
      const effectiveFrom = r.effective_from.slice(0, 10);
      const effectiveTo = r.effective_to ? r.effective_to.slice(0, 10) : null;
      const tariff = tariffMap.get(Number(r.tariff_id));
      const isCurrentToday = effectiveFrom <= today && (effectiveTo === null || effectiveTo >= today);
      return {
        periodId: Number(r.period_id),
        tariffId: Number(r.tariff_id),
        name: r.name || 'Rate Plan',
        version: Number(r.version ?? 1),
        source: r.source,
        effectiveFrom,
        effectiveTo,
        isCurrentToday,
        updatedBy: r.updated_by_user_id
          ? {
              email: r.updated_by_email ?? null,
              isCurrentUser: viewerUserId !== null && r.updated_by_user_id === viewerUserId,
            }
          : null,
        seasons: tariff ? decompileTariffToSeasons(tariff) : [],
      };
    });

    const latestTeslaRes = await pool.query<{
      id: number;
      name: string | null;
      updated: Date;
      content_hash: string | null;
    }>(
      `SELECT id, name, updated, content_hash
       FROM "Tariff"
       WHERE site_id = $1 AND source = 'tesla'
       ORDER BY id DESC LIMIT 1`,
      [siteId]
    );
    const latestTesla = latestTeslaRes.rows[0];
    const activeManualRow = periodsRes.rows.find(r => {
      const from = r.effective_from.slice(0, 10);
      const to = r.effective_to ? r.effective_to.slice(0, 10) : null;
      return r.source === 'manual' && from <= today && (to === null || to >= today);
    });
    const differsFromActiveManual = Boolean(
      activeManualRow && latestTesla && latestTesla.content_hash !== activeManualRow.content_hash
    );

    const reattrRes = await pool.query<SiteTariffReattributionRow>(
      'SELECT * FROM "SiteTariffReattribution" WHERE site_id = $1',
      [siteId]
    );

    return {
      version: 2,
      siteId,
      timezone,
      currency,
      periods,
      reattribution: toReattributionDTO(reattrRes.rows[0]),
      holidayDates: [Number(today.slice(0, 4)), Number(today.slice(0, 4)) + 1].flatMap(y => observedHolidayDates(y)),
      teslaSync: {
        latestTariffId: latestTesla ? Number(latestTesla.id) : null,
        latestTariffName: latestTesla?.name ?? null,
        latestUpdatedAt: toIsoOrNull(latestTesla?.updated),
        activeManualUpdatedAt: toIsoOrNull(activeManualRow ? tariffMap.get(Number(activeManualRow.tariff_id))?.updated : null),
        differsFromActiveManual,
      },
    };
  }

  async createManualPeriod(
    siteId: string,
    userId: string,
    input: TariffPlanWriteInput
  ): Promise<SiteTariffsTimelineResponse> {
    const client = await pool.connect();
    let createdPeriodId = 0;
    let newTariffId = 0;
    let validated: TariffPlanWriteInput;
    let reattribution: EnqueueReattributionParams;
    let queued: EnqueuedReattribution;
    try {
      await client.query('BEGIN');
      const siteRes = await client.query<{ timezone: string }>(
        'SELECT timezone FROM "Site" WHERE id = $1 FOR UPDATE',
        [siteId]
      );
      if (!siteRes.rows[0]) throw new TariffNotFoundError('Site not found');
      const today = siteLocalDateString(new Date(), siteRes.rows[0].timezone || 'UTC');
      validated = validateTariffPlanInput(input, today);
      await assertPlanNameAvailable(client, siteId, validated.name, null);

      const parsed = compileSeasonsToParsedTariff(validated.name, validated.seasons);
      newTariffId = await insertTariffGraph(client, siteId, parsed, 'manual', userId, false);

      const existing = await loadExistingSpans(client, siteId);
      const incoming: NewSpanRow = {
        tariffId: newTariffId,
        source: 'manual',
        effectiveFrom: validated.effectiveFrom,
        effectiveTo: validated.effectiveTo,
        updatedByUserId: userId,
      };
      const plan = computeSpanMutations(existing, incoming);
      const resultingCount = existing.length - plan.deleteIds.length + plan.inserts.length;
      if (resultingCount > MAX_EFFECTIVE_PERIODS_PER_SITE) {
        throw new TariffValidationError(`Cannot exceed ${MAX_EFFECTIVE_PERIODS_PER_SITE} effective periods per site`);
      }
      const inserted = await applySpanMutationPlan(client, siteId, plan);
      createdPeriodId = inserted.at(-1)?.id ?? 0;
      await recomputeIsCurrentTariff(client, siteId, today);
      reattribution = {
        siteId, fromDate: validated.effectiveFrom, toDate: validated.effectiveTo, requestedByUserId: userId, trigger: 'create',
      };
      queued = await enqueueReattributionOnClient(client, reattribution);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    new SiteRepo().invalidateCache(siteId);
    logReattributionEnqueued(reattribution, queued);
    logEvent('info', 'tariff.period.created', {
      periodId: createdPeriodId,
      tariffId: newTariffId,
      source: 'manual',
      effectiveFrom: validated.effectiveFrom,
      effectiveTo: validated.effectiveTo,
      seasonCount: validated.seasons.length,
      accountId: accountFingerprint(userId),
    });
    return this.getTimeline(siteId, userId);
  }

  async updatePeriod(
    siteId: string,
    periodId: number,
    userId: string,
    patch: Partial<TariffPlanWriteInput>
  ): Promise<{
    timeline: SiteTariffsTimelineResponse;
    affectedRange: { fromDate: string; toDate: string | null };
  }> {
    const client = await pool.connect();
    let oldFrom = '';
    let oldTo: string | null = null;
    let nextFrom = '';
    let nextTo: string | null = null;
    let reattribution: EnqueueReattributionParams;
    let queued: EnqueuedReattribution;
    let targetTariffId = 0;
    let source: TariffSource = 'manual';
    let seasonCount = 0;
    try {
      await client.query('BEGIN');
      const siteRes = await client.query<{ timezone: string }>(
        'SELECT timezone FROM "Site" WHERE id = $1 FOR UPDATE',
        [siteId]
      );
      if (!siteRes.rows[0]) throw new TariffNotFoundError('Site not found');
      const today = siteLocalDateString(new Date(), siteRes.rows[0].timezone || 'UTC');

      const existing = await loadExistingSpans(client, siteId);
      const target = existing.find(s => s.id === periodId);
      if (!target) throw new TariffNotFoundError('Rate plan period not found');

      oldFrom = target.effectiveFrom;
      oldTo = target.effectiveTo;
      source = target.source;
      nextFrom = patch.effectiveFrom ?? target.effectiveFrom;
      nextTo = patch.effectiveTo !== undefined ? patch.effectiveTo : target.effectiveTo;

      if (target.source === 'tesla') {
        if (patch.name !== undefined || patch.seasons !== undefined) {
          throw new TariffValidationError('Tesla-synced rate plans only allow adjusting effective dates');
        }
        validateEffectiveDates(nextFrom, nextTo, today);
        targetTariffId = target.tariffId;
      } else {
        const tariffMap = await hydrateTariffs(client, [target.tariffId]);
        const currentTariff = tariffMap.get(target.tariffId);
        if (!currentTariff) throw new TariffNotFoundError('Tariff not found');
        const currentSeasons: TariffSeasonInput[] = decompileTariffToSeasons(currentTariff);
        const validated = validateTariffPlanInput({
          name: patch.name ?? currentTariff.name ?? '',
          effectiveFrom: nextFrom,
          effectiveTo: nextTo,
          seasons: patch.seasons ?? currentSeasons,
        }, today);
        seasonCount = validated.seasons.length;
        if (validated.name.trim().toLowerCase() !== (currentTariff.name ?? '').trim().toLowerCase()) {
          await assertPlanNameAvailable(client, siteId, validated.name, target.tariffId);
        }
        const parsed = compileSeasonsToParsedTariff(validated.name, validated.seasons);
        const newHash = tariffContentHash(parsed);
        if (newHash !== currentTariff.content_hash || validated.name !== currentTariff.name) {
          targetTariffId = await insertTariffGraph(client, siteId, parsed, 'manual', userId, false, newHash);
        } else {
          targetTariffId = target.tariffId;
        }
      }

      const remaining = existing.filter(s => s.id !== periodId);
      const mutationPlan = computeSpanMutations(remaining, {
        tariffId: targetTariffId,
        source: target.source,
        effectiveFrom: nextFrom,
        effectiveTo: nextTo,
        updatedByUserId: userId,
      });
      const plan: SpanMutationPlan = {
        deleteIds: [periodId, ...mutationPlan.deleteIds],
        inserts: mutationPlan.inserts,
      };
      const resultingCount = existing.length - plan.deleteIds.length + plan.inserts.length;
      if (resultingCount > MAX_EFFECTIVE_PERIODS_PER_SITE) {
        throw new TariffValidationError(`Cannot exceed ${MAX_EFFECTIVE_PERIODS_PER_SITE} effective periods per site`);
      }
      await applySpanMutationPlan(client, siteId, plan);

      // If shrinking vacated dates adjacent to a 'tesla' span, heal/extend that tesla span cleanly.
      // Bound each vacated interval to the original period so dates it never covered
      // (already preserved as Tesla fragments) are not re-extended into an overlap.
      // Only manual edits heal: for a Tesla edit the replacement span would be found as its own
      // Tesla neighbour and restore the dates the user just changed.
      if (source === 'manual' && oldFrom < nextFrom) {
        const dayBeforeNext = addCalendarDays(nextFrom, -1);
        const vacatedTo = oldTo !== null ? minDate(oldTo, dayBeforeNext) : dayBeforeNext;
        await healVacatedIntervalWithTesla(client, siteId, oldFrom, vacatedTo);
      }
      if (source === 'manual' && nextTo !== null && (oldTo === null || oldTo > nextTo)) {
        const dayAfterNext = addCalendarDays(nextTo, 1);
        const vacatedFrom = dayAfterNext > oldFrom ? dayAfterNext : oldFrom;
        await healVacatedIntervalWithTesla(client, siteId, vacatedFrom, oldTo);
      }

      await recomputeIsCurrentTariff(client, siteId, today);
      reattribution = {
        siteId,
        fromDate: minDate(oldFrom, nextFrom),
        toDate: maxEnd(oldTo, nextTo),
        requestedByUserId: userId,
        trigger: 'update',
      };
      queued = await enqueueReattributionOnClient(client, reattribution);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    new SiteRepo().invalidateCache(siteId);
    logReattributionEnqueued(reattribution, queued);
    logEvent('info', 'tariff.period.updated', {
      periodId,
      tariffId: targetTariffId,
      source,
      effectiveFrom: nextFrom,
      effectiveTo: nextTo,
      seasonCount,
      accountId: accountFingerprint(userId),
    });
    const timeline = await this.getTimeline(siteId, userId);
    return {
      timeline,
      affectedRange: {
        fromDate: minDate(oldFrom, nextFrom),
        toDate: maxEnd(oldTo, nextTo),
      },
    };
  }

  async deleteManualPeriod(
    siteId: string,
    periodId: number,
    userId: string
  ): Promise<{
    timeline: SiteTariffsTimelineResponse;
    removedRange: { fromDate: string; toDate: string | null };
  }> {
    const client = await pool.connect();
    let removedFrom = '';
    let removedTo: string | null = null;
    let tariffId = 0;
    let reattribution: EnqueueReattributionParams;
    let queued: EnqueuedReattribution;
    try {
      await client.query('BEGIN');
      const siteRes = await client.query<{ timezone: string }>(
        'SELECT timezone FROM "Site" WHERE id = $1 FOR UPDATE',
        [siteId]
      );
      if (!siteRes.rows[0]) throw new TariffNotFoundError('Site not found');
      const today = siteLocalDateString(new Date(), siteRes.rows[0].timezone || 'UTC');

      const existing = await loadExistingSpans(client, siteId);
      const target = existing.find(s => s.id === periodId);
      if (!target) throw new TariffNotFoundError('Rate plan period not found');
      if (target.source !== 'manual') {
        throw new TariffValidationError('Only custom rate plan periods can be deleted');
      }

      removedFrom = target.effectiveFrom;
      removedTo = target.effectiveTo;
      tariffId = target.tariffId;

      await client.query('DELETE FROM "TariffEffectivePeriod" WHERE site_id = $1 AND id = $2', [siteId, periodId]);
      await healVacatedIntervalWithTesla(client, siteId, removedFrom, removedTo);

      // Ensure today stays covered if a Tesla fallback tariff exists and today became uncovered.
      const afterHeal = await loadExistingSpans(client, siteId);
      const coversToday = afterHeal.some(s => s.effectiveFrom <= today && (s.effectiveTo === null || s.effectiveTo >= today));
      if (!coversToday) {
        const latestTesla = await client.query<{ id: number }>(
          `SELECT id FROM "Tariff" WHERE site_id = $1 AND source = 'tesla' ORDER BY id DESC LIMIT 1`,
          [siteId]
        );
        if (latestTesla.rows[0]) {
          const nextSpan = afterHeal.find(s => s.effectiveFrom > today);
          await applySpanMutationPlan(client, siteId, {
            deleteIds: [],
            inserts: [{
              tariffId: Number(latestTesla.rows[0].id),
              source: 'tesla',
              effectiveFrom: today,
              effectiveTo: nextSpan ? addCalendarDays(nextSpan.effectiveFrom, -1) : null,
              updatedByUserId: null,
            }],
          });
        }
      }

      await recomputeIsCurrentTariff(client, siteId, today);
      reattribution = {
        siteId, fromDate: removedFrom, toDate: removedTo, requestedByUserId: userId, trigger: 'delete',
      };
      queued = await enqueueReattributionOnClient(client, reattribution);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    new SiteRepo().invalidateCache(siteId);
    logReattributionEnqueued(reattribution, queued);
    logEvent('info', 'tariff.period.deleted', {
      periodId,
      tariffId,
      source: 'manual',
      effectiveFrom: removedFrom,
      effectiveTo: removedTo,
      accountId: accountFingerprint(userId),
    });
    const timeline = await this.getTimeline(siteId, userId);
    return {
      timeline,
      removedRange: { fromDate: removedFrom, toDate: removedTo },
    };
  }

  async resolveTariffForDate(
    client: Pick<PoolClient, 'query'>,
    siteId: string,
    siteLocalDate: string
  ): Promise<{ tariffs: Tariff[]; schedules: TariffSchedule[] }> {
    const exact = await client.query<{ tariff_id: number }>(
      `SELECT tariff_id FROM "TariffEffectivePeriod"
       WHERE site_id = $1 AND effective_from <= $2::date AND (effective_to IS NULL OR effective_to >= $2::date)
       ORDER BY effective_from DESC LIMIT 1`,
      [siteId, siteLocalDate]
    );
    let tariffId = exact.rows[0]?.tariff_id;
    if (tariffId === undefined) {
      const prior = await client.query<{ tariff_id: number }>(
        `SELECT tariff_id FROM "TariffEffectivePeriod"
         WHERE site_id = $1 AND effective_to IS NOT NULL AND effective_to < $2::date
         ORDER BY effective_to DESC LIMIT 1`,
        [siteId, siteLocalDate]
      );
      tariffId = prior.rows[0]?.tariff_id;
    }
    if (tariffId === undefined) {
      const earliest = await client.query<{ tariff_id: number }>(
        'SELECT tariff_id FROM "TariffEffectivePeriod" WHERE site_id = $1 ORDER BY effective_from ASC LIMIT 1',
        [siteId]
      );
      tariffId = earliest.rows[0]?.tariff_id;
    }
    if (tariffId === undefined) {
      const current = await client.query<{ id: number }>(
        'SELECT id FROM "Tariff" WHERE site_id = $1 AND is_current = TRUE LIMIT 1',
        [siteId]
      );
      tariffId = current.rows[0]?.id;
    }
    if (tariffId === undefined) {
      return { tariffs: [], schedules: [] };
    }
    const map = await hydrateTariffs(client, [Number(tariffId)]);
    const tariff = map.get(Number(tariffId));
    if (!tariff) return { tariffs: [], schedules: [] };
    const schedules = tariff.seasons?.flatMap(s => s.schedules ?? []) ?? [];
    return { tariffs: [tariff], schedules };
  }
}
