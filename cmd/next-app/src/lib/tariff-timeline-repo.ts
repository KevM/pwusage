import { layoutTimeline } from './tariff-estimates';
import { estimateFreshness } from './urdb/match';
import type { PoolClient } from 'pg';
import { pool } from './db';
import type {
  SiteTariffReattributionRow,
  Tariff,
  TariffSchedule,
  TariffSeason,
  TariffSource,
} from './db-types';
import { buildDefaultTariff, tariffContentHash, type ParsedTariff } from './importer/tariff-parser';
import { accountFingerprint, logEvent } from './observability';
import { observedHolidayDates } from './holidays';
import { SiteRepo } from './site-repo';
import { fillWindowBounds, loadHistoryWindow, loadHistoryWindowInput, uncoveredPieces, type HistoryWindow } from './urdb/history-window';
import type { ExpandedRevision } from './urdb/history-expand';
import { enqueueReattributionOnClient, logReattributionEnqueued, type EnqueuedReattribution, type EnqueueReattributionParams } from './tariff-reattribution-queue';
import type {
  ReattributionStatusDTO,
  SiteBatteryDTO,
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
  MAX_PLAN_NAME_LENGTH,
  siteLocalDateString,
  TariffValidationError,
  validateEffectiveDates,
  validateTariffPlanInput,
  type ExistingSpan,
  type NewSpanRow,
  type SpanMutationPlan,
  type TariffPlanWriteInput,
} from './tariff-timeline';

export class UtilityChangedError extends Error {
  readonly status = 409;
}

export class TariffNotFoundError extends Error {
  readonly status = 404;
}

export interface PeriodQueryRow {
  period_id: number;
  tariff_id: number;
  effective_from: string;
  effective_to: string | null;
  source: TariffSource;
  updated_by_user_id: string | null;
  updated_by_email: string | null;
  start_source?: import('./db-types').TariffStartSource | null;
  owner_history?: boolean;
  anchor_start?: string | null;
  name: string | null;
  version: number;
  content_hash: string | null;
}

export interface LatestTeslaTariffSummary {
  id: number;
  name: string | null;
  updated: Date;
  content_hash: string | null;
}

export interface BuildSiteTariffsTimelineInput {
  siteId: string;
  timezone: string;
  currency: string;
  today: string;
  viewerUserId: string | null;
  periodRows: PeriodQueryRow[];
  referencePeriodRows?: PeriodQueryRow[];
  tariffMap: Map<number, Tariff>;
  battery?: SiteBatteryDTO | null;
  reattribution?: SiteTariffReattributionRow;
  latestTesla?: LatestTeslaTariffSummary;
}

/**
 * Same pick as `resolveTariffForDate`: the plan covering `date`, else (in a gap)
 * the nearest earlier plan by end date, else (before every plan) the earliest.
 */
export function pickActivePeriodForDate<
  T extends { effectiveFrom: string; effectiveTo: string | null; periodId: number }
>(periods: T[], date: string): T | undefined {
  return (
    periods.find(p => p.effectiveFrom <= date && (p.effectiveTo === null || p.effectiveTo >= date)) ??
    periods
      .filter(p => p.effectiveTo !== null && p.effectiveTo < date)
      .sort((a, b) => (b.effectiveTo as string).localeCompare(a.effectiveTo as string) || b.periodId - a.periodId)[0] ??
    [...periods].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom) || a.periodId - b.periodId)[0]
  );
}

function mapPeriodRowToDTO(
  r: PeriodQueryRow,
  viewerUserId: string | null,
  tariffMap: Map<number, Tariff>
): TariffPeriodDTO {
  const effectiveFrom = r.effective_from.slice(0, 10);
  const effectiveTo = r.effective_to ? r.effective_to.slice(0, 10) : null;
  const tariff = tariffMap.get(Number(r.tariff_id));
  return {
    periodId: Number(r.period_id),
    tariffId: Number(r.tariff_id),
    name: r.name || 'Rate Plan',
    version: Number(r.version ?? 1),
    source: r.source,
    startSource: r.source === 'estimated' || (r.source === 'manual' && r.owner_history) ? 'urdb' : r.source === 'tesla' && !r.updated_by_user_id && r.anchor_start?.slice(0, 10) === effectiveFrom ? r.start_source ?? null : null,
    effectiveFrom,
    effectiveTo,
    isCurrentToday: false,
    updatedBy: r.updated_by_user_id
      ? {
          email: r.updated_by_email ?? null,
          isCurrentUser: viewerUserId !== null && r.updated_by_user_id === viewerUserId,
        }
      : null,
    seasons: tariff ? decompileTariffToSeasons(tariff) : [],
  };
}

function parseSiteBattery(row: {
  nameplate_energy?: string | number | null;
  nameplate_power?: string | number | null;
  backup_reserve_percent?: string | number | null;
}): SiteBatteryDTO | null {
  const energy = Number(row.nameplate_energy);
  if (!Number.isFinite(energy) || energy <= 0) return null;
  const power = Number(row.nameplate_power);
  const reserve = Number(row.backup_reserve_percent);
  return {
    nameplateEnergyWh: energy,
    nameplatePowerW: Number.isFinite(power) && power > 0 ? power : 0,
    backupReservePercent: Number.isFinite(reserve) ? reserve : 0,
  };
}

/**
 * Pure DTO mapping from `TariffEffectivePeriod` + `Tariff` rows to
 * `SiteTariffsTimelineResponse` v2. Shared by `TariffTimelineRepo.getTimeline`
 * and fixture generation.
 */
export function buildSiteTariffsTimelineResponse(
  input: BuildSiteTariffsTimelineInput
): SiteTariffsTimelineResponse {
  const {
    siteId,
    timezone,
    currency,
    today,
    viewerUserId,
    periodRows,
    referencePeriodRows = [],
    tariffMap,
    battery = null,
    reattribution,
    latestTesla,
  } = input;

  const periods: TariffPeriodDTO[] = periodRows.map(r => mapPeriodRowToDTO(r, viewerUserId, tariffMap));
  const referencePeriods: TariffPeriodDTO[] = referencePeriodRows
    .map(r => mapPeriodRowToDTO(r, viewerUserId, tariffMap))
    .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom) || a.periodId - b.periodId);

  const activeToday = pickActivePeriodForDate(periods, today);
  if (activeToday) activeToday.isCurrentToday = true;
  const activeRefToday = pickActivePeriodForDate(referencePeriods, today);
  if (activeRefToday) activeRefToday.isCurrentToday = true;

  const activeManualRow = periodRows.find(r => {
    const from = r.effective_from.slice(0, 10);
    const to = r.effective_to ? r.effective_to.slice(0, 10) : null;
    return r.source === 'manual' && from <= today && (to === null || to >= today);
  });
  const differsFromActiveManual = Boolean(
    activeManualRow && latestTesla && latestTesla.content_hash !== activeManualRow.content_hash
  );

  const currentYear = Number(today.slice(0, 4));
  const startYear = Math.min(
    currentYear,
    ...[...periods, ...referencePeriods].map(p => Number(p.effectiveFrom.slice(0, 4))).filter(Number.isFinite)
  );
  const endYear = currentYear + 1;
  const holidayYears: number[] = [];
  for (let y = startYear; y <= endYear; y++) {
    holidayYears.push(y);
  }

  return {
    version: 2,
    siteId,
    timezone,
    currency,
    periods,
    referencePeriods,
    estimates: null,
    battery,
    reattribution: toReattributionDTO(reattribution),
    holidayDates: holidayYears.flatMap(y => observedHolidayDates(y)),
    teslaSync: {
      latestTariffId: latestTesla ? Number(latestTesla.id) : null,
      latestTariffName: latestTesla?.name ?? null,
      latestUpdatedAt: toIsoOrNull(latestTesla?.updated),
      activeManualUpdatedAt: toIsoOrNull(activeManualRow ? tariffMap.get(Number(activeManualRow.tariff_id))?.updated : null),
      differsFromActiveManual,
    },
  };
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
    'SELECT COALESCE(MAX(version), 0) + 1 AS next FROM "Tariff" WHERE site_id = $1 AND name = $2',
    [siteId, parsed.name]
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

/**
 * Lays estimates into the days owner and Tesla spans leave uncovered. `reference` scope is for
 * reference plan edits: it leaves the actual timeline and `is_current` untouched.
 */
export async function applyEstimatesOnClient(
  client: PoolClient, siteId: string, today: string, scope: 'all' | 'reference' = 'all'
): Promise<{ changed: Array<{ from: string; to: string | null }> }> {
  const sources = await client.query<{ tariff_id: number; role: string; start_date: string; end_date: string | null }>(
    `SELECT tariff_id, role, start_date::text, end_date::text FROM "TariffUrdbSource" WHERE site_id = $1 ORDER BY created_at DESC, tariff_id DESC`, [siteId]
  );
  const referenceRows = await client.query<{ id: number; tariff_id: number; source: TariffSource; effective_from: string; effective_to: string | null; updated_by_user_id: string | null }>(
    `SELECT id, tariff_id, source, effective_from::text, effective_to::text, updated_by_user_id FROM "TariffReferencePeriod" WHERE site_id = $1 ORDER BY effective_from, id`, [siteId]
  );
  const reference: ExistingSpan[] = referenceRows.rows.map(row => ({ id: Number(row.id), tariffId: Number(row.tariff_id), source: row.source, effectiveFrom: row.effective_from, effectiveTo: row.effective_to, updatedByUserId: row.updated_by_user_id }));
  const desired = (role: string) => sources.rows.filter(row => row.role === role).map(row => ({ tariffId: Number(row.tariff_id), effectiveFrom: row.start_date, effectiveTo: row.end_date }));
  const anchors = sources.rows.filter(row => row.role === 'tesla_anchor').map(row => ({ tariffId: Number(row.tariff_id), startDate: row.start_date }));
  const referenceLayout = layoutTimeline(reference, [], desired('estimated_reference'));
  if (referenceLayout.deleteIds.length) await client.query('DELETE FROM "TariffReferencePeriod" WHERE site_id = $1 AND id = ANY($2::int[])', [siteId, referenceLayout.deleteIds]);
  for (const row of referenceLayout.inserts) {
    await client.query(`INSERT INTO "TariffReferencePeriod"(site_id, tariff_id, effective_from, effective_to, source, updated_by_user_id) VALUES ($1, $2, $3::date, $4::date, $5, $6)`, [siteId, row.tariffId, row.effectiveFrom, row.effectiveTo, row.source, row.updatedByUserId]);
  }
  if (scope === 'reference') return { changed: [] };
  const actualLayout = layoutTimeline(await loadExistingSpans(client, siteId), anchors, desired('estimated_actual'));
  await applySpanMutationPlan(client, siteId, actualLayout);
  await recomputeIsCurrentTariff(client, siteId, today);
  return { changed: actualLayout.changed };
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
async function planNameTaken(
  client: PoolClient,
  siteId: string,
  name: string,
  exceptTariffId: number | null
): Promise<boolean> {
  const clash = await client.query(
    `SELECT 1 FROM "TariffEffectivePeriod" p JOIN "Tariff" t ON t.id = p.tariff_id
     WHERE p.site_id = $1 AND p.source <> 'estimated' AND lower(btrim(t.name)) = lower(btrim($2))
       AND ($3::int IS NULL OR t.id <> $3)
     LIMIT 1`,
    [siteId, name, exceptTariffId]
  );
  return (clash.rowCount ?? 0) > 0;
}

async function assertPlanNameAvailable(
  client: PoolClient,
  siteId: string,
  name: string,
  exceptTariffId: number | null
): Promise<void> {
  if (await planNameTaken(client, siteId, name, exceptTariffId)) {
    throw new TariffValidationError(`A rate plan named "${name.trim()}" already exists. Choose a different name.`);
  }
}

/**
 * Revisions of one public plan share its name, so converting a second one (often a dates-only
 * edit with no name field) would clash with the first. Keep the name, adding the start year.
 */
export async function availableEstimateName(client: PoolClient, siteId: string, name: string, effectiveFrom: string): Promise<string> {
  const base = name.trim();
  // URDB names are already cut to the 64-character limit, so shorten the base to fit the suffix.
  const withSuffix = (suffix: string) => `${base.slice(0, MAX_PLAN_NAME_LENGTH - suffix.length).trimEnd()}${suffix}`;
  const candidates = [base, withSuffix(` (${effectiveFrom.slice(0, 4)})`), withSuffix(` (${effectiveFrom})`)];
  for (const candidate of candidates) {
    if (!(await planNameTaken(client, siteId, candidate, null))) return candidate;
  }
  for (let suffix = 2; ; suffix++) {
    const candidate = withSuffix(` (${effectiveFrom}, ${suffix})`);
    if (!(await planNameTaken(client, siteId, candidate, null))) return candidate;
  }
}

/** The owner's public plan pick for the current period; false when the utility changed or was skipped. */
async function setPlanLabelOnClient(client: PoolClient, siteId: string, userId: string, label: string, expectedUtility: string): Promise<boolean> {
  const updated = await client.query(`UPDATE "SiteUtility" SET urdb_plan_label = $2, status = 'pending', attempt_count = 0, next_check_at = NULL, updated_by_user_id = $3, updated_at = now() WHERE site_id = $1 AND urdb_utility = $4 AND choice <> 'skipped'`, [siteId, label, userId, expectedUtility]);
  return (updated.rowCount ?? 0) > 0;
}

export async function hydrateTariffs(
  queryable: { query: PoolClient['query'] },
  tariffIds: number[]
): Promise<Map<number, Tariff>> {
  const map = new Map<number, Tariff>();
  if (tariffIds.length === 0) return map;

  const tariffsRes = await queryable.query<Tariff>(
    'SELECT id, site_id, updated, name, version, is_current, content_hash, source, created_by_user_id, plan_name, plan_code FROM "Tariff" WHERE id = ANY($1::int[])',
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
  async getSiteUtilityContext(siteId: string): Promise<{ name: string | null; timezone: string } | null> {
    const result = await pool.query<{ name: string | null; timezone: string }>(`SELECT u.urdb_utility AS name, s.timezone FROM "Site" s LEFT JOIN "SiteUtility" u ON u.site_id = s.id WHERE s.id = $1`, [siteId]);
    return result.rows[0] ?? null;
  }

  /** The fill window (null when nothing is left to fill) and the newest real Tesla version, for the history guide. */
  async getRatePlanHistoryInputs(siteId: string, today: string): Promise<{ window: HistoryWindow | null; tesla: Tariff | null }> {
    const window = await loadHistoryWindow(pool, siteId, today);
    const fallbackHash = tariffContentHash(buildDefaultTariff('Default Rate'));
    const latest = (await pool.query<{ id: number }>(`SELECT id FROM "Tariff" WHERE site_id = $1 AND source = 'tesla' AND content_hash IS DISTINCT FROM $2 ORDER BY updated DESC, id DESC LIMIT 1`, [siteId, fallbackHash])).rows[0];
    const tesla = latest ? (await hydrateTariffs(pool, [Number(latest.id)])).get(Number(latest.id)) ?? null : null;
    return { window, tesla };
  }

  async getSiteUtility(siteId: string): Promise<string | null> {
    const result = await pool.query<{ urdb_utility: string | null }>('SELECT urdb_utility FROM "SiteUtility" WHERE site_id = $1', [siteId]);
    return result.rows[0]?.urdb_utility ?? null;
  }

  async setSiteUtility(siteId: string, userId: string, input: { name: string } | { skipped: true }): Promise<SiteTariffsTimelineResponse> {
    const client = await pool.connect();
    let reattribution: EnqueueReattributionParams | null = null;
    let queued: EnqueuedReattribution | null = null;
    try {
      await client.query('BEGIN');
      const site = await client.query('SELECT id FROM "Site" WHERE id = $1 FOR UPDATE', [siteId]);
      if (!site.rowCount) throw new TariffNotFoundError('Site not found');
      const skipped = 'skipped' in input;
      await client.query(`INSERT INTO "SiteUtility" (site_id, urdb_utility, choice, status, updated_by_user_id)
        VALUES ($1, $2, $3, 'pending', $4) ON CONFLICT (site_id) DO UPDATE SET urdb_utility = EXCLUDED.urdb_utility, choice = EXCLUDED.choice, urdb_plan_label = NULL, status = 'pending', attempt_count = 0, next_check_at = NULL, updated_by_user_id = EXCLUDED.updated_by_user_id, updated_at = now()`,
      [siteId, skipped ? null : input.name, skipped ? 'skipped' : 'owner', userId]);
      if (skipped) {
        // Removing estimates needs no OpenEI call, so do it now rather than on the next cron run.
        const timezone = (await client.query<{ timezone: string }>('SELECT timezone FROM "Site" WHERE id = $1', [siteId])).rows[0]?.timezone || 'UTC';
        // Only the estimate job's rows: the owner's own history (owner_history) stays with their plans.
        await client.query(`DELETE FROM "TariffUrdbSource" WHERE site_id = $1 AND role IN ('tesla_anchor', 'estimated_actual', 'estimated_reference')`, [siteId]);
        const { changed } = await applyEstimatesOnClient(client, siteId, siteLocalDateString(new Date(), timezone));
        if (changed.length) {
          reattribution = {
            siteId,
            fromDate: changed.reduce((min, range) => minDate(min, range.from), changed[0].from),
            toDate: changed.reduce<string | null>((max, range) => maxEnd(max, range.to), changed[0].to),
            requestedByUserId: userId,
            trigger: 'estimate',
          };
          queued = await enqueueReattributionOnClient(client, reattribution);
        }
        await client.query(`UPDATE "SiteUtility" SET status = 'ready', checked_at = now(), next_check_at = now() + interval '7 days', updated_at = clock_timestamp() WHERE site_id = $1`, [siteId]);
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    new SiteRepo().invalidateCache(siteId);
    if (reattribution && queued) logReattributionEnqueued(reattribution, queued);
    return this.getTimeline(siteId, userId);
  }

  async setSitePlanLabel(siteId: string, userId: string, label: string, expectedUtility: string): Promise<SiteTariffsTimelineResponse> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const site = await client.query('SELECT id FROM "Site" WHERE id = $1 FOR UPDATE', [siteId]);
      if (!site.rowCount) throw new TariffNotFoundError('Site not found');
      if (!(await setPlanLabelOnClient(client, siteId, userId, label, expectedUtility))) throw new UtilityChangedError('Utility changed. Choose a rate plan again.');
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    return this.getTimeline(siteId, userId);
  }

  /**
   * Saves the owner's answers from the rate plan history guide in one transaction: each public
   * rate revision becomes an owner (`manual`) plan, clipped to the fill window minus the owner's
   * own plans, and `openLabel` (only without Tesla versions) becomes the site's plan pick.
   */
  async saveRatePlanHistory(siteId: string, userId: string, expectedUtility: string, revisions: ExpandedRevision[], openLabel: string | null): Promise<SiteTariffsTimelineResponse> {
    const client = await pool.connect();
    let reattribution: EnqueueReattributionParams | null = null;
    let queued: EnqueuedReattribution | null = null;
    let savedCount = 0;
    try {
      await client.query('BEGIN');
      const siteRes = await client.query<{ timezone: string }>('SELECT timezone FROM "Site" WHERE id = $1 FOR UPDATE', [siteId]);
      if (!siteRes.rows[0]) throw new TariffNotFoundError('Site not found');
      const today = siteLocalDateString(new Date(), siteRes.rows[0].timezone || 'UTC');
      const utility = await client.query(`SELECT 1 FROM "SiteUtility" WHERE site_id = $1 AND urdb_utility = $2 AND choice <> 'skipped'`, [siteId, expectedUtility]);
      if (!utility.rowCount) throw new UtilityChangedError('Utility changed. Start again.');
      const input = await loadHistoryWindowInput(client, siteId, today);
      const bounds = input && fillWindowBounds(input);
      if (!input || !bounds) throw new TariffValidationError('Your rate plan history is already filled.');
      if (openLabel !== null && bounds.fillThrough !== null) throw new TariffValidationError('Your rate plans changed. Start again.');
      const windowEnd = bounds.fillThrough ?? today;
      const saved: Array<{ from: string; to: string }> = [];
      for (const revision of revisions) {
        const from = revision.from > bounds.historyStart ? revision.from : bounds.historyStart;
        const to = revision.to !== null && revision.to < windowEnd ? revision.to : windowEnd;
        if (from > to) continue;
        for (const piece of uncoveredPieces(from, to, input.manualSpans)) {
          const name = await availableEstimateName(client, siteId, revision.name, piece.from);
          const validated = validateTariffPlanInput({ name, effectiveFrom: piece.from, effectiveTo: piece.to, seasons: revision.seasons }, today);
          const tariffId = await insertTariffGraph(client, siteId, compileSeasonsToParsedTariff(validated.name, validated.seasons), 'manual', userId, false);
          await applySpanMutationPlan(client, siteId, computeSpanMutations(await loadExistingSpans(client, siteId), {
            tariffId, source: 'manual', effectiveFrom: piece.from, effectiveTo: piece.to, updatedByUserId: userId,
          }));
          await client.query(
            `INSERT INTO "TariffUrdbSource" (tariff_id, site_id, role, urdb_label, start_date, end_date, start_source, revision_start) VALUES ($1, $2, 'owner_history', $3, $4::date, $5::date, 'urdb', $6::date)`,
            [tariffId, siteId, revision.label, piece.from, piece.to, revision.revisionStart]
          );
          saved.push(piece);
        }
      }
      const kept = await client.query<{ count: number }>(`SELECT count(*)::int AS count FROM "TariffEffectivePeriod" WHERE site_id = $1 AND source <> 'estimated'`, [siteId]);
      if (Number(kept.rows[0]?.count ?? 0) > MAX_EFFECTIVE_PERIODS_PER_SITE) {
        throw new TariffValidationError('That’s more rate plan changes than we can save. Add the older ones in Rate Plans.');
      }
      if (openLabel !== null) {
        if (!(await setPlanLabelOnClient(client, siteId, userId, openLabel, expectedUtility))) throw new UtilityChangedError('Utility changed. Start again.');
      } else if (saved.length) {
        // The site now has a rate plan: rerun the estimate job so the actual timeline is built from it.
        await client.query(`UPDATE "SiteUtility" SET status = 'pending', next_check_at = NULL, updated_at = clock_timestamp() WHERE site_id = $1 AND status = 'needs_plan'`, [siteId]);
      }
      const estimateChanges = (await applyEstimatesOnClient(client, siteId, today)).changed;
      savedCount = saved.length;
      const changed: Array<{ from: string; to: string | null }> = [...saved, ...estimateChanges];
      if (changed.length) {
        const params: EnqueueReattributionParams = { siteId, fromDate: changed[0].from, toDate: changed[0].to, requestedByUserId: userId, trigger: 'create' };
        for (const range of changed) {
          params.fromDate = minDate(params.fromDate, range.from);
          params.toDate = maxEnd(params.toDate, range.to);
        }
        reattribution = params;
        queued = await enqueueReattributionOnClient(client, params);
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    new SiteRepo().invalidateCache(siteId);
    if (reattribution && queued) logReattributionEnqueued(reattribution, queued);
    logEvent('info', 'tariff.history.saved', { revisionCount: revisions.length, savedPeriodCount: savedCount, openPlan: openLabel !== null });
    return this.getTimeline(siteId, userId);
  }
  async getTimeline(siteId: string, viewerUserId: string | null): Promise<SiteTariffsTimelineResponse> {
    const siteRes = await pool.query<{
      id: string;
      timezone: string;
      currency: string | null;
      nameplate_energy: string | number | null;
      nameplate_power: string | number | null;
      backup_reserve_percent: string | number | null;
    }>(
      `SELECT id, timezone,
              COALESCE(json -> 'tariff_content_v2' ->> 'currency', json ->> 'currency', 'USD') AS currency,
              json ->> 'nameplate_energy' AS nameplate_energy,
              json ->> 'nameplate_power' AS nameplate_power,
              json ->> 'backup_reserve_percent' AS backup_reserve_percent
       FROM "Site" WHERE id = $1`,
      [siteId]
    );
    const siteRow = siteRes.rows[0];
    if (!siteRow) throw new TariffNotFoundError('Site not found');
    const timezone = siteRow.timezone || 'UTC';
    const currency = siteRow.currency || 'USD';
    const today = siteLocalDateString(new Date(), timezone);
    const battery = parseSiteBattery(siteRow);

    const periodsRes = await pool.query<PeriodQueryRow>(
      `SELECT p.id AS period_id, p.tariff_id, p.effective_from::text, p.effective_to::text,
              p.source, p.updated_by_user_id, u.email AS updated_by_email,
              t.name, t.version, t.content_hash, us.start_source, us.start_date::text AS anchor_start,
              EXISTS (SELECT 1 FROM "TariffUrdbSource" oh WHERE oh.tariff_id = p.tariff_id AND oh.role = 'owner_history') AS owner_history
       FROM "TariffEffectivePeriod" p
       JOIN "Tariff" t ON t.id = p.tariff_id
       LEFT JOIN "TariffUrdbSource" us ON us.tariff_id = p.tariff_id AND us.role = 'tesla_anchor'
       LEFT JOIN "User" u ON u.id = p.updated_by_user_id
       WHERE p.site_id = $1
       ORDER BY p.effective_from DESC, p.id DESC`,
      [siteId]
    );

    const referencePeriodsRes = await pool.query<PeriodQueryRow>(
      `SELECT p.id AS period_id, p.tariff_id, p.effective_from::text, p.effective_to::text,
              p.source, p.updated_by_user_id, u.email AS updated_by_email,
              t.name, t.version, t.content_hash
       FROM "TariffReferencePeriod" p
       JOIN "Tariff" t ON t.id = p.tariff_id
       LEFT JOIN "User" u ON u.id = p.updated_by_user_id
       WHERE p.site_id = $1
       ORDER BY p.effective_from ASC, p.id ASC`,
      [siteId]
    );

    const tariffIds = [...new Set([
      ...periodsRes.rows.map(r => Number(r.tariff_id)),
      ...referencePeriodsRes.rows.map(r => Number(r.tariff_id)),
    ])];
    const tariffMap = await hydrateTariffs(pool, tariffIds);

    const latestTeslaRes = await pool.query<LatestTeslaTariffSummary>(
      `SELECT id, name, updated, content_hash
       FROM "Tariff"
       WHERE site_id = $1 AND source = 'tesla'
       ORDER BY id DESC LIMIT 1`,
      [siteId]
    );
    const reattrRes = await pool.query<SiteTariffReattributionRow>(
      'SELECT * FROM "SiteTariffReattribution" WHERE site_id = $1',
      [siteId]
    );

    const utilityRes = await pool.query<{ status: string; choice: string; urdb_utility: string | null; newer_urdb_name: string | null; newer_urdb_start: string | null }>(
      `SELECT u.status, u.choice, u.urdb_utility, (SELECT newer_urdb_name FROM "TariffUrdbSource" WHERE site_id = u.site_id AND role = 'tesla_anchor' AND newer_urdb_label IS NOT NULL AND tariff_id = (SELECT id FROM "Tariff" WHERE site_id = u.site_id AND source = 'tesla' ORDER BY id DESC LIMIT 1)) AS newer_urdb_name, (SELECT newer_urdb_start::text FROM "TariffUrdbSource" WHERE site_id = u.site_id AND role = 'tesla_anchor' AND newer_urdb_label IS NOT NULL AND tariff_id = (SELECT id FROM "Tariff" WHERE site_id = u.site_id AND source = 'tesla' ORDER BY id DESC LIMIT 1)) AS newer_urdb_start FROM "SiteUtility" u WHERE u.site_id = $1`, [siteId]
    );
    const utility = utilityRes.rows[0];
    const estimateSourceRes = await pool.query<{ tariff_id: number; role: string; start_date: string; revision_start: string | null }>(
      `SELECT tariff_id, role, start_date::text, revision_start::text FROM "TariffUrdbSource" WHERE site_id = $1 AND role IN ('estimated_actual', 'estimated_reference')`,
      [siteId]
    );
    const timeline = buildSiteTariffsTimelineResponse({
      siteId,
      timezone,
      currency,
      today,
      viewerUserId,
      periodRows: periodsRes.rows,
      referencePeriodRows: referencePeriodsRes.rows,
      tariffMap,
      battery,
      reattribution: reattrRes.rows[0],
      latestTesla: latestTeslaRes.rows[0],
    });
    if (utility) {
      const skipped = utility.choice === 'skipped';
      const freshness = skipped ? { newestRevisionStart: null, mayBeOutdated: false } : estimateFreshness({
        today,
        periodRows: periodsRes.rows.map(row => ({ tariff_id: Number(row.tariff_id), source: row.source, effective_from: row.effective_from, effective_to: row.effective_to })),
        referencePeriodRows: referencePeriodsRes.rows.map(row => ({ tariff_id: Number(row.tariff_id), source: row.source, effective_from: row.effective_from, effective_to: row.effective_to })),
        sources: estimateSourceRes.rows.map(row => ({ tariff_id: Number(row.tariff_id), role: row.role, start_date: row.start_date, revision_start: row.revision_start })),
      });
      timeline.estimates = {
        status: skipped ? 'skipped' : utility.status === 'running' ? 'pending' : utility.status as Exclude<import('./tariff-contract').EstimatesStatusDTO['status'], 'skipped'>,
        utilityName: utility.urdb_utility,
        teslaPlanOutOfDate: !skipped && utility.newer_urdb_name !== null,
        newerPlanName: skipped ? null : utility.newer_urdb_name,
        newerPlanStart: skipped ? null : utility.newer_urdb_start,
        ...freshness,
        historyGuide: null,
      };
      // The guide lists the utility's public plans, so a site with no utility (outside the US) gets none.
      if (!skipped && utility.urdb_utility !== null && (utility.status === 'ready' || utility.status === 'needs_plan')) {
        const window = await loadHistoryWindow(pool, siteId, today);
        if (window) timeline.estimates.historyGuide = { historyStart: window.historyStart, fillThrough: window.fillThrough, unconfirmedDays: window.unconfirmedDays };
      }
    }
    return timeline;
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
      const resultingCount = existing.filter(row => row.source !== 'estimated' && !plan.deleteIds.includes(row.id)).length + plan.inserts.filter(row => row.source !== 'estimated').length;
      if (resultingCount > MAX_EFFECTIVE_PERIODS_PER_SITE) {
        throw new TariffValidationError(`Cannot exceed ${MAX_EFFECTIVE_PERIODS_PER_SITE} effective periods per site`);
      }
      const inserted = await applySpanMutationPlan(client, siteId, plan);
      createdPeriodId = inserted.at(-1)?.id ?? 0;
      const estimateChanges = (await applyEstimatesOnClient(client, siteId, today)).changed;
      // The site now has a rate plan: rerun the estimate job so the actual timeline is built from it.
      await client.query(`UPDATE "SiteUtility" SET status = 'pending', next_check_at = NULL, updated_at = clock_timestamp() WHERE site_id = $1 AND status = 'needs_plan'`, [siteId]);
      reattribution = {
        siteId, fromDate: validated.effectiveFrom, toDate: validated.effectiveTo, requestedByUserId: userId, trigger: 'create',
      };
      for (const range of estimateChanges) {
        reattribution.fromDate = minDate(reattribution.fromDate, range.from);
        reattribution.toDate = maxEnd(reattribution.toDate, range.to);
      }
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
        const keepsEstimateName = target.source === 'estimated' &&
          (patch.name ?? currentTariff.name ?? '').trim().toLowerCase() === (currentTariff.name ?? '').trim().toLowerCase();
        const validated = validateTariffPlanInput({
          name: keepsEstimateName ? await availableEstimateName(client, siteId, currentTariff.name ?? '', nextFrom) : patch.name ?? currentTariff.name ?? '',
          effectiveFrom: nextFrom,
          effectiveTo: nextTo,
          seasons: patch.seasons ?? currentSeasons,
        }, today);
        seasonCount = validated.seasons.length;
        if (target.source === 'estimated' || validated.name.trim().toLowerCase() !== (currentTariff.name ?? '').trim().toLowerCase()) {
          await assertPlanNameAvailable(client, siteId, validated.name, target.tariffId);
        }
        const parsed = compileSeasonsToParsedTariff(validated.name, validated.seasons);
        const newHash = tariffContentHash(parsed);
        if (target.source === 'estimated' || newHash !== currentTariff.content_hash || validated.name !== currentTariff.name) {
          targetTariffId = await insertTariffGraph(client, siteId, parsed, 'manual', userId, false, newHash);
        } else {
          targetTariffId = target.tariffId;
        }
      }

      const remaining = existing.filter(s => s.id !== periodId);
      const mutationPlan = computeSpanMutations(remaining, {
        tariffId: targetTariffId,
        source: target.source === 'estimated' ? 'manual' : target.source,
        effectiveFrom: nextFrom,
        effectiveTo: nextTo,
        updatedByUserId: userId,
      });
      const plan: SpanMutationPlan = {
        deleteIds: [periodId, ...mutationPlan.deleteIds],
        inserts: mutationPlan.inserts,
      };
      const resultingCount = existing.filter(row => row.source !== 'estimated' && !plan.deleteIds.includes(row.id)).length + plan.inserts.filter(row => row.source !== 'estimated').length;
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

      const estimateChanges = (await applyEstimatesOnClient(client, siteId, today)).changed;
      reattribution = {
        siteId,
        fromDate: minDate(oldFrom, nextFrom),
        toDate: maxEnd(oldTo, nextTo),
        requestedByUserId: userId,
        trigger: 'update',
      };
      for (const range of estimateChanges) {
        reattribution.fromDate = minDate(reattribution.fromDate, range.from);
        reattribution.toDate = maxEnd(reattribution.toDate, range.to);
      }
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
      if (target.source === 'estimated') throw new TariffValidationError('Estimated rate plans fill days without a plan. Add your rate plan to replace one.');
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

      const estimateChanges = (await applyEstimatesOnClient(client, siteId, today)).changed;
      reattribution = {
        siteId, fromDate: removedFrom, toDate: removedTo, requestedByUserId: userId, trigger: 'delete',
      };
      for (const range of estimateChanges) {
        reattribution.fromDate = minDate(reattribution.fromDate, range.from);
        reattribution.toDate = maxEnd(reattribution.toDate, range.to);
      }
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

  async createReferencePeriod(
    siteId: string,
    userId: string,
    input: TariffPlanWriteInput
  ): Promise<SiteTariffsTimelineResponse> {
    const client = await pool.connect();
    let createdPeriodId = 0;
    let newTariffId = 0;
    let validated: TariffPlanWriteInput;
    try {
      await client.query('BEGIN');
      const siteRes = await client.query<{ timezone: string }>(
        'SELECT timezone FROM "Site" WHERE id = $1 FOR UPDATE',
        [siteId]
      );
      if (!siteRes.rows[0]) throw new TariffNotFoundError('Site not found');
      const today = siteLocalDateString(new Date(), siteRes.rows[0].timezone || 'UTC');
      validated = validateTariffPlanInput(input, today);

      const parsed = compileSeasonsToParsedTariff(validated.name, validated.seasons);
      newTariffId = await insertTariffGraph(client, siteId, parsed, 'manual', userId, false);

      const existing = await loadReferenceSpans(client, siteId);
      const plan = computeSpanMutations(existing, {
        tariffId: newTariffId,
        source: 'manual',
        effectiveFrom: validated.effectiveFrom,
        effectiveTo: validated.effectiveTo,
        updatedByUserId: userId,
      });
      const resultingCount = existing.filter(row => row.source !== 'estimated' && !plan.deleteIds.includes(row.id)).length + plan.inserts.filter(row => row.source !== 'estimated').length;
      if (resultingCount > MAX_EFFECTIVE_PERIODS_PER_SITE) {
        throw new TariffValidationError(`Cannot exceed ${MAX_EFFECTIVE_PERIODS_PER_SITE} effective periods per site`);
      }
      const inserted = await applyReferenceSpanMutationPlan(client, siteId, plan);
      createdPeriodId = inserted.find(row => row.tariffId === newTariffId)?.id ?? inserted.at(-1)?.id ?? 0;
      await applyEstimatesOnClient(client, siteId, today, 'reference');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    new SiteRepo().invalidateCache(siteId);
    logEvent('info', 'tariff.reference_period.created', {
      periodId: createdPeriodId,
      tariffId: newTariffId,
      effectiveFrom: validated.effectiveFrom,
      effectiveTo: validated.effectiveTo,
      seasonCount: validated.seasons.length,
      accountId: accountFingerprint(userId),
    });
    return this.getTimeline(siteId, userId);
  }

  async updateReferencePeriod(
    siteId: string,
    userId: string,
    periodId: number,
    patch: Partial<TariffPlanWriteInput>
  ): Promise<SiteTariffsTimelineResponse> {
    const client = await pool.connect();
    let targetTariffId = 0;
    let nextFrom = '';
    let nextTo: string | null = null;
    let seasonCount = 0;
    try {
      await client.query('BEGIN');
      const siteRes = await client.query<{ timezone: string }>(
        'SELECT timezone FROM "Site" WHERE id = $1 FOR UPDATE',
        [siteId]
      );
      if (!siteRes.rows[0]) throw new TariffNotFoundError('Site not found');
      const today = siteLocalDateString(new Date(), siteRes.rows[0].timezone || 'UTC');

      const existing = await loadReferenceSpans(client, siteId);
      const target = existing.find(s => s.id === periodId);
      if (!target) throw new TariffNotFoundError('Reference rate plan period not found');

      nextFrom = patch.effectiveFrom ?? target.effectiveFrom;
      nextTo = patch.effectiveTo !== undefined ? patch.effectiveTo : target.effectiveTo;

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

      const parsed = compileSeasonsToParsedTariff(validated.name, validated.seasons);
      const newHash = tariffContentHash(parsed);
      if (target.source === 'estimated' || newHash !== currentTariff.content_hash || validated.name !== currentTariff.name) {
        targetTariffId = await insertTariffGraph(client, siteId, parsed, 'manual', userId, false, newHash);
      } else {
        targetTariffId = target.tariffId;
      }

      const remaining = existing.filter(s => s.id !== periodId);
      const mutationPlan = computeSpanMutations(remaining, {
        tariffId: targetTariffId,
        source: 'manual',
        effectiveFrom: nextFrom,
        effectiveTo: nextTo,
        updatedByUserId: userId,
      });
      const plan: SpanMutationPlan = {
        deleteIds: [periodId, ...mutationPlan.deleteIds],
        inserts: mutationPlan.inserts,
      };
      const resultingCount = existing.filter(row => row.source !== 'estimated' && !plan.deleteIds.includes(row.id)).length + plan.inserts.filter(row => row.source !== 'estimated').length;
      if (resultingCount > MAX_EFFECTIVE_PERIODS_PER_SITE) {
        throw new TariffValidationError(`Cannot exceed ${MAX_EFFECTIVE_PERIODS_PER_SITE} effective periods per site`);
      }
      await applyReferenceSpanMutationPlan(client, siteId, plan);
      await applyEstimatesOnClient(client, siteId, today, 'reference');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    new SiteRepo().invalidateCache(siteId);
    logEvent('info', 'tariff.reference_period.updated', {
      periodId,
      tariffId: targetTariffId,
      effectiveFrom: nextFrom,
      effectiveTo: nextTo,
      seasonCount,
      accountId: accountFingerprint(userId),
    });
    return this.getTimeline(siteId, userId);
  }

  async deleteReferencePeriod(
    siteId: string,
    periodId: number,
    viewerUserId: string | null = null
  ): Promise<SiteTariffsTimelineResponse> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const siteRes = await client.query<{ timezone: string }>(
        'SELECT timezone FROM "Site" WHERE id = $1 FOR UPDATE',
        [siteId]
      );
      if (!siteRes.rows[0]) throw new TariffNotFoundError('Site not found');

      const target = (await loadReferenceSpans(client, siteId)).find(row => row.id === periodId);
      if (target?.source === 'estimated') throw new TariffValidationError('Estimated rate plans fill days without a plan. Add your rate plan to replace one.');
      const delRes = await client.query<{ id: number }>(
        'DELETE FROM "TariffReferencePeriod" WHERE site_id = $1 AND id = $2 RETURNING id',
        [siteId, periodId]
      );
      if (delRes.rowCount === 0) throw new TariffNotFoundError('Reference rate plan period not found');
      await applyEstimatesOnClient(client, siteId, siteLocalDateString(new Date(), siteRes.rows[0].timezone || 'UTC'), 'reference');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    new SiteRepo().invalidateCache(siteId);
    logEvent('info', 'tariff.reference_period.deleted', {
      periodId,
      accountId: viewerUserId ? accountFingerprint(viewerUserId) : null,
    });
    return this.getTimeline(siteId, viewerUserId);
  }
}

async function loadReferenceSpans(client: PoolClient, siteId: string): Promise<ExistingSpan[]> {
  const res = await client.query<{
    id: number;
    tariff_id: number;
    source: TariffSource;
    effective_from: string;
    effective_to: string | null;
    updated_by_user_id: string | null;
  }>(
    `SELECT id, tariff_id, source, effective_from::text, effective_to::text, updated_by_user_id
     FROM "TariffReferencePeriod"
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

async function applyReferenceSpanMutationPlan(
  client: PoolClient,
  siteId: string,
  plan: SpanMutationPlan
): Promise<Array<{ id: number; tariffId: number }>> {
  if (plan.deleteIds.length > 0) {
    await client.query(
      'DELETE FROM "TariffReferencePeriod" WHERE site_id = $1 AND id = ANY($2::int[])',
      [siteId, plan.deleteIds]
    );
  }
  const inserted: Array<{ id: number; tariffId: number }> = [];
  for (const row of plan.inserts) {
    const res = await client.query<{ id: number }>(
      `INSERT INTO "TariffReferencePeriod"(site_id, tariff_id, effective_from, effective_to, updated_by_user_id, source)
       VALUES ($1, $2, $3::date, $4::date, $5, $6)
       RETURNING id`,
      [siteId, row.tariffId, row.effectiveFrom, row.effectiveTo, row.updatedByUserId, row.source]
    );
    inserted.push({ id: Number(res.rows[0].id), tariffId: row.tariffId });
  }
  return inserted;
}
