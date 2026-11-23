import { layoutTimeline } from './tariff-estimates';
import {
  buildBatchAiHandoffPreviewWithDetails,
  TariffAiHandoffConflictError,
} from './tariff-ai-handoff-service';
import { estimateFreshness } from './urdb/match';
import type { PoolClient } from 'pg';
import { pool } from './db';
import type {
  ExportRateProvenance,
  RateCountrySource,
  RatePlanEligibility,
  SiteTariffReattributionRow,
  Tariff,
  TariffSchedule,
  TariffSeason,
  TariffSelectionCandidateKind,
  TariffSelectionChoiceKind,
  TariffSelectionOriginalRow,
  TariffSelectionRow,
  TariffSelectionScope,
  TariffSelectionVerificationRow,
  TariffSource,
} from './db-types';
import { buildDefaultTariff, tariffContentHash, type ParsedTariff } from './importer/tariff-parser';
import { accountFingerprint, logEvent } from './observability';
import { observedHolidayDates } from './holidays';
import { mapSystemCostRows, SYSTEM_COST_COMPONENTS, type SystemCostRow, type SystemCostsInput } from './system-costs';
import { SiteRepo } from './site-repo';
import { fillWindowBounds, loadHistoryWindow, loadHistoryWindowInput, uncoveredPieces, type HistoryWindow } from './urdb/history-window';
import type { ExpandedRevision } from './urdb/history-expand';
import { enqueueReattributionOnClient, logReattributionEnqueued, type EnqueuedReattribution, type EnqueueReattributionParams } from './tariff-reattribution-queue';
import {
  buildTariffSelectionPreview,
  type ConversionInputsRecord,
  type ExistingTimelineSpanInput,
  type RestorationTargetSpanInput,
} from './tariff-selection';
import type { UrdbRate } from './urdb/types';
import type {
  ReattributionStatusDTO,
  SiteBatteryDTO,
  SiteRateCountryDTO,
  SiteTariffsTimelineResponse,
  TariffApproximationNote,
  TariffPeriodDTO,
  TariffRestorationOriginalRef,
  TariffReviewPlanSnapshot,
  TariffSeasonInput,
  TariffSelectionCommit,
  TariffSelectionPreviewResponse,
  TariffSelectionRequest,
  TariffVerificationSummary,
  TeslaSyncUnavailableDbReason,
} from './tariff-contract';
import type { TeslaSyncAttempt } from './tesla-tariff-sync-repo';
import { TeslaTariffSyncRepo } from './tesla-tariff-sync-repo';
import {
  assertUsRatePlanEligibility,
  deriveRatePlanEligibility,
  PublicPlansIneligibleError,
  shouldApplyRateCountryWrite,
  UtilityChangedError,
  validateSiteRateCountryInput,
} from './rate-plan-eligibility';
import {
  addCalendarDays,
  compileSeasonsToParsedTariff,
  computeSpanMutations,
  decompileTariffToSeasons,
  isProtectedSpan,
  MAX_EFFECTIVE_PERIODS_PER_SITE,
  MAX_PLAN_NAME_LENGTH,
  siteLocalDateString,
  tariffHasDaySpecificSchedules,
  TariffValidationError,
  validateEffectiveDates,
  validateTariffPlanInput,
  type ExistingSpan,
  type NewSpanRow,
  type SpanMutationPlan,
  type TariffPlanWriteInput,
} from './tariff-timeline';
import { teslaPlansMatch } from './tesla-tou-sync';

export { PublicPlansIneligibleError, UtilityChangedError };

export class TariffNotFoundError extends Error {
  readonly status = 404;
}

export class TariffSelectionConflictError extends Error {
  readonly status = 409;
  readonly code = 'REVIEW_STALE' as const;
  readonly refreshPath: string;
  readonly preview: TariffSelectionPreviewResponse;

  constructor(
    siteId: string,
    preview: TariffSelectionPreviewResponse,
    message = 'This rate plan preview is out of date because the timeline or utility rates changed. Review the updated details before saving.'
  ) {
    super(message);
    this.refreshPath = `/api/site/${encodeURIComponent(siteId)}/tariffs/selection/preview`;
    this.preview = preview;
  }
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
  selection_id?: number | null;
  choice_kind?: TariffSelectionChoiceKind | null;
  candidate_kind?: TariffSelectionCandidateKind | null;
  selected_by_user_id?: string | null;
  urdb_label?: string | null;
  utility_name?: string | null;
  revision_start?: string | null;
  export_rate_provenance?: ExportRateProvenance | null;
  holidays_use_weekend?: boolean | null;
  approximation_notes?: unknown;
  verified_at?: Date | string | null;
  verified_by_user_id?: string | null;
  verified_by_email?: string | null;
  verified_tariff_id?: number | null;
  verified_content_hash?: string | null;
  verified_effective_from?: string | null;
  verified_effective_to?: string | null;
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
  /** Site.installed as a site-local YYYY-MM-DD. */
  siteInstalled: string;
  battery?: SiteBatteryDTO | null;
  systemCostRows?: SystemCostRow[];
  reattribution?: SiteTariffReattributionRow;
  latestTesla?: LatestTeslaTariffSummary;
  /** Site.json components.tou_capable, read from the Site row. */
  touCapable?: boolean;
  /** True when Site.json holds Tesla's tariff_content_v2. */
  hasTeslaContent?: boolean;
  /** The site's most recent Sync to Tesla attempt. */
  lastSync?: TeslaSyncAttempt | null;
  rateCountry?: string | null;
  rateCountrySource?: RateCountrySource | null;
  rateCountryUpdatedAt?: Date | string | null;
}

export interface EffectivePeriodPick {
  periodId: number;
  tariffId: number;
  effectiveFrom: string;
  effectiveTo: string | null;
}

/**
 * The billing plan for a site-local date: the period covering it (latest start wins), else, in a
 * gap, the period that ended most recently, else, before every plan, the earliest. Used by
 * `resolveTariffForDate` and `resolveTariffsForDates`; `effectiveTariffIdSql` is the same policy in SQL.
 */
export function pickTariffIdForDate(periods: readonly EffectivePeriodPick[], date: string): number | undefined {
  let covering: EffectivePeriodPick | undefined;
  let prior: EffectivePeriodPick | undefined;
  let earliest: EffectivePeriodPick | undefined;
  for (const p of periods) {
    if (p.effectiveFrom <= date && (p.effectiveTo === null || p.effectiveTo >= date)) {
      if (!covering || p.effectiveFrom > covering.effectiveFrom
        || (p.effectiveFrom === covering.effectiveFrom && p.periodId > covering.periodId)) covering = p;
    }
    if (p.effectiveTo !== null && p.effectiveTo < date) {
      if (!prior || p.effectiveTo > (prior.effectiveTo as string)
        || (p.effectiveTo === prior.effectiveTo && p.periodId > prior.periodId)) prior = p;
    }
    if (!earliest || p.effectiveFrom < earliest.effectiveFrom
      || (p.effectiveFrom === earliest.effectiveFrom && p.periodId < earliest.periodId)) earliest = p;
  }
  return (covering ?? prior ?? earliest)?.tariffId;
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

function resolveVerifiedSummary(
  r: Pick<
    PeriodQueryRow,
    | 'tariff_id'
    | 'content_hash'
    | 'verified_at'
    | 'verified_by_user_id'
    | 'verified_by_email'
    | 'verified_tariff_id'
    | 'verified_content_hash'
    | 'verified_effective_from'
    | 'verified_effective_to'
  >,
  effectiveFrom: string,
  effectiveTo: string | null,
  viewerUserId: string | null
): TariffVerificationSummary | null {
  if (!r.verified_at || !r.content_hash) return null;
  if (r.verified_tariff_id === null || r.verified_tariff_id === undefined) return null;
  if (Number(r.verified_tariff_id) !== Number(r.tariff_id)) return null;
  if (r.verified_content_hash !== r.content_hash) return null;
  if (r.verified_effective_from?.slice(0, 10) !== effectiveFrom) return null;
  const verifiedTo = r.verified_effective_to ? r.verified_effective_to.slice(0, 10) : null;
  if (verifiedTo !== effectiveTo) return null;
  const verifiedAt = toIsoOrNull(r.verified_at);
  if (!verifiedAt) return null;
  return {
    verifiedAt,
    verifiedByEmail: r.verified_by_email ?? null,
    verifiedByCurrentUser: viewerUserId !== null && r.verified_by_user_id === viewerUserId,
  };
}

function mapPeriodRowToDTO(
  r: PeriodQueryRow,
  viewerUserId: string | null,
  tariffMap: Map<number, Tariff>
): TariffPeriodDTO {
  const effectiveFrom = r.effective_from.slice(0, 10);
  const effectiveTo = r.effective_to ? r.effective_to.slice(0, 10) : null;
  const tariff = tariffMap.get(Number(r.tariff_id));
  const hasProvenance =
    r.selection_id !== undefined ||
    r.choice_kind !== undefined ||
    r.urdb_label !== undefined ||
    r.verified_at !== undefined;
  const choiceKind: TariffSelectionChoiceKind | undefined = r.choice_kind
    ?? (hasProvenance ? (r.source === 'manual' || Boolean(r.updated_by_user_id) ? 'owner' : 'automatic') : undefined);
  const verification = hasProvenance
    ? resolveVerifiedSummary(r, effectiveFrom, effectiveTo, viewerUserId)
    : undefined;
  return {
    periodId: Number(r.period_id),
    tariffId: Number(r.tariff_id),
    name: r.name || 'Rate Plan',
    version: Number(r.version ?? 1),
    source: r.source,
    startSource: r.source === 'estimated' || (r.source === 'manual' && r.owner_history)
      ? 'urdb'
      : r.source === 'tesla' && !r.updated_by_user_id && r.choice_kind !== 'owner' && r.anchor_start?.slice(0, 10) === effectiveFrom
        ? r.start_source ?? null
        : null,
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
    ...(hasProvenance
      ? {
          selectionId: r.selection_id ?? null,
          choiceKind,
          ...(r.candidate_kind ? { candidateKind: r.candidate_kind } : {}),
          urdbLabel: r.urdb_label ?? null,
          verification: verification ?? null,
        }
      : {}),
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
    siteInstalled,
    battery = null,
    systemCostRows = [],
    reattribution,
    latestTesla,
    touCapable = false,
    hasTeslaContent = false,
    lastSync = null,
    rateCountry,
    rateCountrySource = null,
    rateCountryUpdatedAt = null,
  } = input;

  const periods: TariffPeriodDTO[] = periodRows.map(r => mapPeriodRowToDTO(r, viewerUserId, tariffMap));
  const referencePeriods: TariffPeriodDTO[] = referencePeriodRows
    .map(r => mapPeriodRowToDTO(r, viewerUserId, tariffMap))
    .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom) || a.periodId - b.periodId);

  const activeToday = pickActivePeriodForDate(periods, today);
  if (activeToday) activeToday.isCurrentToday = true;
  const activeRefToday = pickActivePeriodForDate(referencePeriods, today);
  if (activeRefToday) activeRefToday.isCurrentToday = true;

  // The plan chosen in PWUsage that is active today: any period a Tesla import won't replace
  // (the same isProtectedSpan rule TariffRepo.addTariffVersion applies), so a manual plan, a public
  // plan or a restored Tesla plan. The field keeps its wire name for older clients.
  const activeManualRow = periodRows.find(r => {
    const from = r.effective_from.slice(0, 10);
    const to = r.effective_to ? r.effective_to.slice(0, 10) : null;
    const chosenInPwusage = isProtectedSpan({
      source: r.source,
      updatedByUserId: r.updated_by_user_id,
      choiceKind: r.choice_kind ?? undefined,
    });
    return chosenInPwusage && from <= today && (to === null || to >= today);
  });
  // Compare plan content, not hashes: a Tesla import and the same rates stored by PWUsage can carry
  // different hashes. Fall back to the hash only when either tariff is not loaded.
  const activeManualTariff = activeManualRow ? tariffMap.get(Number(activeManualRow.tariff_id)) : undefined;
  const latestTeslaTariff = latestTesla ? tariffMap.get(Number(latestTesla.id)) : undefined;
  const differsFromActiveManual = Boolean(
    activeManualRow && latestTesla && (
      activeManualTariff && latestTeslaTariff
        ? !teslaPlansMatch(decompileTariffToSeasons(activeManualTariff), decompileTariffToSeasons(latestTeslaTariff), {
          eitherDaySpecific: tariffHasDaySpecificSchedules(activeManualTariff) || tariffHasDaySpecificSchedules(latestTeslaTariff),
        })
        : latestTesla.content_hash !== activeManualRow.content_hash
    )
  );

  // Sync to Tesla availability uses stored state only (no Tesla call). The first applicable reason wins.
  const syncAvailable = differsFromActiveManual && touCapable && hasTeslaContent;
  const syncUnavailableReason: TeslaSyncUnavailableDbReason | null = !activeToday
    ? 'no_active_plan'
    : latestTesla && !differsFromActiveManual
      ? 'no_difference'
      : !touCapable
        ? 'not_tou_capable'
        : !latestTesla || !hasTeslaContent
          ? 'no_tesla_plan'
          : null;

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

  let rateCountryDTO: SiteRateCountryDTO | undefined;
  if (rateCountry !== undefined) {
    const eligibility = deriveRatePlanEligibility(rateCountry);
    const hasIneligiblePublicSelection =
      eligibility !== 'us' &&
      [...periods, ...referencePeriods].some(
        p => p.source === 'estimated' && (p.choiceKind === 'owner' || p.updatedBy !== null)
      );
    rateCountryDTO = {
      countryCode: rateCountry ?? null,
      source: rateCountry ? (rateCountrySource ?? null) : null,
      updatedAt: toIsoOrNull(rateCountryUpdatedAt),
      eligibility,
      hasIneligiblePublicSelection,
    };
  }

  return {
    version: 2,
    siteId,
    timezone,
    currency,
    periods,
    referencePeriods,
    estimates: null,
    ...(rateCountryDTO ? { rateCountry: rateCountryDTO } : {}),
    battery,
    systemCosts: { siteInstalled, ...mapSystemCostRows(systemCostRows) },
    reattribution: toReattributionDTO(reattribution),
    holidayDates: holidayYears.flatMap(y => observedHolidayDates(y)),
    teslaSync: {
      latestTariffId: latestTesla ? Number(latestTesla.id) : null,
      latestTariffName: latestTesla?.name ?? null,
      latestUpdatedAt: toIsoOrNull(latestTesla?.updated),
      activeManualUpdatedAt: toIsoOrNull(activeManualRow ? tariffMap.get(Number(activeManualRow.tariff_id))?.updated : null),
      differsFromActiveManual,
      syncAvailable,
      syncUnavailableReason,
      lastSync: lastSync
        ? { status: lastSync.status, at: lastSync.finishedAt ?? lastSync.createdAt }
        : null,
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

export interface CapturedOriginalInterval {
  effectiveFrom: string;
  effectiveTo: string | null;
  originalTariffId: number;
  originalSelectionId: number | null;
}

export interface InsertTariffSelectionParams {
  siteId: string;
  scope: TariffSelectionScope;
  tariffId: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  source: TariffSource;
  choiceKind: TariffSelectionChoiceKind;
  candidateKind: TariffSelectionCandidateKind;
  selectedByUserId: string | null;
  urdbLabel?: string | null;
  utilityName?: string | null;
  revisionStart?: string | null;
  exportRateProvenance: ExportRateProvenance;
  holidaysUseWeekend?: boolean;
  approximationNotes?: TariffApproximationNote[];
  selectedContentHash: string | null;
  restoredFromSelectionId?: number | null;
  reviewHash?: string | null;
  timelineRevision?: number | null;
}

export async function bumpSiteTimelineRevisionOnClient(
  client: Pick<PoolClient, 'query'>,
  siteId: string
): Promise<number | null> {
  const res = await client.query<{ timeline_revision: string | number | null }>(
    `UPDATE "Site"
     SET timeline_revision = COALESCE(timeline_revision, 0) + 1
     WHERE id = $1
     RETURNING timeline_revision`,
    [siteId]
  );
  const val = res.rows[0]?.timeline_revision;
  return val !== undefined && val !== null ? Number(val) : null;
}

export async function insertTariffSelectionOnClient(
  client: Pick<PoolClient, 'query'>,
  params: InsertTariffSelectionParams
): Promise<number | null> {
  const res = await client.query<{ id: number }>(
    `INSERT INTO "TariffSelection" (
       site_id, scope, tariff_id, effective_from, effective_to,
       source, choice_kind, candidate_kind, selected_by_user_id,
       urdb_label, utility_name, revision_start, export_rate_provenance,
       holidays_use_weekend, approximation_notes, selected_content_hash,
       restored_from_selection_id, review_hash, timeline_revision
     )
     VALUES ($1, $2, $3, $4::date, $5::date, $6, $7, $8, $9, $10, $11, $12::date, $13, $14, $15::jsonb, $16, $17, $18, $19)
     RETURNING id`,
    [
      params.siteId,
      params.scope,
      params.tariffId,
      params.effectiveFrom,
      params.effectiveTo,
      params.source,
      params.choiceKind,
      params.candidateKind,
      params.selectedByUserId,
      params.urdbLabel ?? null,
      params.utilityName ?? null,
      params.revisionStart ?? null,
      params.exportRateProvenance,
      params.holidaysUseWeekend ?? true,
      JSON.stringify(params.approximationNotes ?? []),
      params.selectedContentHash,
      params.restoredFromSelectionId ?? null,
      params.reviewHash ?? null,
      params.timelineRevision ?? null,
    ]
  );
  return res.rows[0]?.id !== undefined ? Number(res.rows[0].id) : null;
}

export async function insertSelectionVerificationOnClient(
  client: Pick<PoolClient, 'query'>,
  params: {
    selectionId: number;
    siteId: string;
    scope: TariffSelectionScope;
    tariffId: number;
    tariffContentHash: string;
    effectiveFrom: string;
    effectiveTo: string | null;
    verifiedByUserId: string;
  }
): Promise<number | null> {
  const res = await client.query<{ id: number }>(
    `INSERT INTO "TariffSelectionVerification" (
       selection_id, site_id, scope, tariff_id, tariff_content_hash,
       effective_from, effective_to, verified_by_user_id, verified_at
     )
     VALUES ($1, $2, $3, $4, $5, $6::date, $7::date, $8, now())
     RETURNING id`,
    [
      params.selectionId,
      params.siteId,
      params.scope,
      params.tariffId,
      params.tariffContentHash,
      params.effectiveFrom,
      params.effectiveTo,
      params.verifiedByUserId,
    ]
  );
  return res.rows[0]?.id !== undefined ? Number(res.rows[0].id) : null;
}

function spansOverlapDates(aFrom: string, aTo: string | null, bFrom: string, bTo: string | null): boolean {
  if (aTo !== null && aTo < bFrom) return false;
  if (bTo !== null && bTo < aFrom) return false;
  return true;
}

function coalesceOriginalIntervals(intervals: CapturedOriginalInterval[]): CapturedOriginalInterval[] {
  const sorted = [...intervals].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  const merged: CapturedOriginalInterval[] = [];
  for (const cur of sorted) {
    const prev = merged.at(-1);
    if (
      prev &&
      prev.effectiveTo !== null &&
      addCalendarDays(prev.effectiveTo, 1) === cur.effectiveFrom &&
      prev.originalTariffId === cur.originalTariffId &&
      prev.originalSelectionId === cur.originalSelectionId
    ) {
      prev.effectiveTo = cur.effectiveTo;
    } else {
      merged.push({ ...cur });
    }
  }
  return merged;
}

export async function collectReplacedOriginalsOnClient(
  client: Pick<PoolClient, 'query'>,
  existing: ExistingSpan[],
  effectiveFrom: string,
  effectiveTo: string | null
): Promise<CapturedOriginalInterval[]> {
  const overlapping = existing.filter(span =>
    spansOverlapDates(span.effectiveFrom, span.effectiveTo, effectiveFrom, effectiveTo)
  );
  if (overlapping.length === 0) return [];

  const selectionIdsToLookup = [
    ...new Set(
      overlapping
        .filter(span => span.source !== 'tesla' && span.selectionId !== null && span.selectionId !== undefined)
        .map(span => Number(span.selectionId))
    ),
  ];

  const originalsBySelection = new Map<number, CapturedOriginalInterval[]>();
  if (selectionIdsToLookup.length > 0) {
    const origRes = await client.query<{
      selection_id: number;
      effective_from: string;
      effective_to: string | null;
      original_tariff_id: number;
      original_selection_id: number | null;
    }>(
      `SELECT selection_id, effective_from::text, effective_to::text, original_tariff_id, original_selection_id
       FROM "TariffSelectionOriginal"
       WHERE selection_id = ANY($1::int[])
       ORDER BY effective_from ASC, id ASC`,
      [selectionIdsToLookup]
    );
    for (const row of origRes.rows) {
      const sid = Number(row.selection_id);
      const list = originalsBySelection.get(sid) ?? [];
      list.push({
        effectiveFrom: row.effective_from.slice(0, 10),
        effectiveTo: row.effective_to ? row.effective_to.slice(0, 10) : null,
        originalTariffId: Number(row.original_tariff_id),
        originalSelectionId: row.original_selection_id === null ? null : Number(row.original_selection_id),
      });
      originalsBySelection.set(sid, list);
    }
  }

  const captured: CapturedOriginalInterval[] = [];
  for (const span of overlapping) {
    const clipFrom = span.effectiveFrom >= effectiveFrom ? span.effectiveFrom : effectiveFrom;
    const clipTo = minNullableEnd(span.effectiveTo, effectiveTo);
    if (clipTo !== null && clipFrom > clipTo) continue;

    if (span.source === 'tesla') {
      captured.push({
        effectiveFrom: clipFrom,
        effectiveTo: clipTo,
        originalTariffId: span.tariffId,
        originalSelectionId: span.selectionId ?? null,
      });
      continue;
    }

    if (span.selectionId !== null && span.selectionId !== undefined) {
      const preserved = originalsBySelection.get(span.selectionId) ?? [];
      for (const orig of preserved) {
        if (!spansOverlapDates(orig.effectiveFrom, orig.effectiveTo, clipFrom, clipTo)) continue;
        const oFrom = orig.effectiveFrom >= clipFrom ? orig.effectiveFrom : clipFrom;
        const oTo = minNullableEnd(orig.effectiveTo, clipTo);
        if (oTo !== null && oFrom > oTo) continue;
        captured.push({
          effectiveFrom: oFrom,
          effectiveTo: oTo,
          originalTariffId: orig.originalTariffId,
          originalSelectionId: orig.originalSelectionId,
        });
      }
    }
  }

  return coalesceOriginalIntervals(captured);
}

export async function storeSelectionOriginalsOnClient(
  client: Pick<PoolClient, 'query'>,
  siteId: string,
  scope: TariffSelectionScope,
  selectionId: number | null,
  originals: CapturedOriginalInterval[]
): Promise<void> {
  if (selectionId === null || originals.length === 0) return;
  for (const orig of originals) {
    await client.query(
      `INSERT INTO "TariffSelectionOriginal" (
         selection_id, site_id, scope, effective_from, effective_to, original_tariff_id, original_selection_id
       )
       VALUES ($1, $2, $3, $4::date, $5::date, $6, $7)`,
      [
        selectionId,
        siteId,
        scope,
        orig.effectiveFrom,
        orig.effectiveTo,
        orig.originalTariffId,
        orig.originalSelectionId,
      ]
    );
  }
}

export async function clearUnprotectedUrdbSourcesOnClient(
  client: Pick<PoolClient, 'query'>,
  siteId: string
): Promise<void> {
  await client.query(
    `UPDATE "TariffUrdbSource" u
     SET is_current_estimate = FALSE
     WHERE u.site_id = $1
       AND u.role IN ('estimated_actual', 'estimated_reference')
       AND u.is_current_estimate = TRUE
       AND (
         EXISTS (
           SELECT 1 FROM "TariffSelection" s
           WHERE s.tariff_id = u.tariff_id AND s.site_id = u.site_id AND s.choice_kind = 'owner'
         )
         OR EXISTS (
           SELECT 1 FROM "TariffEffectivePeriod" p
           WHERE p.tariff_id = u.tariff_id AND p.site_id = u.site_id AND p.updated_by_user_id IS NOT NULL
         )
         OR EXISTS (
           SELECT 1 FROM "TariffReferencePeriod" rp
           WHERE rp.tariff_id = u.tariff_id AND rp.site_id = u.site_id AND rp.updated_by_user_id IS NOT NULL
         )
       )`,
    [siteId]
  );

  await client.query(
    `DELETE FROM "TariffUrdbSource" u
     WHERE u.site_id = $1
       AND (
         u.role = 'tesla_anchor'
         OR (
           u.role IN ('estimated_actual', 'estimated_reference')
           AND NOT EXISTS (
             SELECT 1 FROM "TariffSelection" s
             WHERE s.tariff_id = u.tariff_id AND s.site_id = u.site_id AND s.choice_kind = 'owner'
           )
           AND NOT EXISTS (
             SELECT 1 FROM "TariffEffectivePeriod" p
             WHERE p.tariff_id = u.tariff_id AND p.site_id = u.site_id AND p.updated_by_user_id IS NOT NULL
           )
           AND NOT EXISTS (
             SELECT 1 FROM "TariffReferencePeriod" rp
             WHERE rp.tariff_id = u.tariff_id AND rp.site_id = u.site_id AND rp.updated_by_user_id IS NOT NULL
           )
         )
       )`,
    [siteId]
  );
}

export async function loadExistingSpans(client: Pick<PoolClient, 'query'>, siteId: string): Promise<ExistingSpan[]> {
  const res = await client.query<{
    id: number;
    tariff_id: number;
    source: TariffSource;
    effective_from: string;
    effective_to: string | null;
    updated_by_user_id: string | null;
    selection_id?: number | null;
    choice_kind?: TariffSelectionChoiceKind | null;
  }>(
    `SELECT p.id, p.tariff_id, p.source, p.effective_from::text, p.effective_to::text, p.updated_by_user_id,
            p.selection_id,
            (SELECT s.choice_kind FROM "TariffSelection" s WHERE s.id = p.selection_id) AS choice_kind
     FROM "TariffEffectivePeriod" p
     WHERE p.site_id = $1
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
    ...(r.selection_id !== undefined ? { selectionId: r.selection_id === null ? null : Number(r.selection_id) } : {}),
    ...(r.choice_kind ? { choiceKind: r.choice_kind } : {}),
  }));
}

export async function applySpanMutationPlan(
  client: Pick<PoolClient, 'query'>,
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
      `INSERT INTO "TariffEffectivePeriod"(site_id, tariff_id, effective_from, effective_to, source, updated_by_user_id, selection_id)
       VALUES ($1, $2, $3::date, $4::date, $5, $6, $7) RETURNING id`,
      [siteId, row.tariffId, row.effectiveFrom, row.effectiveTo, row.source, row.updatedByUserId, row.selectionId ?? null]
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
    `SELECT tariff_id, role, start_date::text, end_date::text
     FROM "TariffUrdbSource"
     WHERE site_id = $1 AND is_current_estimate = TRUE
     ORDER BY created_at DESC, tariff_id DESC`,
    [siteId]
  );
  const reference = await loadReferenceSpans(client, siteId);
  const desired = (role: string) => sources.rows.filter(row => row.role === role).map(row => ({ tariffId: Number(row.tariff_id), effectiveFrom: row.start_date, effectiveTo: row.end_date }));
  const anchors = sources.rows.filter(row => row.role === 'tesla_anchor').map(row => ({ tariffId: Number(row.tariff_id), startDate: row.start_date }));
  const referenceLayout = layoutTimeline(reference, [], desired('estimated_reference'));
  await applyReferenceSpanMutationPlan(client, siteId, referenceLayout);
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

function minNullableEnd(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
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

  const canHealLeft = left?.source === 'tesla' && !isProtectedSpan(left);
  const canHealRight = right?.source === 'tesla' && !isProtectedSpan(right);

  if (canHealLeft && canHealRight && left.tariffId === right.tariffId) {
    await applySpanMutationPlan(client, siteId, {
      deleteIds: [left.id, right.id],
      inserts: [{
        tariffId: left.tariffId,
        source: 'tesla',
        effectiveFrom: left.effectiveFrom,
        effectiveTo: right.effectiveTo,
        updatedByUserId: left.updatedByUserId,
        ...(left.selectionId !== undefined ? { selectionId: left.selectionId } : {}),
        ...(left.choiceKind !== undefined ? { choiceKind: left.choiceKind } : {}),
      }],
    });
    return;
  }
  if (canHealLeft) {
    await applySpanMutationPlan(client, siteId, {
      deleteIds: [left.id],
      inserts: [{
        tariffId: left.tariffId,
        source: 'tesla',
        effectiveFrom: left.effectiveFrom,
        effectiveTo: vacatedTo,
        updatedByUserId: left.updatedByUserId,
        ...(left.selectionId !== undefined ? { selectionId: left.selectionId } : {}),
        ...(left.choiceKind !== undefined ? { choiceKind: left.choiceKind } : {}),
      }],
    });
    return;
  }
  if (canHealRight) {
    await applySpanMutationPlan(client, siteId, {
      deleteIds: [right.id],
      inserts: [{
        tariffId: right.tariffId,
        source: 'tesla',
        effectiveFrom: vacatedFrom,
        effectiveTo: right.effectiveTo,
        updatedByUserId: right.updatedByUserId,
        ...(right.selectionId !== undefined ? { selectionId: right.selectionId } : {}),
        ...(right.choiceKind !== undefined ? { choiceKind: right.choiceKind } : {}),
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
  if ((updated.rowCount ?? 0) > 0) {
    await bumpSiteTimelineRevisionOnClient(client, siteId);
    return true;
  }
  return false;
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

function countProtectedResultingSpans(existing: ExistingSpan[], plan: SpanMutationPlan): number {
  const retainedCount = existing.filter(row => !plan.deleteIds.includes(row.id) && (row.source !== 'estimated' || isProtectedSpan(row))).length;
  const insertedCount = plan.inserts.filter(row => row.source !== 'estimated' || isProtectedSpan(row)).length;
  return retainedCount + insertedCount;
}

export type ApplyTariffSelectionCandidate =
  | {
      kind: 'manual';
      name: string;
      seasons: TariffSeasonInput[];
      holidaysUseWeekendSchedule?: boolean;
    }
  | {
      kind: 'public';
      name: string;
      seasons: TariffSeasonInput[];
      urdbLabel: string;
      utilityName: string | null;
      revisionStart: string | null;
      exportRateProvenance: ExportRateProvenance;
      approximationNotes?: TariffApproximationNote[];
      holidaysUseWeekendSchedule?: boolean;
    }
  | {
      kind: 'restore_tesla';
      originalSelectionId: number;
    };

export interface ApplyTariffSelectionInput {
  scope: TariffSelectionScope;
  effectiveFrom: string;
  effectiveTo: string | null;
  userId: string;
  verifiedAgainstBill: boolean;
  candidate: ApplyTariffSelectionCandidate;
  candidateKindOverride?: TariffSelectionCandidateKind;
  allowMinuteResolution?: boolean;
  reviewHash?: string | null;
}

export interface ApplyTariffSelectionResult {
  selectionIds: number[];
  tariffIds: number[];
  createdNewTariffVersion: boolean;
  unchanged: boolean;
  reattributionRange: { fromDate: string; toDate: string | null } | null;
}

export interface SelectionAuditRecord {
  selection: TariffSelectionRow;
  originals: TariffSelectionOriginalRow[];
  verification: (TariffSelectionVerificationRow & { verifiedByEmail: string | null; verifiedByCurrentUser: boolean }) | null;
}

function parseApproximationNotes(raw: unknown): TariffApproximationNote[] {
  if (!Array.isArray(raw)) return [];
  const out: TariffApproximationNote[] = [];
  for (const item of raw) {
    if (
      item &&
      typeof item === 'object' &&
      'kind' in item &&
      'message' in item &&
      typeof item.kind === 'string' &&
      typeof item.message === 'string'
    ) {
      out.push({ kind: item.kind as TariffApproximationNote['kind'], message: item.message });
    }
  }
  return out;
}

function computeFallbackTariffHash(tariff: Tariff): string {
  const seasons = (tariff.seasons ?? []).map(s => ({
    name: s.name ?? 'Season',
    from_month: s.from_month,
    from_day: s.from_day,
    to_month: s.to_month,
    to_day: s.to_day,
    buy_rate: s.buy_rate,
    sell_rate: s.sell_rate,
    schedules: (s.schedules ?? []).map(sch => ({
      name: sch.name ?? 'OFF_PEAK',
      buy_rate: sch.buy_rate ?? s.buy_rate,
      sell_rate: sch.sell_rate ?? s.sell_rate,
      from_day_of_week: sch.from_day_of_week ?? 0,
      to_day_of_week: sch.to_day_of_week ?? 6,
      from_hour: sch.from_hour ?? 0,
      from_minute: sch.from_minute ?? 0,
      to_hour: sch.to_hour ?? 24,
      to_minute: sch.to_minute ?? 0,
    })),
  }));
  return tariffContentHash({ name: tariff.name ?? 'Rate Plan', seasons });
}

async function planNameTakenAfterReplacement(
  client: Pick<PoolClient, 'query'>,
  existing: ExistingSpan[],
  siteId: string,
  name: string,
  effectiveFrom: string,
  effectiveTo: string | null,
  exceptTariffId: number | null
): Promise<boolean> {
  const targetNorm = name.trim().toLowerCase();
  const remainingTariffIds = new Set<number>();
  for (const span of existing) {
    if (span.source === 'estimated') continue;
    if (exceptTariffId !== null && span.tariffId === exceptTariffId) continue;
    const fullyReplaced =
      span.effectiveFrom >= effectiveFrom &&
      (effectiveTo === null || (span.effectiveTo !== null && span.effectiveTo <= effectiveTo));
    if (!fullyReplaced) {
      remainingTariffIds.add(span.tariffId);
    }
  }
  if (remainingTariffIds.size === 0) return false;
  const res = await client.query<{ id: number }>(
    `SELECT id FROM "Tariff" WHERE site_id = $1 AND id = ANY($2::int[]) AND lower(btrim(name)) = $3 LIMIT 1`,
    [siteId, [...remainingTariffIds], targetNorm]
  );
  return (res.rowCount ?? 0) > 0;
}

async function loadScopePeriodRows(
  queryable: Pick<PoolClient, 'query'>,
  siteId: string,
  scope: TariffSelectionScope
): Promise<PeriodQueryRow[]> {
  const table = scope === 'actual' ? '"TariffEffectivePeriod"' : '"TariffReferencePeriod"';
  const anchorSelect = scope === 'actual'
    ? `us.start_source, us.start_date::text AS anchor_start,
       EXISTS (SELECT 1 FROM "TariffUrdbSource" oh WHERE oh.tariff_id = p.tariff_id AND oh.role = 'owner_history') AS owner_history,`
    : `NULL::text AS start_source, NULL::text AS anchor_start, FALSE AS owner_history,`;
  const anchorJoin = scope === 'actual'
    ? `LEFT JOIN "TariffUrdbSource" us ON us.tariff_id = p.tariff_id AND us.role = 'tesla_anchor'`
    : '';
  const pubRoles = scope === 'actual'
    ? `('estimated_actual', 'owner_selection')`
    : `('estimated_reference', 'owner_selection')`;
  const order = scope === 'actual' ? 'DESC' : 'ASC';

  const res = await queryable.query<PeriodQueryRow>(
    `SELECT p.id AS period_id, p.tariff_id, p.effective_from::text, p.effective_to::text,
            p.source, p.updated_by_user_id, u.email AS updated_by_email,
            t.name, t.version, t.content_hash,
            ${anchorSelect}
            p.selection_id,
            sel.choice_kind,
            sel.candidate_kind,
            sel.selected_by_user_id,
            COALESCE(sel.urdb_label, pub_us.urdb_label) AS urdb_label,
            sel.utility_name,
            COALESCE(sel.revision_start::text, pub_us.revision_start::text) AS revision_start,
            sel.export_rate_provenance,
            sel.holidays_use_weekend,
            sel.approximation_notes,
            ver.verified_at,
            ver.verified_by_user_id,
            vu.email AS verified_by_email,
            ver.tariff_id AS verified_tariff_id,
            ver.tariff_content_hash AS verified_content_hash,
            ver.effective_from::text AS verified_effective_from,
            ver.effective_to::text AS verified_effective_to
     FROM ${table} p
     JOIN "Tariff" t ON t.id = p.tariff_id
     ${anchorJoin}
     LEFT JOIN "TariffUrdbSource" pub_us ON pub_us.tariff_id = p.tariff_id AND pub_us.role IN ${pubRoles}
     LEFT JOIN "TariffSelection" sel ON sel.id = p.selection_id
     LEFT JOIN "TariffSelectionVerification" ver
       ON ver.selection_id = p.selection_id
      AND ver.tariff_id = p.tariff_id
      AND t.content_hash IS NOT NULL
      AND ver.tariff_content_hash = t.content_hash
      AND ver.effective_from = p.effective_from
      AND ver.effective_to IS NOT DISTINCT FROM p.effective_to
     LEFT JOIN "User" vu ON vu.id = ver.verified_by_user_id
     LEFT JOIN "User" u ON u.id = COALESCE(sel.selected_by_user_id, p.updated_by_user_id)
     WHERE p.site_id = $1
     ORDER BY p.effective_from ${order}, p.id ${order}`,
    [siteId]
  );
  return res.rows;
}

/** The review compares Monday for weekdays and Saturday for weekends; say so when that hides days. */
export function daySpecificScheduleNote(planName: string): TariffApproximationNote {
  return {
    kind: 'day_specific_schedule',
    message: `${planName} has rates for specific days of the week. This review shows its Monday rates for weekdays `
      + 'and its Saturday rates for weekends; bills use the rates for each actual day.',
  };
}

function buildSnapshotFromRow(
  row: PeriodQueryRow,
  tariff: Tariff | undefined,
  viewerUserId: string | null,
  defaultUtilityName: string | null
): TariffReviewPlanSnapshot {
  const effectiveFrom = row.effective_from.slice(0, 10);
  const effectiveTo = row.effective_to ? row.effective_to.slice(0, 10) : null;
  const choiceKind: TariffSelectionChoiceKind = row.choice_kind
    ?? (row.source === 'manual' || Boolean(row.updated_by_user_id) ? 'owner' : 'automatic');
  const exportRateProvenance: ExportRateProvenance = row.export_rate_provenance
    ?? (row.source === 'tesla' ? 'tesla' : row.source === 'estimated' ? 'published' : 'manual');
  return {
    tariffId: Number(row.tariff_id),
    version: Number(row.version ?? tariff?.version ?? 1),
    periodId: Number(row.period_id),
    selectionId: row.selection_id !== undefined && row.selection_id !== null ? Number(row.selection_id) : null,
    name: row.name || tariff?.name || 'Rate Plan',
    utilityName: row.utility_name ?? (row.source === 'estimated' ? defaultUtilityName : null),
    source: row.source,
    choiceKind,
    urdbLabel: row.urdb_label ?? null,
    revisionStart: row.revision_start ? row.revision_start.slice(0, 10) : null,
    contentHash: row.content_hash ?? tariff?.content_hash ?? null,
    exportRateProvenance,
    holidaysUseWeekendSchedule: row.holidays_use_weekend ?? true,
    seasons: tariff ? decompileTariffToSeasons(tariff) : [],
    approximationNotes: [
      ...parseApproximationNotes(row.approximation_notes),
      ...(tariff && tariffHasDaySpecificSchedules(tariff) ? [daySpecificScheduleNote(row.name || tariff.name || 'This plan')] : []),
    ],
    verification: resolveVerifiedSummary(row, effectiveFrom, effectiveTo, viewerUserId),
  };
}

interface ScopeSelectionOriginalEntry {
  effectiveFrom: string;
  effectiveTo: string | null;
  ref: TariffRestorationOriginalRef;
}

function partitionPeriodSpanWithOriginals(
  effectiveFrom: string,
  effectiveTo: string | null,
  plan: TariffReviewPlanSnapshot,
  origCandidates: ScopeSelectionOriginalEntry[]
): ExistingTimelineSpanInput[] {
  const overlapping = origCandidates.filter(o =>
    spansOverlapDates(o.effectiveFrom, o.effectiveTo, effectiveFrom, effectiveTo)
  );
  if (overlapping.length === 0) {
    return [{ effectiveFrom, effectiveTo, plan }];
  }

  const starts = new Set<string>([effectiveFrom]);
  for (const orig of overlapping) {
    const clipFrom = orig.effectiveFrom >= effectiveFrom ? orig.effectiveFrom : effectiveFrom;
    const clipTo = minNullableEnd(orig.effectiveTo, effectiveTo);
    if (clipTo !== null && clipFrom > clipTo) continue;
    starts.add(clipFrom);
    if (clipTo !== null && (effectiveTo === null || clipTo < effectiveTo)) {
      starts.add(addCalendarDays(clipTo, 1));
    }
  }

  const sortedStarts = [...starts].sort((a, b) => a.localeCompare(b));
  const out: ExistingTimelineSpanInput[] = [];
  for (let i = 0; i < sortedStarts.length; i++) {
    const segFrom = sortedStarts[i];
    const segTo = i + 1 < sortedStarts.length ? addCalendarDays(sortedStarts[i + 1], -1) : effectiveTo;
    if (segTo !== null && segFrom > segTo) continue;
    const matchingOrig = overlapping.find(
      o => o.effectiveFrom <= segFrom && (o.effectiveTo === null || o.effectiveTo >= segFrom)
    );
    out.push({
      effectiveFrom: segFrom,
      effectiveTo: segTo,
      plan,
      preservedTeslaOriginal: matchingOrig
        ? {
            ...matchingOrig.ref,
            effectiveFrom: segFrom,
            effectiveTo: segTo,
          }
        : null,
    });
  }
  return out;
}

export async function loadScopeSelectionSpans(
  queryable: Pick<PoolClient, 'query'>,
  siteId: string,
  scope: TariffSelectionScope,
  viewerUserId: string | null
): Promise<ExistingTimelineSpanInput[]> {
  const rows = await loadScopePeriodRows(queryable, siteId, scope);
  if (rows.length === 0) return [];
  const tariffIds = [...new Set(rows.map(r => Number(r.tariff_id)))];
  const selectionIds = [...new Set(
    rows
      .filter(r => r.selection_id !== undefined && r.selection_id !== null)
      .map(r => Number(r.selection_id))
  )];
  // Sequential, not Promise.all: `queryable` may be one transaction client, and pg deprecates
  // overlapping queries on a single client (removed in pg@9).
  const tariffMap = await hydrateTariffs(queryable, tariffIds);
  const utilityRes = await queryable.query<{ urdb_utility: string | null }>(
    'SELECT urdb_utility FROM "SiteUtility" WHERE site_id = $1',
    [siteId]
  );
  const originalsRes = await (
    selectionIds.length > 0
      ? queryable.query<{
          selection_id: number;
          effective_from: string;
          effective_to: string | null;
          original_tariff_id: number;
          original_selection_id: number | null;
          name: string;
          version: number;
          content_hash: string | null;
        }>(
          `SELECT o.selection_id, o.effective_from::text, o.effective_to::text,
                  o.original_tariff_id, o.original_selection_id,
                  t.name, t.version, t.content_hash
           FROM "TariffSelectionOriginal" o
           JOIN "Tariff" t ON t.id = o.original_tariff_id
           WHERE o.selection_id = ANY($1::int[])
           ORDER BY o.effective_from ASC, o.id ASC`,
          [selectionIds]
        )
      : Promise.resolve({ rows: [] })
  );
  const defaultUtilityName = utilityRes.rows[0]?.urdb_utility ?? null;

  const originalsBySelection = new Map<number, ScopeSelectionOriginalEntry[]>();
  for (const orig of originalsRes.rows) {
    const sid = Number(orig.selection_id);
    const list = originalsBySelection.get(sid) ?? [];
    const from = orig.effective_from.slice(0, 10);
    const to = orig.effective_to ? orig.effective_to.slice(0, 10) : null;
    list.push({
      effectiveFrom: from,
      effectiveTo: to,
      ref: {
        // Expose the owning override selection_id so restoring always recovers every replaced interval under this override.
        originalSelectionId: sid,
        tariffId: Number(orig.original_tariff_id),
        name: orig.name,
        version: Number(orig.version),
        contentHash: orig.content_hash,
        effectiveFrom: from,
        effectiveTo: to,
      },
    });
    originalsBySelection.set(sid, list);
  }

  return [...rows]
    .sort((a, b) => a.effective_from.localeCompare(b.effective_from) || Number(a.period_id) - Number(b.period_id))
    .flatMap(row => {
      const effectiveFrom = row.effective_from.slice(0, 10);
      const effectiveTo = row.effective_to ? row.effective_to.slice(0, 10) : null;
      const plan = buildSnapshotFromRow(row, tariffMap.get(Number(row.tariff_id)), viewerUserId, defaultUtilityName);
      const origCandidates = plan.selectionId !== null ? (originalsBySelection.get(plan.selectionId) ?? []) : [];
      return partitionPeriodSpanWithOriginals(effectiveFrom, effectiveTo, plan, origCandidates);
    });
}

export async function loadRestorationTargets(
  queryable: Pick<PoolClient, 'query'>,
  siteId: string,
  scope: TariffSelectionScope,
  originalSelectionId: number,
  effectiveFrom: string,
  effectiveTo: string | null
): Promise<RestorationTargetSpanInput[]> {
  if (scope !== 'actual') return [];

  let rows = (await queryable.query<{
    selection_id: number;
    effective_from: string;
    effective_to: string | null;
    original_tariff_id: number;
    original_selection_id: number | null;
  }>(
    `SELECT selection_id, effective_from::text, effective_to::text, original_tariff_id, original_selection_id
     FROM "TariffSelectionOriginal"
     WHERE site_id = $1 AND scope = $2 AND selection_id = $3
     ORDER BY effective_from ASC, id ASC`,
    [siteId, scope, originalSelectionId]
  )).rows;

  if (rows.length === 0) {
    rows = (await queryable.query<{
      selection_id: number;
      effective_from: string;
      effective_to: string | null;
      original_tariff_id: number;
      original_selection_id: number | null;
    }>(
      `SELECT selection_id, effective_from::text, effective_to::text, original_tariff_id, original_selection_id
       FROM "TariffSelectionOriginal"
       WHERE site_id = $1 AND scope = $2 AND original_selection_id = $3
       ORDER BY effective_from ASC, id ASC`,
      [siteId, scope, originalSelectionId]
    )).rows;
  }

  if (rows.length === 0) {
    const directSel = (await queryable.query<{
      id: number;
      tariff_id: number;
      effective_from: string;
      effective_to: string | null;
    }>(
      `SELECT id, tariff_id, effective_from::text, effective_to::text
       FROM "TariffSelection"
       WHERE id = $1 AND site_id = $2 AND scope = $3 AND source = 'tesla'`,
      [originalSelectionId, siteId, scope]
    )).rows;
    rows = directSel.map(r => ({
      selection_id: Number(r.id),
      effective_from: r.effective_from,
      effective_to: r.effective_to,
      original_tariff_id: Number(r.tariff_id),
      original_selection_id: Number(r.id),
    }));
  }

  const rawClipped = rows
    .map(r => {
      const rFrom = r.effective_from.slice(0, 10);
      const rTo = r.effective_to ? r.effective_to.slice(0, 10) : null;
      if (!spansOverlapDates(rFrom, rTo, effectiveFrom, effectiveTo)) return null;
      const segFrom = rFrom >= effectiveFrom ? rFrom : effectiveFrom;
      const segTo = minNullableEnd(rTo, effectiveTo);
      if (segTo !== null && segFrom > segTo) return null;
      return {
        segFrom,
        segTo,
        originalTariffId: Number(r.original_tariff_id),
        originalSelectionId: r.original_selection_id === null ? Number(r.selection_id) : Number(r.original_selection_id),
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((a, b) => a.segFrom.localeCompare(b.segFrom) || a.originalTariffId - b.originalTariffId);

  const clipped: typeof rawClipped = [];
  for (const cur of rawClipped) {
    const prev = clipped.at(-1);
    if (
      prev &&
      prev.originalTariffId === cur.originalTariffId &&
      prev.originalSelectionId === cur.originalSelectionId &&
      (prev.segTo === null || cur.segFrom <= addCalendarDays(prev.segTo, 1))
    ) {
      prev.segTo = maxEnd(prev.segTo, cur.segTo);
    } else {
      clipped.push({ ...cur });
    }
  }

  if (clipped.length === 0) return [];
  const tariffMap = await hydrateTariffs(queryable, [...new Set(clipped.map(c => c.originalTariffId))]);

  return clipped.map(item => {
    const tariff = tariffMap.get(item.originalTariffId);
    if (!tariff) {
      throw new TariffNotFoundError(`Original Tesla tariff ${item.originalTariffId} not found`);
    }
    const contentHash = tariff.content_hash ?? computeFallbackTariffHash(tariff);
    const snapshot: TariffReviewPlanSnapshot = {
      tariffId: tariff.id,
      version: tariff.version ?? 1,
      periodId: null,
      selectionId: item.originalSelectionId,
      name: tariff.name || 'Tesla Rate Plan',
      utilityName: null,
      source: 'tesla',
      choiceKind: 'owner',
      urdbLabel: null,
      revisionStart: null,
      contentHash,
      exportRateProvenance: 'tesla',
      holidaysUseWeekendSchedule: true,
      seasons: decompileTariffToSeasons(tariff),
      approximationNotes: [],
      verification: null,
    };
    return {
      effectiveFrom: item.segFrom,
      effectiveTo: item.segTo,
      original: {
        originalSelectionId: item.originalSelectionId,
        tariffId: tariff.id,
        name: snapshot.name,
        version: snapshot.version,
        contentHash,
        effectiveFrom: item.segFrom,
        effectiveTo: item.segTo,
      },
      plan: snapshot,
    };
  });
}

/** A fixed comparison plan the owner chose for one period of the rate plan history guide. */
export type FixedComparisonWrite = { from: string; to: string | null } & (
  | { kind: 'public'; revisions: ExpandedRevision[]; label?: string }
  | { kind: 'manual'; name: string; buyRate: number; sellRate: number }
);

/**
 * Follows `label` as the owner's fixed comparison plan from `from` onward: the estimate job lays its
 * revisions as the open-ended reference, so this also clears any owner reference period over that range.
 */
export async function setFollowedReferenceLabelOnClient(client: PoolClient, siteId: string, userId: string, label: string, from: string): Promise<void> {
  const updated = await client.query(
    `UPDATE "SiteUtility" SET urdb_reference_label = $2, urdb_reference_from = $3::date, status = 'pending', attempt_count = 0, next_check_at = NULL, updated_by_user_id = $4, updated_at = now()
     WHERE site_id = $1 AND choice <> 'skipped'`,
    [siteId, label, from, userId]
  );
  if (!updated.rowCount) throw new UtilityChangedError('Utility changed. Start again.');
  const owned = `(p.source <> 'estimated' OR EXISTS (SELECT 1 FROM "TariffSelection" s WHERE s.id = p.selection_id AND s.choice_kind = 'owner'))`;
  await client.query(`DELETE FROM "TariffReferencePeriod" p WHERE p.site_id = $1 AND p.effective_from >= $2::date AND ${owned}`, [siteId, from]);
  await client.query(
    `UPDATE "TariffReferencePeriod" p SET effective_to = ($2::date - 1) WHERE p.site_id = $1 AND p.effective_from < $2::date AND (p.effective_to IS NULL OR p.effective_to >= $2::date) AND ${owned}`,
    [siteId, from]
  );
  await bumpSiteTimelineRevisionOnClient(client, siteId);
}

const flatFixedSeasons = (buyRate: number, sellRate: number): TariffSeasonInput[] => {
  const window = { touName: 'OFF_PEAK' as const, fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate, sellRate };
  return [{ name: 'All Year', fromMonth: 1, toMonth: 12, weekdayPeriods: [window], weekendPeriods: [window] }];
};

/** Writes the owner's fixed comparison plans; open utility plans are followed, everything else becomes an owner reference period. */
async function writeFixedComparisonsOnClient(client: PoolClient, siteId: string, userId: string, today: string, utility: string, fixed: FixedComparisonWrite[]): Promise<void> {
  for (const write of fixed) {
    if (write.kind === 'public' && write.to === null) {
      const label = write.label ?? write.revisions.find(revision => revision.to === null)?.label ?? write.revisions.at(-1)?.label;
      if (!label) throw new TariffValidationError('Choose a fixed comparison plan.');
      await setFollowedReferenceLabelOnClient(client, siteId, userId, label, write.from);
      continue;
    }
    const candidates = write.kind === 'public'
      ? write.revisions.map(revision => ({
        from: revision.from,
        to: revision.to,
        candidate: { kind: 'public' as const, name: revision.name, seasons: revision.seasons, urdbLabel: revision.label, utilityName: utility, revisionStart: revision.revisionStart, exportRateProvenance: 'published' as const },
      }))
      : [{ from: write.from, to: write.to, candidate: { kind: 'manual' as const, name: write.name, seasons: flatFixedSeasons(write.buyRate, write.sellRate) } }];
    for (const { from, to, candidate } of candidates) {
      await applyTariffSelectionOnClient(client, siteId, today, { scope: 'reference', effectiveFrom: from, effectiveTo: to, userId, verifiedAgainstBill: false, candidate });
    }
    // A manual plan from `from` onward replaces whatever a followed label would lay from that day.
    if (write.kind === 'manual' && write.to === null) {
      await client.query(`UPDATE "SiteUtility" SET urdb_reference_label = NULL, urdb_reference_from = NULL WHERE site_id = $1 AND urdb_reference_from >= $2::date`, [siteId, write.from]);
    }
  }
}

export async function applyTariffSelectionOnClient(
  client: PoolClient,
  siteId: string,
  today: string,
  input: ApplyTariffSelectionInput
): Promise<ApplyTariffSelectionResult> {
  const { scope, effectiveFrom, effectiveTo, userId, verifiedAgainstBill, candidate, reviewHash } = input;
  validateEffectiveDates(effectiveFrom, effectiveTo, today);
  if (scope === 'reference' && candidate.kind === 'restore_tesla') {
    throw new TariffValidationError('Tesla restoration is only available for your rate plan.');
  }

  let existing = await loadScopeSpans(client, siteId, scope);
  const selectionIds: number[] = [];
  const createdSelectionIds: number[] = [];
  let createdSelectionCount = 0;
  const touchedTariffIds: number[] = [];
  let createdNewTariffVersion = false;
  let reattributionFrom: string | null = null;
  let reattributionTo: string | null = null;
  let anyTimelineChange = false;

  const trackReattribution = (from: string, to: string | null) => {
    if (scope !== 'actual') return;
    if (reattributionFrom === null) {
      reattributionFrom = from;
      reattributionTo = to;
      return;
    }
    reattributionFrom = minDate(reattributionFrom, from);
    reattributionTo = maxEnd(reattributionTo, to);
  };

  if (candidate.kind === 'restore_tesla') {
    const targets = await loadRestorationTargets(
      client,
      siteId,
      scope,
      candidate.originalSelectionId,
      effectiveFrom,
      effectiveTo
    );
    if (targets.length === 0) {
      throw new TariffValidationError('No saved Tesla rate plan exists for this date range.');
    }

    for (const target of targets) {
      const tariffId = target.original.tariffId;
      const hash = target.original.contentHash;
      if (!hash) {
        throw new TariffValidationError('Saved Tesla tariff is missing a content hash');
      }
      touchedTariffIds.push(tariffId);

      const exactExisting = existing.find(
        s => s.effectiveFrom === target.effectiveFrom && s.effectiveTo === target.effectiveTo
          && s.tariffId === tariffId && s.source === 'tesla' && s.choiceKind === 'owner'
      );
      if (exactExisting && exactExisting.selectionId != null) {
        const verRes = await client.query<{ verified_by_user_id: string | null }>(
          `SELECT verified_by_user_id FROM "TariffSelectionVerification"
           WHERE selection_id = $1 AND tariff_id = $2 AND tariff_content_hash = $3
             AND effective_from = $4::date AND effective_to IS NOT DISTINCT FROM $5::date`,
          [exactExisting.selectionId, tariffId, hash, target.effectiveFrom, target.effectiveTo]
        );
        const curVer = verRes.rows[0];
        const verificationMatches = verifiedAgainstBill
          ? Boolean(curVer && curVer.verified_by_user_id === userId)
          : !curVer;
        if (verificationMatches) {
          selectionIds.push(exactExisting.selectionId);
          continue;
        }
      }

      const selectionId = await insertTariffSelectionOnClient(client, {
        siteId,
        scope,
        tariffId,
        effectiveFrom: target.effectiveFrom,
        effectiveTo: target.effectiveTo,
        source: 'tesla',
        choiceKind: 'owner',
        candidateKind: 'restore_tesla',
        selectedByUserId: userId,
        exportRateProvenance: 'tesla',
        selectedContentHash: hash,
        restoredFromSelectionId: candidate.originalSelectionId,
        reviewHash: reviewHash ?? null,
      });
      if (selectionId !== null) {
        selectionIds.push(selectionId);
        createdSelectionIds.push(selectionId);
        createdSelectionCount += 1;
      }
      if (verifiedAgainstBill && selectionId !== null) {
        await insertSelectionVerificationOnClient(client, {
          selectionId,
          siteId,
          scope,
          tariffId,
          tariffContentHash: hash,
          effectiveFrom: target.effectiveFrom,
          effectiveTo: target.effectiveTo,
          verifiedByUserId: userId,
        });
      }

      if (exactExisting && selectionId !== null) {
        await client.query(
          `UPDATE "TariffEffectivePeriod" SET selection_id = $3, updated_by_user_id = $4 WHERE site_id = $1 AND id = $2`,
          [siteId, exactExisting.id, selectionId, userId]
        );
        existing = await loadScopeSpans(client, siteId, scope);
      } else {
        const plan = computeSpanMutations(existing, {
          tariffId,
          source: 'tesla',
          effectiveFrom: target.effectiveFrom,
          effectiveTo: target.effectiveTo,
          updatedByUserId: userId,
          ...(selectionId !== null ? { selectionId, choiceKind: 'owner' as const } : {}),
        });
        if (countProtectedResultingSpans(existing, plan) > MAX_EFFECTIVE_PERIODS_PER_SITE) {
          throw new TariffValidationError(`Cannot exceed ${MAX_EFFECTIVE_PERIODS_PER_SITE} effective periods per site`);
        }
        await applyScopeSpanMutationPlan(client, siteId, scope, plan);
        existing = await loadScopeSpans(client, siteId, scope);
        anyTimelineChange = true;
        trackReattribution(target.effectiveFrom, target.effectiveTo);
      }
    }
  } else {
    const validated = validateTariffPlanInput({
      name: candidate.name,
      effectiveFrom,
      effectiveTo,
      seasons: candidate.seasons,
    }, today, { allowMinuteResolution: input.allowMinuteResolution });
    const parsed = compileSeasonsToParsedTariff(validated.name, validated.seasons);
    const newHash = tariffContentHash(parsed);
    const targetSource: TariffSource = candidate.kind === 'public' ? 'estimated' : 'manual';
    const expectedUrdbRole = scope === 'actual' ? 'estimated_actual' : 'estimated_reference';

    let tariffId: number;
    if (candidate.kind === 'public') {
      const existingTariff = (await client.query<{ id: number; has_urdb: boolean }>(
        `SELECT t.id, (u.tariff_id IS NOT NULL) AS has_urdb
         FROM "Tariff" t
         LEFT JOIN "TariffUrdbSource" u ON u.tariff_id = t.id
         WHERE t.site_id = $1 AND t.source = 'estimated' AND t.name = $2 AND t.content_hash = $3
           AND (u.tariff_id IS NULL OR (u.urdb_label = $4 AND u.role IN ($5, 'owner_selection')))
         ORDER BY (u.role = $5) DESC, t.id DESC
         LIMIT 1`,
        [siteId, validated.name, newHash, candidate.urdbLabel, expectedUrdbRole]
      )).rows[0];
      if (existingTariff) {
        tariffId = Number(existingTariff.id);
        if (!existingTariff.has_urdb) {
          await client.query(
            `INSERT INTO "TariffUrdbSource" (tariff_id, site_id, role, urdb_label, start_date, end_date, start_source, revision_start, is_current_estimate)
             VALUES ($1, $2, $3, $4, $5::date, $6::date, 'urdb', $7::date, FALSE)
             ON CONFLICT (tariff_id) DO NOTHING`,
            [tariffId, siteId, expectedUrdbRole, candidate.urdbLabel, effectiveFrom, effectiveTo, candidate.revisionStart]
          );
        }
      } else {
        tariffId = await insertTariffGraph(client, siteId, parsed, 'estimated', userId, false, newHash);
        createdNewTariffVersion = true;
        await client.query(
          `INSERT INTO "TariffUrdbSource" (tariff_id, site_id, role, urdb_label, start_date, end_date, start_source, revision_start, is_current_estimate)
           VALUES ($1, $2, $3, $4, $5::date, $6::date, 'urdb', $7::date, FALSE)`,
          [tariffId, siteId, expectedUrdbRole, candidate.urdbLabel, effectiveFrom, effectiveTo, candidate.revisionStart]
        );
      }
    } else {
      const existingTariff = (await client.query<{ id: number }>(
        `SELECT id FROM "Tariff"
         WHERE site_id = $1 AND source = 'manual' AND name = $2 AND content_hash = $3
         ORDER BY id DESC LIMIT 1`,
        [siteId, validated.name, newHash]
      )).rows[0];
      if (existingTariff) {
        tariffId = Number(existingTariff.id);
        if (scope === 'actual' && await planNameTakenAfterReplacement(client, existing, siteId, validated.name, effectiveFrom, effectiveTo, tariffId)) {
          throw new TariffValidationError(`A rate plan named "${validated.name.trim()}" already exists. Choose a different name.`);
        }
      } else {
        if (scope === 'actual' && await planNameTakenAfterReplacement(client, existing, siteId, validated.name, effectiveFrom, effectiveTo, null)) {
          throw new TariffValidationError(`A rate plan named "${validated.name.trim()}" already exists. Choose a different name.`);
        }
        tariffId = await insertTariffGraph(client, siteId, parsed, 'manual', userId, false, newHash);
        createdNewTariffVersion = true;
      }
    }
    touchedTariffIds.push(tariffId);

    const exactExisting = existing.find(
      s => s.effectiveFrom === effectiveFrom && s.effectiveTo === effectiveTo
        && s.tariffId === tariffId && s.source === targetSource && s.choiceKind === 'owner'
    );
    if (exactExisting && exactExisting.selectionId != null) {
      const selRes = await client.query<{
        urdb_label: string | null;
        utility_name: string | null;
        revision_start: string | null;
        export_rate_provenance: ExportRateProvenance;
        holidays_use_weekend: boolean;
      }>(
        `SELECT urdb_label, utility_name, revision_start::text, export_rate_provenance, holidays_use_weekend
         FROM "TariffSelection" WHERE id = $1`,
        [exactExisting.selectionId]
      );
      const verRes = await client.query<{ verified_by_user_id: string | null }>(
        `SELECT verified_by_user_id FROM "TariffSelectionVerification"
         WHERE selection_id = $1 AND tariff_id = $2 AND tariff_content_hash = $3
           AND effective_from = $4::date AND effective_to IS NOT DISTINCT FROM $5::date`,
        [exactExisting.selectionId, tariffId, newHash, effectiveFrom, effectiveTo]
      );
      const curSel = selRes.rows[0];
      const curVer = verRes.rows[0];
      const expectedExport = candidate.kind === 'public' ? candidate.exportRateProvenance : 'manual';
      const expectedUrdb = candidate.kind === 'public' ? candidate.urdbLabel : null;
      const expectedUtility = candidate.kind === 'public' ? candidate.utilityName : null;
      const expectedRev = candidate.kind === 'public' ? candidate.revisionStart : null;
      const expectedHol = candidate.holidaysUseWeekendSchedule ?? true;

      const metadataMatches = Boolean(
        curSel &&
        curSel.urdb_label === expectedUrdb &&
        curSel.utility_name === expectedUtility &&
        (curSel.revision_start ? curSel.revision_start.slice(0, 10) : null) === expectedRev &&
        curSel.export_rate_provenance === expectedExport &&
        curSel.holidays_use_weekend === expectedHol
      );
      const verificationMatches = verifiedAgainstBill
        ? Boolean(curVer && curVer.verified_by_user_id === userId)
        : !curVer;
      if (metadataMatches && verificationMatches) {
        return {
          selectionIds: [exactExisting.selectionId],
          tariffIds: touchedTariffIds,
          createdNewTariffVersion: false,
          unchanged: true,
          reattributionRange: null,
        };
      }
    }

    const replacedOriginals = scope === 'actual'
      ? await collectReplacedOriginalsOnClient(client, existing, effectiveFrom, effectiveTo)
      : [];
    const selectionId = await insertTariffSelectionOnClient(client, {
      siteId,
      scope,
      tariffId,
      effectiveFrom,
      effectiveTo,
      source: targetSource,
      choiceKind: 'owner',
      candidateKind: input.candidateKindOverride ?? candidate.kind,
      selectedByUserId: userId,
      urdbLabel: candidate.kind === 'public' ? candidate.urdbLabel : null,
      utilityName: candidate.kind === 'public' ? candidate.utilityName : null,
      revisionStart: candidate.kind === 'public' ? candidate.revisionStart : null,
      exportRateProvenance: candidate.kind === 'public' ? candidate.exportRateProvenance : 'manual',
      holidaysUseWeekend: candidate.holidaysUseWeekendSchedule ?? true,
      approximationNotes: candidate.kind === 'public' ? (candidate.approximationNotes ?? []) : [],
      selectedContentHash: newHash,
      reviewHash: reviewHash ?? null,
    });
    if (selectionId !== null) {
      selectionIds.push(selectionId);
      createdSelectionIds.push(selectionId);
      createdSelectionCount += 1;
    }
    await storeSelectionOriginalsOnClient(client, siteId, scope, selectionId, replacedOriginals);

    if (verifiedAgainstBill && selectionId !== null) {
      await insertSelectionVerificationOnClient(client, {
        selectionId,
        siteId,
        scope,
        tariffId,
        tariffContentHash: newHash,
        effectiveFrom,
        effectiveTo,
        verifiedByUserId: userId,
      });
    }

    if (exactExisting && selectionId !== null) {
      // Only verification or selection provenance changed on an identical span; update selection_id in place.
      const table = scope === 'actual' ? '"TariffEffectivePeriod"' : '"TariffReferencePeriod"';
      await client.query(
        `UPDATE ${table} SET selection_id = $3, updated_by_user_id = $4 WHERE site_id = $1 AND id = $2`,
        [siteId, exactExisting.id, selectionId, userId]
      );
    } else {
      const plan = computeSpanMutations(existing, {
        tariffId,
        source: targetSource,
        effectiveFrom,
        effectiveTo,
        updatedByUserId: userId,
        ...(selectionId !== null ? { selectionId, choiceKind: 'owner' as const } : {}),
      });
      if (countProtectedResultingSpans(existing, plan) > MAX_EFFECTIVE_PERIODS_PER_SITE) {
        throw new TariffValidationError(`Cannot exceed ${MAX_EFFECTIVE_PERIODS_PER_SITE} effective periods per site`);
      }
      await applyScopeSpanMutationPlan(client, siteId, scope, plan);
      anyTimelineChange = true;
      trackReattribution(effectiveFrom, effectiveTo);
    }
  }

  if (anyTimelineChange) {
    if (scope === 'actual') {
      const estimateChanges = (await applyEstimatesOnClient(client, siteId, today)).changed;
      for (const range of estimateChanges) {
        trackReattribution(range.from, range.to);
      }
      await client.query(
        `UPDATE "SiteUtility" SET status = 'pending', next_check_at = NULL, updated_at = now()
         WHERE site_id = $1 AND status = 'needs_plan'`,
        [siteId]
      );
    } else {
      await applyEstimatesOnClient(client, siteId, today, 'reference');
    }
  }

  const unchanged = !anyTimelineChange && createdSelectionCount === 0;
  if (!unchanged) {
    const timelineRevision = await bumpSiteTimelineRevisionOnClient(client, siteId);
    if (timelineRevision !== null && createdSelectionIds.length > 0) {
      await client.query(
        `UPDATE "TariffSelection" SET timeline_revision = $2 WHERE id = ANY($1::int[])`,
        [createdSelectionIds, timelineRevision]
      );
    }
  }

  return {
    selectionIds,
    tariffIds: [...new Set(touchedTariffIds)],
    createdNewTariffVersion,
    unchanged,
    reattributionRange: reattributionFrom !== null ? { fromDate: reattributionFrom, toDate: reattributionTo } : null,
  };
}

export interface SiteUtilityContextResult {
  name: string | null;
  timezone: string;
  currency?: string;
  choice?: 'auto' | 'owner' | 'skipped' | null;
  rateCountry?: string | null;
  rateCountrySource?: RateCountrySource | null;
  rateCountryUpdatedAt?: string | null;
  eligibility?: RatePlanEligibility;
}

export interface SitePublicConversionContext {
  fallbackSellRate: number;
  hasTeslaSellFallback: boolean;
}

export interface SelectionTimelineSnapshot {
  fallbackSellRate: number;
  hasTeslaSellFallback: boolean;
  existingSpans: ExistingTimelineSpanInput[];
  restorationTargets: RestorationTargetSpanInput[];
  manualNameTaken: boolean;
}

export interface ResolvedPublicCandidatePlan {
  candidatePlan: TariffReviewPlanSnapshot;
  applyCandidate: Extract<ApplyTariffSelectionCandidate, { kind: 'public' }>;
  conversionInputs: ConversionInputsRecord;
}

export interface CommitReviewedSelectionInput {
  userId: string;
  commit: TariffSelectionCommit;
  publicRate?: {
    rate: UrdbRate;
    preLockUtilityName: string;
    medianMonthlyKwh: number | null;
  };
  resolvePublicPlan: (ctx: {
    rate: UrdbRate;
    siteCurrency: string;
    utilityName: string;
    effectiveFrom: string;
    effectiveTo: string | null;
    todaySiteLocal: string;
    medianMonthlyKwh: number | null;
    fallbackSellRate: number;
    hasTeslaSellFallback: boolean;
  }) => ResolvedPublicCandidatePlan;
  deriveEligibility?: (ctx: {
    rateCountry: string | null;
  }) => RatePlanEligibility;
  now?: Date;
}

export async function loadSiteSellFallbackOnClient(
  queryable: Pick<PoolClient, 'query'>,
  siteId: string,
  effectiveDate?: string
): Promise<SitePublicConversionContext> {
  const fallbackHash = tariffContentHash(buildDefaultTariff('Default Rate'));
  let chosenTariffId: number | null = null;

  if (effectiveDate) {
    const activeTesla = (await queryable.query<{ tariff_id: number }>(
      `SELECT p.tariff_id
       FROM "TariffEffectivePeriod" p
       JOIN "Tariff" t ON t.id = p.tariff_id
       WHERE p.site_id = $1 AND p.source = 'tesla' AND t.content_hash IS DISTINCT FROM $2
         AND p.effective_from <= $3::date AND (p.effective_to IS NULL OR p.effective_to >= $3::date)
       ORDER BY p.effective_from DESC, p.id DESC LIMIT 1`,
      [siteId, fallbackHash, effectiveDate]
    )).rows[0];
    if (activeTesla) {
      chosenTariffId = Number(activeTesla.tariff_id);
    } else {
      const origTesla = (await queryable.query<{ original_tariff_id: number }>(
        `SELECT o.original_tariff_id
         FROM "TariffSelectionOriginal" o
         JOIN "Tariff" t ON t.id = o.original_tariff_id
         WHERE o.site_id = $1 AND o.scope = 'actual' AND t.content_hash IS DISTINCT FROM $2
           AND o.effective_from <= $3::date AND (o.effective_to IS NULL OR o.effective_to >= $3::date)
         ORDER BY o.id DESC LIMIT 1`,
        [siteId, fallbackHash, effectiveDate]
      )).rows[0];
      if (origTesla) {
        chosenTariffId = Number(origTesla.original_tariff_id);
      }
    }
  }

  if (chosenTariffId === null) {
    const latestTesla = (await queryable.query<{ id: number }>(
      `SELECT id FROM "Tariff"
       WHERE site_id = $1 AND source = 'tesla' AND content_hash IS DISTINCT FROM $2
       ORDER BY updated DESC, id DESC LIMIT 1`,
      [siteId, fallbackHash]
    )).rows[0];
    if (latestTesla) {
      chosenTariffId = Number(latestTesla.id);
    }
  }

  if (chosenTariffId === null) {
    return { fallbackSellRate: 0, hasTeslaSellFallback: false };
  }

  const map = await hydrateTariffs(queryable, [chosenTariffId]);
  const tariff = map.get(chosenTariffId);
  if (!tariff) {
    return { fallbackSellRate: 0, hasTeslaSellFallback: false };
  }
  const rates = tariff.seasons?.flatMap(
    season => season.schedules?.map(sch => sch.sell_rate ?? season.sell_rate) ?? [season.sell_rate]
  ) ?? [];
  const rawAvg = rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : 0;
  const fallbackSellRate = Math.round(rawAvg * 100_000) / 100_000;
  return {
    fallbackSellRate: Object.is(fallbackSellRate, -0) ? 0 : fallbackSellRate,
    hasTeslaSellFallback: true,
  };
}

interface ProtectedPublicPatchMetadata {
  urdbLabel: string | null;
  utilityName: string | null;
  revisionStart: string | null;
  exportRateProvenance: ExportRateProvenance;
  holidaysUseWeekend: boolean;
  approximationNotes: TariffApproximationNote[];
  contentHash: string | null;
}

function assertLegacyMutationPreservesProtectedSpans(
  spans: ExistingSpan[],
  effectiveFrom: string,
  effectiveTo: string | null
): void {
  const overlapsProtected = spans.some(
    span => spansOverlapDates(span.effectiveFrom, span.effectiveTo, effectiveFrom, effectiveTo) && isProtectedSpan(span)
  );
  if (overlapsProtected) {
    throw new TariffValidationError(
      'This date range includes a protected rate plan selection. Review the change before replacing it.'
    );
  }
}

async function loadProtectedTeslaSelectionMetadata(
  client: Pick<PoolClient, 'query'>,
  selectionId: number | null | undefined
): Promise<{ candidateKind: 'tesla_sync' | 'restore_tesla'; restoredFromSelectionId: number | null }> {
  if (selectionId === null || selectionId === undefined) {
    return { candidateKind: 'tesla_sync', restoredFromSelectionId: null };
  }
  const selRes = await client.query<{
    candidate_kind: string;
    restored_from_selection_id: number | null;
  }>(
    `SELECT candidate_kind, restored_from_selection_id FROM "TariffSelection" WHERE id = $1`,
    [selectionId]
  );
  const row = selRes.rows[0];
  if (row?.candidate_kind === 'restore_tesla') {
    return {
      candidateKind: 'restore_tesla',
      restoredFromSelectionId: row.restored_from_selection_id === null ? null : Number(row.restored_from_selection_id),
    };
  }
  return { candidateKind: 'tesla_sync', restoredFromSelectionId: null };
}

async function loadProtectedPublicPatchMetadata(
  client: Pick<PoolClient, 'query'>,
  selectionId: number | null | undefined,
  tariffId: number
): Promise<ProtectedPublicPatchMetadata> {
  const hashRes = await client.query<{ content_hash: string | null }>(
    'SELECT content_hash FROM "Tariff" WHERE id = $1',
    [tariffId]
  );
  const contentHash = hashRes.rows[0]?.content_hash ?? null;
  if (selectionId === null || selectionId === undefined) {
    return {
      urdbLabel: null,
      utilityName: null,
      revisionStart: null,
      exportRateProvenance: 'published',
      holidaysUseWeekend: true,
      approximationNotes: [],
      contentHash,
    };
  }
  const selRes = await client.query<{
    urdb_label: string | null;
    utility_name: string | null;
    revision_start: string | null;
    export_rate_provenance: ExportRateProvenance;
    holidays_use_weekend: boolean;
    approximation_notes: unknown;
  }>(
    `SELECT urdb_label, utility_name, revision_start::text, export_rate_provenance, holidays_use_weekend, approximation_notes
     FROM "TariffSelection" WHERE id = $1`,
    [selectionId]
  );
  const row = selRes.rows[0];
  return {
    urdbLabel: row?.urdb_label ?? null,
    utilityName: row?.utility_name ?? null,
    revisionStart: row?.revision_start ? row.revision_start.slice(0, 10) : null,
    exportRateProvenance: row?.export_rate_provenance ?? 'published',
    holidaysUseWeekend: row?.holidays_use_weekend ?? true,
    approximationNotes: parseApproximationNotes(row?.approximation_notes),
    contentHash,
  };
}

async function hasNewerTimelineActivityOnClient(
  client: Pick<PoolClient, 'query'>,
  siteId: string,
  scope: TariffSelectionScope,
  maxMatchedSelectionId: number,
  selectionCreatedAt: Date | string,
  matchedSelectionIds: number[],
  selectionTimelineRevision: number | null
): Promise<boolean> {
  const maxSelRes = await client.query<{ max_id: number | null }>(
    `SELECT MAX(id)::int AS max_id FROM "TariffSelection" WHERE site_id = $1 AND scope = $2`,
    [siteId, scope]
  );
  const maxId = maxSelRes.rows[0]?.max_id;
  if (maxId === undefined || maxId === null || Number(maxId) !== maxMatchedSelectionId) {
    return true;
  }

  const siteRevRes = await client.query<{ timeline_revision: string | number | null }>(
    'SELECT timeline_revision FROM "Site" WHERE id = $1',
    [siteId]
  );
  const siteRevision = siteRevRes.rows[0]?.timeline_revision;
  if (
    siteRevision !== undefined &&
    siteRevision !== null &&
    selectionTimelineRevision !== null &&
    Number(siteRevision) !== Number(selectionTimelineRevision)
  ) {
    return true;
  }

  const createdIso = typeof selectionCreatedAt === 'string'
    ? selectionCreatedAt
    : selectionCreatedAt instanceof Date
      ? selectionCreatedAt.toISOString()
      : new Date(selectionCreatedAt).toISOString();

  const periodTable = scope === 'actual' ? '"TariffEffectivePeriod"' : '"TariffReferencePeriod"';
  const newerPeriod = await client.query<{ id: number }>(
    `SELECT id FROM ${periodTable}
     WHERE site_id = $1 AND created_at > $2::timestamptz
       AND (selection_id IS NULL OR NOT (selection_id = ANY($3::int[])))
     LIMIT 1`,
    [siteId, createdIso, matchedSelectionIds]
  );
  if ((newerPeriod.rows?.length ?? 0) > 0) {
    return true;
  }

  const newerUtility = await client.query<{ site_id: string }>(
    `SELECT site_id FROM "SiteUtility" WHERE site_id = $1 AND updated_at > $2::timestamptz LIMIT 1`,
    [siteId, createdIso]
  );
  if ((newerUtility.rows?.length ?? 0) > 0) {
    return true;
  }

  if (scope === 'actual') {
    const newerTesla = await client.query<{ id: number }>(
      `SELECT id FROM "Tariff" WHERE site_id = $1 AND source = 'tesla' AND updated::timestamptz > $2::timestamptz LIMIT 1`,
      [siteId, createdIso]
    );
    if ((newerTesla.rows?.length ?? 0) > 0) {
      return true;
    }
  }

  return false;
}

function coalesceContiguousSelectionSpans(
  spans: ExistingSpan[],
  effectiveFrom: string,
  effectiveTo: string | null,
  expectedSource: TariffSource
): { selectionId: number; tariffId: number } | null {
  if (spans.length === 0) return null;
  const sorted = [...spans].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  const first = sorted[0];
  if (
    first.selectionId === null ||
    first.selectionId === undefined ||
    first.source !== expectedSource ||
    first.choiceKind !== 'owner' ||
    first.effectiveFrom !== effectiveFrom
  ) {
    return null;
  }
  const selectionId = first.selectionId;
  const tariffId = first.tariffId;

  for (let i = 0; i < sorted.length; i++) {
    const cur = sorted[i];
    if (
      cur.selectionId !== selectionId ||
      cur.tariffId !== tariffId ||
      cur.source !== expectedSource ||
      cur.choiceKind !== 'owner'
    ) {
      return null;
    }
    if (i > 0) {
      const prev = sorted[i - 1];
      if (prev.effectiveTo === null || addCalendarDays(prev.effectiveTo, 1) !== cur.effectiveFrom) {
        return null;
      }
    }
  }

  if (sorted[sorted.length - 1].effectiveTo !== effectiveTo) {
    return null;
  }
  return { selectionId, tariffId };
}

async function findIdempotentRetryOnClient(
  client: Pick<PoolClient, 'query'>,
  siteId: string,
  userId: string,
  commit: TariffSelectionCommit,
  candidatePlan: TariffReviewPlanSnapshot | null,
  existingSpans: ExistingTimelineSpanInput[],
  restorationTargets: RestorationTargetSpanInput[]
): Promise<ApplyTariffSelectionResult | null> {
  const { scope, effectiveFrom, effectiveTo, candidate, verifiedAgainstBill } = commit;
  const currentSpans = await loadScopeSpans(client, siteId, scope);

  if (candidate.kind === 'restore_tesla') {
    if (restorationTargets.length === 0) return null;
    const matchedSpans: Array<{ span: ExistingSpan; target: RestorationTargetSpanInput }> = [];
    for (const target of restorationTargets) {
      const match = currentSpans.find(
        s =>
          s.effectiveFrom === target.effectiveFrom &&
          s.effectiveTo === target.effectiveTo &&
          s.tariffId === target.original.tariffId &&
          s.source === 'tesla' &&
          s.choiceKind === 'owner' &&
          s.selectionId !== null &&
          s.selectionId !== undefined
      );
      if (!match) return null;
      matchedSpans.push({ span: match, target });
    }

    const matchedSelectionIds = [...new Set(matchedSpans.map(m => Number(m.span.selectionId)))];
    const selRes = await client.query<TariffSelectionRow & { created_at_text?: string | null }>(
      `SELECT id, site_id, scope, tariff_id, effective_from::text, effective_to::text,
              source, choice_kind, candidate_kind, selected_by_user_id,
              urdb_label, utility_name, revision_start::text, export_rate_provenance,
              holidays_use_weekend, approximation_notes, selected_content_hash,
              restored_from_selection_id, review_hash, timeline_revision, created_at, created_at::text AS created_at_text
       FROM "TariffSelection"
       WHERE site_id = $1 AND scope = $2 AND id = ANY($3::int[])`,
      [siteId, scope, matchedSelectionIds]
    );
    if (selRes.rows.length !== matchedSelectionIds.length) return null;

    const firstCreatedMs = new Date(selRes.rows[0].created_at).getTime();
    const firstTimelineRevision =
      selRes.rows[0].timeline_revision !== undefined && selRes.rows[0].timeline_revision !== null
        ? Number(selRes.rows[0].timeline_revision)
        : null;

    for (const m of matchedSpans) {
      const sel = selRes.rows.find(r => Number(r.id) === Number(m.span.selectionId));
      if (!sel) return null;
      if (sel.selected_by_user_id !== userId) return null;
      if (sel.choice_kind !== 'owner' || sel.candidate_kind !== 'restore_tesla') return null;
      if (sel.review_hash === null || sel.review_hash === undefined || sel.review_hash !== commit.expectedReviewHash) {
        return null;
      }
      if (new Date(sel.created_at).getTime() !== firstCreatedMs) return null;
      const selRev =
        sel.timeline_revision !== undefined && sel.timeline_revision !== null
          ? Number(sel.timeline_revision)
          : null;
      if (selRev !== firstTimelineRevision) return null;
      if (Number(sel.restored_from_selection_id) !== candidate.originalSelectionId) return null;
      if (sel.effective_from.slice(0, 10) !== m.target.effectiveFrom) return null;
      const selTo = sel.effective_to ? sel.effective_to.slice(0, 10) : null;
      if (selTo !== m.target.effectiveTo) return null;
      if (sel.selected_content_hash !== m.target.original.contentHash) return null;
    }

    const verRes = await client.query<{
      selection_id: number;
      tariff_id: number;
      tariff_content_hash: string;
      effective_from: string;
      effective_to: string | null;
      verified_by_user_id: string | null;
    }>(
      `SELECT selection_id, tariff_id, tariff_content_hash, effective_from::text, effective_to::text, verified_by_user_id
       FROM "TariffSelectionVerification"
       WHERE selection_id = ANY($1::int[])`,
      [matchedSelectionIds]
    );

    if (verifiedAgainstBill) {
      for (const m of matchedSpans) {
        const ver = verRes.rows.find(v => Number(v.selection_id) === Number(m.span.selectionId));
        if (!ver) return null;
        if (ver.verified_by_user_id !== userId) return null;
        if (Number(ver.tariff_id) !== m.target.original.tariffId) return null;
        if (ver.tariff_content_hash !== m.target.original.contentHash) return null;
        if (ver.effective_from.slice(0, 10) !== m.target.effectiveFrom) return null;
        const vTo = ver.effective_to ? ver.effective_to.slice(0, 10) : null;
        if (vTo !== m.target.effectiveTo) return null;
      }
    } else if (verRes.rows.length > 0) {
      return null;
    }

    const maxSelectionId = Math.max(...matchedSelectionIds);
    if (
      await hasNewerTimelineActivityOnClient(
        client,
        siteId,
        scope,
        maxSelectionId,
        selRes.rows[0].created_at_text ?? selRes.rows[0].created_at,
        matchedSelectionIds,
        firstTimelineRevision
      )
    ) {
      return null;
    }

    return {
      selectionIds: matchedSelectionIds,
      tariffIds: [...new Set(matchedSpans.map(m => m.target.original.tariffId))],
      createdNewTariffVersion: false,
      unchanged: true,
      reattributionRange: null,
    };
  }

  if (!candidatePlan) return null;
  const overlapping = currentSpans.filter(s =>
    spansOverlapDates(s.effectiveFrom, s.effectiveTo, effectiveFrom, effectiveTo)
  );
  const coalesced = coalesceContiguousSelectionSpans(
    overlapping,
    effectiveFrom,
    effectiveTo,
    candidatePlan.source
  );
  if (!coalesced) return null;

  const matchingPreviewSpans = existingSpans.filter(s => s.plan.selectionId === coalesced.selectionId);
  if (matchingPreviewSpans.some(s => s.plan.name !== candidatePlan.name)) {
    return null;
  }

  const selRes = await client.query<TariffSelectionRow & { created_at_text?: string | null }>(
    `SELECT id, site_id, scope, tariff_id, effective_from::text, effective_to::text,
            source, choice_kind, candidate_kind, selected_by_user_id,
            urdb_label, utility_name, revision_start::text, export_rate_provenance,
            holidays_use_weekend, approximation_notes, selected_content_hash,
            restored_from_selection_id, review_hash, timeline_revision, created_at, created_at::text AS created_at_text
     FROM "TariffSelection"
     WHERE site_id = $1 AND scope = $2 AND id = ANY($3::int[])`,
    [siteId, scope, [coalesced.selectionId]]
  );
  const sel = selRes.rows[0];
  if (!sel) return null;
  if (sel.selected_by_user_id !== userId) return null;
  if (sel.choice_kind !== 'owner' || sel.candidate_kind !== candidate.kind) return null;
  if (sel.review_hash === null || sel.review_hash === undefined || sel.review_hash !== commit.expectedReviewHash) {
    return null;
  }
  if (sel.effective_from.slice(0, 10) !== effectiveFrom) return null;
  const selTo = sel.effective_to ? sel.effective_to.slice(0, 10) : null;
  if (selTo !== effectiveTo) return null;
  if (sel.selected_content_hash !== candidatePlan.contentHash) return null;
  if ((sel.urdb_label ?? null) !== candidatePlan.urdbLabel) return null;
  if ((sel.utility_name ?? null) !== candidatePlan.utilityName) return null;
  const selRev = sel.revision_start ? sel.revision_start.slice(0, 10) : null;
  if (selRev !== candidatePlan.revisionStart) return null;
  if (sel.export_rate_provenance !== candidatePlan.exportRateProvenance) return null;
  if (Boolean(sel.holidays_use_weekend) !== candidatePlan.holidaysUseWeekendSchedule) return null;
  if (
    JSON.stringify(parseApproximationNotes(sel.approximation_notes)) !==
    JSON.stringify(candidatePlan.approximationNotes)
  ) {
    return null;
  }

  const verRes = await client.query<{
    tariff_id: number;
    tariff_content_hash: string;
    effective_from: string;
    effective_to: string | null;
    verified_by_user_id: string | null;
  }>(
    `SELECT tariff_id, tariff_content_hash, effective_from::text, effective_to::text, verified_by_user_id
     FROM "TariffSelectionVerification"
     WHERE selection_id = $1`,
    [coalesced.selectionId]
  );
  const ver = verRes.rows[0];
  if (verifiedAgainstBill) {
    if (!ver) return null;
    if (ver.verified_by_user_id !== userId) return null;
    if (Number(ver.tariff_id) !== coalesced.tariffId) return null;
    if (ver.tariff_content_hash !== candidatePlan.contentHash) return null;
    if (ver.effective_from.slice(0, 10) !== effectiveFrom) return null;
    const vTo = ver.effective_to ? ver.effective_to.slice(0, 10) : null;
    if (vTo !== effectiveTo) return null;
  } else if (ver) {
    return null;
  }

  const selectionTimelineRevision =
    sel.timeline_revision !== undefined && sel.timeline_revision !== null
      ? Number(sel.timeline_revision)
      : null;

  if (
    await hasNewerTimelineActivityOnClient(
      client,
      siteId,
      scope,
      coalesced.selectionId,
      sel.created_at_text ?? sel.created_at,
      [coalesced.selectionId],
      selectionTimelineRevision
    )
  ) {
    return null;
  }

  return {
    selectionIds: [coalesced.selectionId],
    tariffIds: [coalesced.tariffId],
    createdNewTariffVersion: false,
    unchanged: true,
    reattributionRange: null,
  };
}

async function hasUnprotectedPublicStateOnClient(
  client: Pick<PoolClient, 'query'>,
  siteId: string
): Promise<boolean> {
  const res = await client.query<{ found: number }>(
    `SELECT 1 AS found
     FROM "TariffEffectivePeriod" p
     LEFT JOIN "TariffSelection" sel ON sel.id = p.selection_id
     WHERE p.site_id = $1 AND p.source = 'estimated'
       AND p.updated_by_user_id IS NULL
       AND COALESCE(sel.choice_kind, 'automatic') <> 'owner'
     UNION ALL
     SELECT 1 AS found
     FROM "TariffReferencePeriod" rp
     LEFT JOIN "TariffSelection" sel ON sel.id = rp.selection_id
     WHERE rp.site_id = $1 AND rp.source = 'estimated'
       AND rp.updated_by_user_id IS NULL
       AND COALESCE(sel.choice_kind, 'automatic') <> 'owner'
     UNION ALL
     SELECT 1 AS found
     FROM "TariffUrdbSource" u
     WHERE u.site_id = $1
       AND (
         u.role = 'tesla_anchor'
         OR (
           u.role IN ('estimated_actual', 'estimated_reference')
           AND NOT EXISTS (
             SELECT 1 FROM "TariffSelection" s
             WHERE s.tariff_id = u.tariff_id AND s.site_id = u.site_id AND s.choice_kind = 'owner'
           )
           AND NOT EXISTS (
             SELECT 1 FROM "TariffEffectivePeriod" p
             WHERE p.tariff_id = u.tariff_id AND p.site_id = u.site_id AND p.updated_by_user_id IS NOT NULL
           )
           AND NOT EXISTS (
             SELECT 1 FROM "TariffReferencePeriod" rp
             WHERE rp.tariff_id = u.tariff_id AND rp.site_id = u.site_id AND rp.updated_by_user_id IS NOT NULL
           )
         )
       )
     LIMIT 1`,
    [siteId]
  );
  return (res.rowCount ?? 0) > 0;
}

/** The actual plan that covers a date, with the fields the Sync to Tesla service needs. */
export interface ActiveActualPlan {
  tariffId: number;
  selectionId: number | null;
  source: TariffSource;
  name: string;
  seasons: TariffSeasonInput[];
  /** True when the plan has rules for specific weekdays that `seasons` (Monday and Saturday) cannot show. */
  daySpecific: boolean;
}

/**
 * The actual plan covering `today`, or null when none covers it (no fallback to a neighbouring plan).
 * Read through `client` when the caller holds the Site lock.
 */
export async function loadActiveActualPlanOnClient(
  client: Pick<PoolClient, 'query'>,
  siteId: string,
  today: string
): Promise<ActiveActualPlan | null> {
  const rows = await loadScopePeriodRows(client, siteId, 'actual');
  const row = rows.find(r =>
    r.effective_from.slice(0, 10) <= today && (r.effective_to === null || r.effective_to.slice(0, 10) >= today)
  );
  if (!row) return null;
  const tariffId = Number(row.tariff_id);
  const tariff = (await hydrateTariffs(client, [tariffId])).get(tariffId);
  if (!tariff) return null;
  return {
    tariffId,
    selectionId: row.selection_id === null || row.selection_id === undefined ? null : Number(row.selection_id),
    source: row.source,
    name: row.name || 'Rate Plan',
    seasons: decompileTariffToSeasons(tariff),
    daySpecific: tariffHasDaySpecificSchedules(tariff),
  };
}

export class TariffTimelineRepo {
  /** See loadActiveActualPlanOnClient. Reads from the pool unless a client is given. */
  async loadActiveActualPlan(
    siteId: string,
    today: string,
    client?: Pick<PoolClient, 'query'>
  ): Promise<ActiveActualPlan | null> {
    return loadActiveActualPlanOnClient(client ?? pool, siteId, today);
  }

  async getSiteUtilityContext(siteId: string): Promise<SiteUtilityContextResult | null> {
    const result = await pool.query<{
      name: string | null;
      timezone: string;
      currency: string;
      choice: 'auto' | 'owner' | 'skipped' | null;
      rate_country: string | null;
      rate_country_source: RateCountrySource | null;
      rate_country_updated_at: Date | string | null;
    }>(
      `SELECT u.urdb_utility AS name,
              s.timezone,
              COALESCE(s.json -> 'tariff_content_v2' ->> 'currency', s.json ->> 'currency', 'USD') AS currency,
              u.choice,
              s.rate_country,
              s.rate_country_source,
              s.rate_country_updated_at
       FROM "Site" s
       LEFT JOIN "SiteUtility" u ON u.site_id = s.id
       WHERE s.id = $1`,
      [siteId]
    );
    const row = result.rows[0];
    if (!row) return null;
    const rateCountry = row.rate_country ?? null;
    return {
      name: row.name,
      timezone: row.timezone,
      currency: row.currency,
      choice: row.choice,
      rateCountry,
      rateCountrySource: row.rate_country_source ?? null,
      rateCountryUpdatedAt: toIsoOrNull(row.rate_country_updated_at),
      eligibility: deriveRatePlanEligibility(rateCountry),
    };
  }

  async getSiteRateCountry(siteId: string): Promise<SiteRateCountryDTO> {
    const res = await pool.query<{
      rate_country: string | null;
      rate_country_source: RateCountrySource | null;
      rate_country_updated_at: Date | string | null;
    }>(
      `SELECT rate_country, rate_country_source, rate_country_updated_at
       FROM "Site" WHERE id = $1`,
      [siteId]
    );
    const row = res.rows[0];
    if (!row) throw new TariffNotFoundError('Site not found');
    const countryCode = row.rate_country ?? null;
    return {
      countryCode,
      source: countryCode ? (row.rate_country_source ?? null) : null,
      updatedAt: toIsoOrNull(row.rate_country_updated_at),
      eligibility: deriveRatePlanEligibility(countryCode),
    };
  }

  async setSiteRateCountry(
    siteId: string,
    userId: string,
    rawInput: unknown
  ): Promise<{
    timeline: SiteTariffsTimelineResponse;
    reattributionRange: { fromDate: string; toDate: string | null } | null;
  }> {
    const input = validateSiteRateCountryInput(rawInput);
    const client = await pool.connect();
    let reattribution: EnqueueReattributionParams | null = null;
    let queued: EnqueuedReattribution | null = null;
    let applied = false;
    let anyChange = false;
    let finalCountryCode: string | null = null;
    let finalEligibility: RatePlanEligibility = 'unknown';

    try {
      await client.query('BEGIN');
      const siteRes = await client.query<{
        id: string;
        timezone: string;
        rate_country: string | null;
        rate_country_source: RateCountrySource | null;
      }>(
        `SELECT id, timezone, rate_country, rate_country_source
         FROM "Site" WHERE id = $1 FOR UPDATE`,
        [siteId]
      );
      const site = siteRes.rows[0];
      if (!site) throw new TariffNotFoundError('Site not found');

      const currentEligibility = deriveRatePlanEligibility(site.rate_country ?? null);
      const decision = shouldApplyRateCountryWrite(
        {
          countryCode: site.rate_country ?? null,
          source: site.rate_country_source ?? null,
        },
        input
      );
      applied = decision.apply;
      finalCountryCode = decision.nextCountryCode;
      finalEligibility = deriveRatePlanEligibility(decision.nextCountryCode);
      const timezone = site.timezone || 'UTC';
      const today = siteLocalDateString(new Date(), timezone);

      if (decision.apply) {
        await client.query(
          `UPDATE "Site"
           SET rate_country = $2,
               rate_country_source = $3,
               rate_country_updated_at = now()
           WHERE id = $1`,
          [siteId, decision.nextCountryCode, decision.nextSource]
        );
        anyChange = true;
      }

      if (finalEligibility === 'us') {
        if (currentEligibility !== 'us') {
          await client.query(
            `INSERT INTO "SiteUtility" (site_id, choice, status, next_check_at, updated_at)
             VALUES ($1, 'auto', 'pending', NULL, clock_timestamp())
             ON CONFLICT (site_id) DO UPDATE
             SET status = CASE WHEN "SiteUtility".choice = 'skipped' THEN 'ready' ELSE 'pending' END,
                 next_check_at = NULL,
                 attempt_count = 0,
                 last_error = NULL,
                 updated_at = clock_timestamp()`,
            [siteId]
          );
          anyChange = true;
        }
      } else if (
        decision.apply ||
        currentEligibility === 'us' ||
        (await hasUnprotectedPublicStateOnClient(client, siteId))
      ) {
        await clearUnprotectedUrdbSourcesOnClient(client, siteId);
        const { changed } = await applyEstimatesOnClient(client, siteId, today);
        if (changed.length > 0) {
          reattribution = {
            siteId,
            fromDate: changed.reduce((min, range) => minDate(min, range.from), changed[0].from),
            toDate: changed.reduce<string | null>((max, range) => maxEnd(max, range.to), changed[0].to),
            requestedByUserId: userId,
            trigger: 'estimate',
          };
          queued = await enqueueReattributionOnClient(client, reattribution);
          anyChange = true;
        }
        await client.query(
          `UPDATE "SiteUtility"
           SET urdb_utility = CASE WHEN choice = 'auto' AND $2 = 'outside_us' THEN NULL ELSE urdb_utility END,
               status = 'ready',
               attempt_count = 0,
               last_error = NULL,
               next_check_at = NULL,
               updated_at = clock_timestamp()
           WHERE site_id = $1`,
          [siteId, finalEligibility]
        );
      }

      if (anyChange) {
        await bumpSiteTimelineRevisionOnClient(client, siteId);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    if (anyChange) {
      new SiteRepo().invalidateCache(siteId);
    }
    if (reattribution && queued) {
      logReattributionEnqueued(reattribution, queued);
    }
    logEvent('info', 'site.rate_country.updated', {
      countryCode: finalCountryCode,
      source: input.source,
      eligibility: finalEligibility,
      applied,
      reattributed: reattribution !== null,
      accountId: accountFingerprint(userId),
    });

    return {
      timeline: await this.getTimeline(siteId, userId),
      reattributionRange: reattribution ? { fromDate: reattribution.fromDate, toDate: reattribution.toDate } : null,
    };
  }

  async loadSitePublicConversionContext(
    siteId: string,
    effectiveDate?: string
  ): Promise<SitePublicConversionContext> {
    return loadSiteSellFallbackOnClient(pool, siteId, effectiveDate);
  }

  async loadSelectionTimelineSnapshot(params: {
    siteId: string;
    scope: TariffSelectionScope;
    viewerUserId: string | null;
    request: TariffSelectionRequest;
  }): Promise<SelectionTimelineSnapshot> {
    const { siteId, scope, viewerUserId, request } = params;
    const existingSpans = await loadScopeSelectionSpans(pool, siteId, scope, viewerUserId);
    const restorationTargets = request.candidate.kind === 'restore_tesla'
      ? await loadRestorationTargets(
          pool,
          siteId,
          scope,
          request.candidate.originalSelectionId,
          request.effectiveFrom,
          request.effectiveTo
        )
      : [];
    const fallback = request.candidate.kind === 'public'
      ? await loadSiteSellFallbackOnClient(pool, siteId, request.effectiveFrom)
      : { fallbackSellRate: 0, hasTeslaSellFallback: false };

    let manualNameTaken = false;
    if (request.candidate.kind === 'manual' && scope === 'actual') {
      const parsed = compileSeasonsToParsedTariff(request.candidate.name, request.candidate.seasons);
      const newHash = tariffContentHash(parsed);
      const existingTariff = (await pool.query<{ id: number }>(
        `SELECT id FROM "Tariff"
         WHERE site_id = $1 AND source = 'manual' AND name = $2 AND content_hash = $3
         ORDER BY id DESC LIMIT 1`,
        [siteId, request.candidate.name, newHash]
      )).rows[0];
      const existing = await loadScopeSpans(pool, siteId, scope);
      manualNameTaken = await planNameTakenAfterReplacement(
        pool,
        existing,
        siteId,
        request.candidate.name,
        request.effectiveFrom,
        request.effectiveTo,
        existingTariff ? Number(existingTariff.id) : null
      );
    }

    return {
      fallbackSellRate: fallback.fallbackSellRate,
      hasTeslaSellFallback: fallback.hasTeslaSellFallback,
      existingSpans,
      restorationTargets,
      manualNameTaken,
    };
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
      const site = await client.query<{ id: string; timezone?: string | null; rate_country?: string | null }>(
        'SELECT id, timezone, rate_country FROM "Site" WHERE id = $1 FOR UPDATE',
        [siteId]
      );
      const siteRow = site.rows[0];
      if (!siteRow) throw new TariffNotFoundError('Site not found');
      const skipped = 'skipped' in input;
      if (!skipped) {
        assertUsRatePlanEligibility(deriveRatePlanEligibility(siteRow.rate_country ?? null));
      }
      await client.query(`INSERT INTO "SiteUtility" (site_id, urdb_utility, choice, status, updated_by_user_id)
        VALUES ($1, $2, $3, 'pending', $4) ON CONFLICT (site_id) DO UPDATE SET urdb_utility = EXCLUDED.urdb_utility, choice = EXCLUDED.choice, urdb_plan_label = NULL, status = 'pending', attempt_count = 0, next_check_at = NULL, updated_by_user_id = EXCLUDED.updated_by_user_id, updated_at = now()`,
      [siteId, skipped ? null : input.name, skipped ? 'skipped' : 'owner', userId]);
      if (skipped) {
        // Removing estimates needs no OpenEI call, so do it now rather than on the next cron run.
        const timezone = siteRow.timezone || 'UTC';
        // Protect owner-selected public source records and owner_history while removing automatic estimate sources.
        await clearUnprotectedUrdbSourcesOnClient(client, siteId);
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
      await bumpSiteTimelineRevisionOnClient(client, siteId);
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
      const site = await client.query<{ id: string; rate_country?: string | null }>(
        'SELECT id, rate_country FROM "Site" WHERE id = $1 FOR UPDATE',
        [siteId]
      );
      if (!site.rows[0]) throw new TariffNotFoundError('Site not found');
      assertUsRatePlanEligibility(deriveRatePlanEligibility(site.rows[0].rate_country ?? null));
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
  async saveRatePlanHistory(siteId: string, userId: string, expectedUtility: string, revisions: ExpandedRevision[], openLabel: string | null, fixed: FixedComparisonWrite[] = []): Promise<SiteTariffsTimelineResponse> {
    const client = await pool.connect();
    let reattribution: EnqueueReattributionParams | null = null;
    let queued: EnqueuedReattribution | null = null;
    let savedCount = 0;
    try {
      await client.query('BEGIN');
      const siteRes = await client.query<{ timezone: string; rate_country?: string | null }>(
        'SELECT timezone, rate_country FROM "Site" WHERE id = $1 FOR UPDATE',
        [siteId]
      );
      if (!siteRes.rows[0]) throw new TariffNotFoundError('Site not found');
      assertUsRatePlanEligibility(deriveRatePlanEligibility(siteRes.rows[0].rate_country ?? null));
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
          const parsedPiece = compileSeasonsToParsedTariff(validated.name, validated.seasons);
          const pieceHash = tariffContentHash(parsedPiece);
          const tariffId = await insertTariffGraph(client, siteId, parsedPiece, 'manual', userId, false, pieceHash);
          const currentSpans = await loadExistingSpans(client, siteId);
          const replacedOriginals = await collectReplacedOriginalsOnClient(client, currentSpans, piece.from, piece.to);
          const selectionId = await insertTariffSelectionOnClient(client, {
            siteId,
            scope: 'actual',
            tariffId,
            effectiveFrom: piece.from,
            effectiveTo: piece.to,
            source: 'manual',
            choiceKind: 'owner',
            candidateKind: 'manual',
            selectedByUserId: userId,
            urdbLabel: revision.label,
            utilityName: expectedUtility,
            revisionStart: revision.revisionStart,
            exportRateProvenance: 'manual',
            selectedContentHash: pieceHash,
          });
          await storeSelectionOriginalsOnClient(client, siteId, 'actual', selectionId, replacedOriginals);
          await applySpanMutationPlan(client, siteId, computeSpanMutations(currentSpans, {
            tariffId,
            source: 'manual',
            effectiveFrom: piece.from,
            effectiveTo: piece.to,
            updatedByUserId: userId,
            ...(selectionId !== null ? { selectionId, choiceKind: 'owner' as const } : {}),
          }));
          await client.query(
            `INSERT INTO "TariffUrdbSource" (tariff_id, site_id, role, urdb_label, start_date, end_date, start_source, revision_start, is_current_estimate) VALUES ($1, $2, 'owner_history', $3, $4::date, $5::date, 'urdb', $6::date, FALSE)`,
            [tariffId, siteId, revision.label, piece.from, piece.to, revision.revisionStart]
          );
          saved.push(piece);
        }
      }
      const kept = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count
         FROM "TariffEffectivePeriod" p
         LEFT JOIN "TariffSelection" s ON s.id = p.selection_id
         WHERE p.site_id = $1 AND (p.source <> 'estimated' OR s.choice_kind = 'owner')`,
        [siteId]
      );
      if (Number(kept.rows[0]?.count ?? 0) > MAX_EFFECTIVE_PERIODS_PER_SITE) {
        throw new TariffValidationError('That’s more rate plan changes than we can save. Add the older ones in Rate Plans.');
      }
      if (openLabel !== null) {
        if (!(await setPlanLabelOnClient(client, siteId, userId, openLabel, expectedUtility))) throw new UtilityChangedError('Utility changed. Start again.');
      } else if (saved.length) {
        // The site now has a rate plan: rerun the estimate job so the actual timeline is built from it.
        await client.query(`UPDATE "SiteUtility" SET status = 'pending', next_check_at = NULL, updated_at = clock_timestamp() WHERE site_id = $1 AND status = 'needs_plan'`, [siteId]);
      }
      await writeFixedComparisonsOnClient(client, siteId, userId, today, expectedUtility, fixed);
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
      await bumpSiteTimelineRevisionOnClient(client, siteId);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    new SiteRepo().invalidateCache(siteId);
    if (reattribution && queued) logReattributionEnqueued(reattribution, queued);
    logEvent('info', 'tariff.history.saved', { revisionCount: revisions.length, savedPeriodCount: savedCount, openPlan: openLabel !== null });
    return this.getTimeline(siteId, userId);
  }

  /** Replaces both components: a `null` component deletes its row. Costs are not re-attributed. */
  async saveSystemCosts(siteId: string, userId: string, input: SystemCostsInput): Promise<SiteTariffsTimelineResponse> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const site = await client.query('SELECT id FROM "Site" WHERE id = $1 FOR UPDATE', [siteId]);
      if (!site.rowCount) throw new TariffNotFoundError('Site not found');
      for (const component of SYSTEM_COST_COMPONENTS) {
        const cost = input[component];
        if (!cost) {
          await client.query('DELETE FROM "SiteSystemCost" WHERE site_id = $1 AND component = $2', [siteId, component]);
          continue;
        }
        await client.query(
          `INSERT INTO "SiteSystemCost" (site_id, component, install_date, price, tax_credit_percent, incentives, updated_by_user_id, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, now())
           ON CONFLICT (site_id, component) DO UPDATE SET install_date = EXCLUDED.install_date, price = EXCLUDED.price,
             tax_credit_percent = EXCLUDED.tax_credit_percent, incentives = EXCLUDED.incentives,
             updated_by_user_id = EXCLUDED.updated_by_user_id, updated_at = now()`,
          [siteId, component, cost.installDate, cost.price, cost.taxCreditPercent, cost.incentives, userId]
        );
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    return this.getTimeline(siteId, userId);
  }

  async getTimeline(siteId: string, viewerUserId: string | null): Promise<SiteTariffsTimelineResponse> {
    const siteRes = await pool.query<{
      id: string;
      timezone: string;
      installed: Date | string;
      currency: string | null;
      rate_country?: string | null;
      rate_country_source?: RateCountrySource | null;
      rate_country_updated_at?: Date | string | null;
      nameplate_energy: string | number | null;
      nameplate_power: string | number | null;
      backup_reserve_percent: string | number | null;
      tou_capable: boolean | null;
      has_tesla_content: boolean;
    }>(
      `SELECT id, timezone, installed,
              COALESCE(json -> 'tariff_content_v2' ->> 'currency', json ->> 'currency', 'USD') AS currency,
              rate_country,
              rate_country_source,
              rate_country_updated_at,
              json ->> 'nameplate_energy' AS nameplate_energy,
              json ->> 'nameplate_power' AS nameplate_power,
              json ->> 'backup_reserve_percent' AS backup_reserve_percent,
              (json -> 'components' ->> 'tou_capable') = 'true' AS tou_capable,
              json ->> 'tariff_content_v2' IS NOT NULL AS has_tesla_content
       FROM "Site" WHERE id = $1`,
      [siteId]
    );
    const siteRow = siteRes.rows[0];
    if (!siteRow) throw new TariffNotFoundError('Site not found');
    const timezone = siteRow.timezone || 'UTC';
    const currency = siteRow.currency || 'USD';
    const today = siteLocalDateString(new Date(), timezone);
    const siteInstalled = siteLocalDateString(new Date(siteRow.installed), timezone);
    const battery = parseSiteBattery(siteRow);

    const periodsRes = { rows: await loadScopePeriodRows(pool, siteId, 'actual') };
    const referencePeriodsRes = { rows: await loadScopePeriodRows(pool, siteId, 'reference') };

    const latestTeslaRes = await pool.query<LatestTeslaTariffSummary>(
      `SELECT id, name, updated, content_hash
       FROM "Tariff"
       WHERE site_id = $1 AND source = 'tesla'
       ORDER BY id DESC LIMIT 1`,
      [siteId]
    );
    const tariffIds = [...new Set([
      ...periodsRes.rows.map(r => Number(r.tariff_id)),
      ...referencePeriodsRes.rows.map(r => Number(r.tariff_id)),
      ...(latestTeslaRes.rows[0] ? [Number(latestTeslaRes.rows[0].id)] : []),
    ])];
    const tariffMap = await hydrateTariffs(pool, tariffIds);
    const lastSync = await new TeslaTariffSyncRepo(pool).latestForSite(siteId);

    const systemCostRes = await pool.query<SystemCostRow>(
      `SELECT component, install_date::text, price::text, tax_credit_percent::text, incentives::text
       FROM "SiteSystemCost" WHERE site_id = $1`,
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
      siteInstalled,
      battery,
      systemCostRows: systemCostRes.rows,
      reattribution: reattrRes.rows[0],
      latestTesla: latestTeslaRes.rows[0],
      touCapable: siteRow.tou_capable === true,
      hasTeslaContent: siteRow.has_tesla_content === true,
      lastSync,
      rateCountry: siteRow.rate_country ?? null,
      rateCountrySource: siteRow.rate_country_source ?? null,
      rateCountryUpdatedAt: siteRow.rate_country_updated_at ?? null,
    });
    if (utility) {
      const skipped = utility.choice === 'skipped';
      const eligibility = timeline.rateCountry?.eligibility ?? deriveRatePlanEligibility(siteRow.rate_country ?? null);
      const hasIneligiblePublicSelection = timeline.rateCountry?.hasIneligiblePublicSelection ?? false;
      const freshness = skipped ? { newestRevisionStart: null, mayBeOutdated: false } : estimateFreshness({
        today,
        periodRows: periodsRes.rows.map(row => ({ tariff_id: Number(row.tariff_id), source: row.source, effective_from: row.effective_from, effective_to: row.effective_to })),
        referencePeriodRows: referencePeriodsRes.rows.map(row => ({ tariff_id: Number(row.tariff_id), source: row.source, effective_from: row.effective_from, effective_to: row.effective_to })),
        sources: estimateSourceRes.rows.map(row => ({ tariff_id: Number(row.tariff_id), role: row.role, start_date: row.start_date, revision_start: row.revision_start })),
      });
      if (eligibility === 'us') {
        timeline.estimates = {
          status: skipped ? 'skipped' : utility.status === 'running' ? 'pending' : utility.status as Exclude<import('./tariff-contract').EstimatesStatusDTO['status'], 'skipped'>,
          utilityName: utility.urdb_utility,
          teslaPlanOutOfDate: !skipped && utility.newer_urdb_name !== null,
          newerPlanName: skipped ? null : utility.newer_urdb_name,
          newerPlanStart: skipped ? null : utility.newer_urdb_start,
          ...freshness,
          historyGuide: null,
          eligibility,
          needsCountryConfirmation: false,
          hasIneligiblePublicSelection: false,
        };
        if (!skipped && utility.urdb_utility !== null && (utility.status === 'ready' || utility.status === 'needs_plan')) {
          const window = await loadHistoryWindow(pool, siteId, today);
          if (window) timeline.estimates.historyGuide = { historyStart: window.historyStart, fillThrough: window.fillThrough, unconfirmedDays: window.unconfirmedDays };
        }
      } else {
        // Existing unresolved ('unknown') and 'outside_us' sites must not be routed to a US utility search.
        timeline.estimates = {
          status: skipped ? 'skipped' : 'ready',
          utilityName: null,
          teslaPlanOutOfDate: false,
          newerPlanName: null,
          newerPlanStart: null,
          ...freshness,
          historyGuide: null,
          eligibility,
          needsCountryConfirmation: eligibility === 'unknown',
          hasIneligiblePublicSelection,
        };
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
      const newHash = tariffContentHash(parsed);
      newTariffId = await insertTariffGraph(client, siteId, parsed, 'manual', userId, false, newHash);

      const existing = await loadExistingSpans(client, siteId);
      assertLegacyMutationPreservesProtectedSpans(existing, validated.effectiveFrom, validated.effectiveTo);
      const replacedOriginals = await collectReplacedOriginalsOnClient(client, existing, validated.effectiveFrom, validated.effectiveTo);
      const selectionId = await insertTariffSelectionOnClient(client, {
        siteId,
        scope: 'actual',
        tariffId: newTariffId,
        effectiveFrom: validated.effectiveFrom,
        effectiveTo: validated.effectiveTo,
        source: 'manual',
        choiceKind: 'owner',
        candidateKind: 'manual',
        selectedByUserId: userId,
        exportRateProvenance: 'manual',
        selectedContentHash: newHash,
      });
      await storeSelectionOriginalsOnClient(client, siteId, 'actual', selectionId, replacedOriginals);

      const incoming: NewSpanRow = {
        tariffId: newTariffId,
        source: 'manual',
        effectiveFrom: validated.effectiveFrom,
        effectiveTo: validated.effectiveTo,
        updatedByUserId: userId,
        ...(selectionId !== null ? { selectionId, choiceKind: 'owner' as const } : {}),
      };
      const plan = computeSpanMutations(existing, incoming);
      if (countProtectedResultingSpans(existing, plan) > MAX_EFFECTIVE_PERIODS_PER_SITE) {
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
      await bumpSiteTimelineRevisionOnClient(client, siteId);
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
      const remaining = existing.filter(s => s.id !== periodId);
      assertLegacyMutationPreservesProtectedSpans(remaining, nextFrom, nextTo);

      let nextContentHash: string | null = null;
      let nextSource: TariffSource = target.source === 'estimated' ? 'manual' : target.source;
      let protectedPublicMeta: ProtectedPublicPatchMetadata | null = null;
      let protectedTeslaMeta: { candidateKind: 'tesla_sync' | 'restore_tesla'; restoredFromSelectionId: number | null } | null = null;
      if (target.source === 'tesla') {
        if (patch.name !== undefined || patch.seasons !== undefined) {
          throw new TariffValidationError('Tesla-synced rate plans only allow adjusting effective dates');
        }
        validateEffectiveDates(nextFrom, nextTo, today);
        targetTariffId = target.tariffId;
        const hashRes = await client.query<{ content_hash: string | null }>(
          'SELECT content_hash FROM "Tariff" WHERE id = $1',
          [target.tariffId]
        );
        nextContentHash = hashRes.rows[0]?.content_hash ?? null;
        if (isProtectedSpan(target)) {
          protectedTeslaMeta = await loadProtectedTeslaSelectionMetadata(client, target.selectionId);
        }
      } else if (target.source === 'estimated' && isProtectedSpan(target)) {
        if (patch.name !== undefined || patch.seasons !== undefined) {
          throw new TariffValidationError('Public rate plan selections must be reviewed before changing rates or name.');
        }
        validateEffectiveDates(nextFrom, nextTo, today);
        targetTariffId = target.tariffId;
        nextSource = 'estimated';
        protectedPublicMeta = await loadProtectedPublicPatchMetadata(client, target.selectionId, target.tariffId);
        nextContentHash = protectedPublicMeta.contentHash;
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
        nextContentHash = newHash;
        if (target.source === 'estimated' || newHash !== currentTariff.content_hash || validated.name !== currentTariff.name) {
          targetTariffId = await insertTariffGraph(client, siteId, parsed, 'manual', userId, false, newHash);
        } else {
          targetTariffId = target.tariffId;
        }
      }

      const replacedOriginals = await collectReplacedOriginalsOnClient(client, existing, nextFrom, nextTo);
      const selectionId = await insertTariffSelectionOnClient(client, {
        siteId,
        scope: 'actual',
        tariffId: targetTariffId,
        effectiveFrom: nextFrom,
        effectiveTo: nextTo,
        source: nextSource,
        choiceKind: 'owner',
        candidateKind: nextSource === 'tesla'
          ? (protectedTeslaMeta?.candidateKind ?? 'tesla_sync')
          : nextSource === 'estimated'
            ? 'public'
            : 'manual',
        selectedByUserId: userId,
        restoredFromSelectionId: protectedTeslaMeta?.restoredFromSelectionId ?? null,
        ...(protectedPublicMeta
          ? {
              urdbLabel: protectedPublicMeta.urdbLabel,
              utilityName: protectedPublicMeta.utilityName,
              revisionStart: protectedPublicMeta.revisionStart,
              exportRateProvenance: protectedPublicMeta.exportRateProvenance,
              holidaysUseWeekend: protectedPublicMeta.holidaysUseWeekend,
              approximationNotes: protectedPublicMeta.approximationNotes,
            }
          : {
              exportRateProvenance: nextSource === 'tesla' ? 'tesla' : 'manual',
            }),
        selectedContentHash: nextContentHash,
      });
      await storeSelectionOriginalsOnClient(client, siteId, 'actual', selectionId, replacedOriginals);

      const mutationPlan = computeSpanMutations(remaining, {
        tariffId: targetTariffId,
        source: nextSource,
        effectiveFrom: nextFrom,
        effectiveTo: nextTo,
        updatedByUserId: userId,
        ...(selectionId !== null ? { selectionId, choiceKind: 'owner' as const } : {}),
      });
      const plan: SpanMutationPlan = {
        deleteIds: [periodId, ...mutationPlan.deleteIds],
        inserts: mutationPlan.inserts,
      };
      if (countProtectedResultingSpans(existing, plan) > MAX_EFFECTIVE_PERIODS_PER_SITE) {
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
      await bumpSiteTimelineRevisionOnClient(client, siteId);
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
      if (target.source === 'estimated' && !isProtectedSpan(target)) {
        throw new TariffValidationError('Estimated rate plans fill days without a plan. Add your rate plan to replace one.');
      }
      if (target.source === 'estimated' && isProtectedSpan(target)) {
        throw new TariffValidationError('Public rate plan selections cannot be deleted directly. Restore or replace the plan in review.');
      }
      if (target.source === 'tesla') {
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
      await bumpSiteTimelineRevisionOnClient(client, siteId);
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
    const tariffs = (await this.resolveTariffsForDates(client, siteId, [siteLocalDate])).get(siteLocalDate) ?? [];
    const schedules = tariffs[0]?.seasons?.flatMap(s => s.schedules ?? []) ?? [];
    return { tariffs, schedules };
  }

  /**
   * The billing tariff for each site-local date, with one period read and one batched hydrate
   * however many dates are asked: a reattribution chunk resolves its days together.
   * Dates with no plan at all map to an empty list.
   */
  async resolveTariffsForDates(
    client: Pick<PoolClient, 'query'>,
    siteId: string,
    siteLocalDates: readonly string[]
  ): Promise<Map<string, Tariff[]>> {
    const result = new Map<string, Tariff[]>();
    if (siteLocalDates.length === 0) return result;
    const periodRes = await client.query<{ id: number; tariff_id: number; effective_from: string; effective_to: string | null }>(
      `SELECT id, tariff_id, effective_from::text AS effective_from, effective_to::text AS effective_to
       FROM "TariffEffectivePeriod" WHERE site_id = $1`,
      [siteId]
    );
    const periods: EffectivePeriodPick[] = periodRes.rows.map(r => ({
      periodId: Number(r.id),
      tariffId: Number(r.tariff_id),
      effectiveFrom: r.effective_from,
      effectiveTo: r.effective_to,
    }));
    let fallbackTariffId: number | undefined;
    if (periods.length === 0) {
      const current = await client.query<{ id: number }>(
        'SELECT id FROM "Tariff" WHERE site_id = $1 AND is_current = TRUE LIMIT 1',
        [siteId]
      );
      const id = current.rows[0]?.id;
      fallbackTariffId = id === undefined ? undefined : Number(id);
    }
    const tariffIdByDate = new Map<string, number | undefined>();
    for (const date of siteLocalDates) {
      tariffIdByDate.set(date, pickTariffIdForDate(periods, date) ?? fallbackTariffId);
    }
    const ids = [...new Set([...tariffIdByDate.values()].filter((id): id is number => id !== undefined))];
    const hydrated = await hydrateTariffs(client, ids);
    for (const [date, id] of tariffIdByDate) {
      const tariff = id === undefined ? undefined : hydrated.get(id);
      result.set(date, tariff ? [tariff] : []);
    }
    return result;
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
      const newHash = tariffContentHash(parsed);
      newTariffId = await insertTariffGraph(client, siteId, parsed, 'manual', userId, false, newHash);

      const existing = await loadReferenceSpans(client, siteId);
      assertLegacyMutationPreservesProtectedSpans(existing, validated.effectiveFrom, validated.effectiveTo);
      const selectionId = await insertTariffSelectionOnClient(client, {
        siteId,
        scope: 'reference',
        tariffId: newTariffId,
        effectiveFrom: validated.effectiveFrom,
        effectiveTo: validated.effectiveTo,
        source: 'manual',
        choiceKind: 'owner',
        candidateKind: 'manual',
        selectedByUserId: userId,
        exportRateProvenance: 'manual',
        selectedContentHash: newHash,
      });
      const plan = computeSpanMutations(existing, {
        tariffId: newTariffId,
        source: 'manual',
        effectiveFrom: validated.effectiveFrom,
        effectiveTo: validated.effectiveTo,
        updatedByUserId: userId,
        ...(selectionId !== null ? { selectionId, choiceKind: 'owner' as const } : {}),
      });
      if (countProtectedResultingSpans(existing, plan) > MAX_EFFECTIVE_PERIODS_PER_SITE) {
        throw new TariffValidationError(`Cannot exceed ${MAX_EFFECTIVE_PERIODS_PER_SITE} effective periods per site`);
      }
      const inserted = await applyReferenceSpanMutationPlan(client, siteId, plan);
      createdPeriodId = inserted.find(row => row.tariffId === newTariffId)?.id ?? inserted.at(-1)?.id ?? 0;
      await applyEstimatesOnClient(client, siteId, today, 'reference');
      await bumpSiteTimelineRevisionOnClient(client, siteId);
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
      const remaining = existing.filter(s => s.id !== periodId);
      assertLegacyMutationPreservesProtectedSpans(remaining, nextFrom, nextTo);

      let nextSource: Exclude<TariffSource, 'tesla'> = 'manual';
      let nextContentHash: string | null = null;
      let protectedPublicMeta: ProtectedPublicPatchMetadata | null = null;

      if (target.source === 'estimated' && isProtectedSpan(target)) {
        if (patch.name !== undefined || patch.seasons !== undefined) {
          throw new TariffValidationError('Public rate plan selections must be reviewed before changing rates or name.');
        }
        validateEffectiveDates(nextFrom, nextTo, today);
        targetTariffId = target.tariffId;
        nextSource = 'estimated';
        protectedPublicMeta = await loadProtectedPublicPatchMetadata(client, target.selectionId, target.tariffId);
        nextContentHash = protectedPublicMeta.contentHash;
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

        const parsed = compileSeasonsToParsedTariff(validated.name, validated.seasons);
        const newHash = tariffContentHash(parsed);
        nextContentHash = newHash;
        if (target.source === 'estimated' || newHash !== currentTariff.content_hash || validated.name !== currentTariff.name) {
          targetTariffId = await insertTariffGraph(client, siteId, parsed, 'manual', userId, false, newHash);
        } else {
          targetTariffId = target.tariffId;
        }
      }

      const selectionId = await insertTariffSelectionOnClient(client, {
        siteId,
        scope: 'reference',
        tariffId: targetTariffId,
        effectiveFrom: nextFrom,
        effectiveTo: nextTo,
        source: nextSource,
        choiceKind: 'owner',
        candidateKind: nextSource === 'estimated' ? 'public' : 'manual',
        selectedByUserId: userId,
        ...(protectedPublicMeta
          ? {
              urdbLabel: protectedPublicMeta.urdbLabel,
              utilityName: protectedPublicMeta.utilityName,
              revisionStart: protectedPublicMeta.revisionStart,
              exportRateProvenance: protectedPublicMeta.exportRateProvenance,
              holidaysUseWeekend: protectedPublicMeta.holidaysUseWeekend,
              approximationNotes: protectedPublicMeta.approximationNotes,
            }
          : {
              exportRateProvenance: 'manual',
            }),
        selectedContentHash: nextContentHash,
      });

      const mutationPlan = computeSpanMutations(remaining, {
        tariffId: targetTariffId,
        source: nextSource,
        effectiveFrom: nextFrom,
        effectiveTo: nextTo,
        updatedByUserId: userId,
        ...(selectionId !== null ? { selectionId, choiceKind: 'owner' as const } : {}),
      });
      const plan: SpanMutationPlan = {
        deleteIds: [periodId, ...mutationPlan.deleteIds],
        inserts: mutationPlan.inserts,
      };
      if (countProtectedResultingSpans(existing, plan) > MAX_EFFECTIVE_PERIODS_PER_SITE) {
        throw new TariffValidationError(`Cannot exceed ${MAX_EFFECTIVE_PERIODS_PER_SITE} effective periods per site`);
      }
      await applyReferenceSpanMutationPlan(client, siteId, plan);
      await applyEstimatesOnClient(client, siteId, today, 'reference');
      await bumpSiteTimelineRevisionOnClient(client, siteId);
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
      if (target?.source === 'estimated' && !isProtectedSpan(target)) {
        throw new TariffValidationError('Estimated rate plans fill days without a plan. Add your rate plan to replace one.');
      }
      if (target?.source === 'estimated' && isProtectedSpan(target)) {
        throw new TariffValidationError('Public rate plan selections cannot be deleted directly. Restore or replace the plan in review.');
      }
      const delRes = await client.query<{ id: number }>(
        'DELETE FROM "TariffReferencePeriod" WHERE site_id = $1 AND id = $2 RETURNING id',
        [siteId, periodId]
      );
      if (delRes.rowCount === 0) throw new TariffNotFoundError('Reference rate plan period not found');
      await applyEstimatesOnClient(client, siteId, siteLocalDateString(new Date(), siteRes.rows[0].timezone || 'UTC'), 'reference');
      await bumpSiteTimelineRevisionOnClient(client, siteId);
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

  async applySelection(
    siteId: string,
    input: ApplyTariffSelectionInput
  ): Promise<ApplyTariffSelectionResult & { timeline: SiteTariffsTimelineResponse }> {
    const client = await pool.connect();
    let result: ApplyTariffSelectionResult;
    let reattribution: EnqueueReattributionParams | null = null;
    let queued: EnqueuedReattribution | null = null;
    try {
      await client.query('BEGIN');
      const siteRes = await client.query<{ timezone: string }>(
        'SELECT timezone FROM "Site" WHERE id = $1 FOR UPDATE',
        [siteId]
      );
      if (!siteRes.rows[0]) throw new TariffNotFoundError('Site not found');
      const today = siteLocalDateString(new Date(), siteRes.rows[0].timezone || 'UTC');
      result = await applyTariffSelectionOnClient(client, siteId, today, input);
      if (input.scope === 'actual' && result.reattributionRange) {
        reattribution = {
          siteId,
          fromDate: result.reattributionRange.fromDate,
          toDate: result.reattributionRange.toDate,
          requestedByUserId: input.userId,
          trigger: 'update',
        };
        queued = await enqueueReattributionOnClient(client, reattribution);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    if (!result.unchanged) {
      new SiteRepo().invalidateCache(siteId);
    }
    if (reattribution && queued) {
      logReattributionEnqueued(reattribution, queued);
    }
    return {
      ...result,
      timeline: await this.getTimeline(siteId, input.userId),
    };
  }

  async commitReviewedSelection(
    siteId: string,
    input: CommitReviewedSelectionInput
  ): Promise<ApplyTariffSelectionResult & { timeline: SiteTariffsTimelineResponse }> {
    const { userId, commit, publicRate, resolvePublicPlan, deriveEligibility } = input;
    const now = input.now ?? new Date();
    const client = await pool.connect();
    let result: ApplyTariffSelectionResult;
    let reattribution: EnqueueReattributionParams | null = null;
    let queued: EnqueuedReattribution | null = null;

    try {
      await client.query('BEGIN');
      const siteRes = await client.query<{
        id: string;
        timezone: string;
        currency: string;
        rate_country?: string | null;
      }>(
        `SELECT id, timezone,
                COALESCE(json -> 'tariff_content_v2' ->> 'currency', json ->> 'currency', 'USD') AS currency,
                rate_country
         FROM "Site" WHERE id = $1 FOR UPDATE`,
        [siteId]
      );
      const site = siteRes.rows[0];
      if (!site) throw new TariffNotFoundError('Site not found');

      const timezone = site.timezone || 'UTC';
      const currency = site.currency || 'USD';
      const today = siteLocalDateString(now, timezone);
      validateEffectiveDates(commit.effectiveFrom, commit.effectiveTo, today);
      if (commit.scope === 'reference' && commit.candidate.kind === 'restore_tesla') {
        throw new TariffValidationError('Tesla restoration is only available for your rate plan.');
      }

      const eligibility = deriveEligibility
        ? deriveEligibility({ rateCountry: site.rate_country ?? null })
        : deriveRatePlanEligibility(site.rate_country ?? null);
      if (commit.candidate.kind === 'public') {
        assertUsRatePlanEligibility(eligibility);
      }

      const utilityRes = await client.query<{
        urdb_utility: string | null;
        choice: 'auto' | 'owner' | 'skipped' | null;
      }>(
        'SELECT urdb_utility, choice FROM "SiteUtility" WHERE site_id = $1',
        [siteId]
      );
      const utilityRow = utilityRes.rows[0];
      const utilityName = utilityRow?.urdb_utility ?? null;
      const utilityChoice = utilityRow?.choice ?? null;

      const existingSpans = await loadScopeSelectionSpans(client, siteId, commit.scope, userId);
      const restorationTargets = commit.candidate.kind === 'restore_tesla'
        ? await loadRestorationTargets(
            client,
            siteId,
            commit.scope,
            commit.candidate.originalSelectionId,
            commit.effectiveFrom,
            commit.effectiveTo
          )
        : [];

      let candidatePlan: TariffReviewPlanSnapshot | null = null;
      let applyCandidate: ApplyTariffSelectionCandidate;
      let conversionInputs: ConversionInputsRecord | undefined;

      if (commit.candidate.kind === 'public') {
        if (!utilityName || utilityChoice === 'skipped') {
          throw new UtilityChangedError('Choose a utility first.');
        }
        if (!publicRate || utilityName !== publicRate.preLockUtilityName) {
          throw new UtilityChangedError('Utility changed. Choose a rate plan again.');
        }
        if (currency.trim().toUpperCase() !== 'USD') {
          throw new TariffValidationError(
            `Public utility rate plans are billed in USD and cannot be applied to a site in ${currency.trim().toUpperCase()}.`
          );
        }
        const fallback = await loadSiteSellFallbackOnClient(client, siteId, commit.effectiveFrom);
        const resolved = resolvePublicPlan({
          rate: publicRate.rate,
          siteCurrency: currency,
          utilityName,
          effectiveFrom: commit.effectiveFrom,
          effectiveTo: commit.effectiveTo,
          todaySiteLocal: today,
          medianMonthlyKwh: publicRate.medianMonthlyKwh,
          fallbackSellRate: fallback.fallbackSellRate,
          hasTeslaSellFallback: fallback.hasTeslaSellFallback,
        });
        candidatePlan = resolved.candidatePlan;
        applyCandidate = resolved.applyCandidate;
        conversionInputs = resolved.conversionInputs;
      } else if (commit.candidate.kind === 'manual') {
        const parsed = compileSeasonsToParsedTariff(commit.candidate.name, commit.candidate.seasons);
        const contentHash = tariffContentHash(parsed);
        candidatePlan = {
          tariffId: null,
          version: null,
          periodId: null,
          selectionId: null,
          name: commit.candidate.name,
          utilityName: null,
          source: 'manual',
          choiceKind: 'owner',
          urdbLabel: null,
          revisionStart: null,
          contentHash,
          exportRateProvenance: 'manual',
          holidaysUseWeekendSchedule: true,
          seasons: commit.candidate.seasons,
          approximationNotes: [],
          verification: null,
        };
        applyCandidate = {
          kind: 'manual',
          name: commit.candidate.name,
          seasons: commit.candidate.seasons,
          holidaysUseWeekendSchedule: true,
        };
      } else {
        applyCandidate = {
          kind: 'restore_tesla',
          originalSelectionId: commit.candidate.originalSelectionId,
        };
      }

      const currentPreview = buildTariffSelectionPreview({
        siteId,
        timezone,
        currency,
        todaySiteLocal: today,
        holidaysUseWeekendSchedule: true,
        request: {
          scope: commit.scope,
          candidate: commit.candidate,
          effectiveFrom: commit.effectiveFrom,
          effectiveTo: commit.effectiveTo,
        },
        existingSpans,
        candidatePlan,
        restorationTargets,
        eligibility,
        conversionInputs,
      });

      if (currentPreview.reviewHash !== commit.expectedReviewHash) {
        const retryResult = await findIdempotentRetryOnClient(
          client,
          siteId,
          userId,
          commit,
          candidatePlan,
          existingSpans,
          restorationTargets
        );
        if (!retryResult) {
          throw new TariffSelectionConflictError(siteId, currentPreview);
        }
        result = retryResult;
      } else {
        result = await applyTariffSelectionOnClient(client, siteId, today, {
          scope: commit.scope,
          effectiveFrom: commit.effectiveFrom,
          effectiveTo: commit.effectiveTo,
          userId,
          verifiedAgainstBill: commit.verifiedAgainstBill,
          candidate: applyCandidate,
          reviewHash: commit.expectedReviewHash,
        });
        if (commit.scope === 'actual' && result.reattributionRange) {
          reattribution = {
            siteId,
            fromDate: result.reattributionRange.fromDate,
            toDate: result.reattributionRange.toDate,
            requestedByUserId: userId,
            trigger: 'update',
          };
          queued = await enqueueReattributionOnClient(client, reattribution);
        }
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    if (!result.unchanged) {
      new SiteRepo().invalidateCache(siteId);
    }
    if (reattribution && queued) {
      logReattributionEnqueued(reattribution, queued);
    }
    logEvent('info', 'tariff.selection.committed', {
      scope: commit.scope,
      candidateKind: commit.candidate.kind,
      effectiveFrom: commit.effectiveFrom,
      effectiveTo: commit.effectiveTo,
      unchanged: result.unchanged,
      verifiedAgainstBill: commit.verifiedAgainstBill,
      accountId: accountFingerprint(userId),
    });
    return {
      ...result,
      timeline: await this.getTimeline(siteId, userId),
    };
  }

  async getSelectionAuditHistory(
    siteId: string,
    scope: TariffSelectionScope,
    viewerUserId: string | null
  ): Promise<SelectionAuditRecord[]> {
    const selectionsRes = await pool.query<TariffSelectionRow>(
      `SELECT id, site_id, scope, tariff_id, effective_from::text, effective_to::text,
              source, choice_kind, candidate_kind, selected_by_user_id,
              urdb_label, utility_name, revision_start::text, export_rate_provenance,
              holidays_use_weekend, approximation_notes, selected_content_hash,
              restored_from_selection_id, created_at
       FROM "TariffSelection"
       WHERE site_id = $1 AND scope = $2
       ORDER BY id ASC`,
      [siteId, scope]
    );
    if (selectionsRes.rows.length === 0) return [];
    const ids = selectionsRes.rows.map(r => Number(r.id));
    const [origRes, verRes] = await Promise.all([
      pool.query<TariffSelectionOriginalRow>(
        `SELECT id, selection_id, site_id, scope, effective_from::text, effective_to::text,
                original_tariff_id, original_selection_id, created_at
         FROM "TariffSelectionOriginal"
         WHERE selection_id = ANY($1::int[])
         ORDER BY effective_from ASC, id ASC`,
        [ids]
      ),
      pool.query<TariffSelectionVerificationRow & { verified_by_email: string | null }>(
        `SELECT v.id, v.selection_id, v.site_id, v.scope, v.tariff_id, v.tariff_content_hash,
                v.effective_from::text, v.effective_to::text, v.verified_by_user_id, v.verified_at,
                u.email AS verified_by_email
         FROM "TariffSelectionVerification" v
         LEFT JOIN "User" u ON u.id = v.verified_by_user_id
         WHERE v.selection_id = ANY($1::int[])`,
        [ids]
      ),
    ]);

    const originalsBySel = new Map<number, TariffSelectionOriginalRow[]>();
    for (const row of origRes.rows) {
      const sid = Number(row.selection_id);
      const list = originalsBySel.get(sid) ?? [];
      list.push({
        ...row,
        id: Number(row.id),
        selection_id: sid,
        effective_from: row.effective_from.slice(0, 10),
        effective_to: row.effective_to ? row.effective_to.slice(0, 10) : null,
        original_tariff_id: Number(row.original_tariff_id),
        original_selection_id: row.original_selection_id === null ? null : Number(row.original_selection_id),
      });
      originalsBySel.set(sid, list);
    }

    const verBySel = new Map<number, SelectionAuditRecord['verification']>();
    for (const row of verRes.rows) {
      const sid = Number(row.selection_id);
      verBySel.set(sid, {
        id: Number(row.id),
        selection_id: sid,
        site_id: row.site_id,
        scope: row.scope,
        tariff_id: Number(row.tariff_id),
        tariff_content_hash: row.tariff_content_hash,
        effective_from: row.effective_from.slice(0, 10),
        effective_to: row.effective_to ? row.effective_to.slice(0, 10) : null,
        verified_by_user_id: row.verified_by_user_id,
        verified_at: row.verified_at,
        verifiedByEmail: row.verified_by_email ?? null,
        verifiedByCurrentUser: viewerUserId !== null && row.verified_by_user_id === viewerUserId,
      });
    }

    return selectionsRes.rows.map(sel => {
      const sid = Number(sel.id);
      return {
        selection: {
          ...sel,
          id: sid,
          tariff_id: Number(sel.tariff_id),
          effective_from: sel.effective_from.slice(0, 10),
          effective_to: sel.effective_to ? sel.effective_to.slice(0, 10) : null,
          revision_start: sel.revision_start ? sel.revision_start.slice(0, 10) : null,
          restored_from_selection_id: sel.restored_from_selection_id === null ? null : Number(sel.restored_from_selection_id),
        },
        originals: originalsBySel.get(sid) ?? [],
        verification: verBySel.get(sid) ?? null,
      };
    });
  }

  async loadAiHandoffSpans(
    siteId: string,
    viewerUserId: string | null
  ): Promise<{
    actualSpans: ExistingTimelineSpanInput[];
    referenceSpans: ExistingTimelineSpanInput[];
  }> {
    const [actualSpans, referenceSpans] = await Promise.all([
      loadScopeSelectionSpans(pool, siteId, 'actual', viewerUserId),
      loadScopeSelectionSpans(pool, siteId, 'reference', viewerUserId),
    ]);
    return { actualSpans, referenceSpans };
  }

  async commitAiHandoffSelections(
    siteId: string,
    input: {
      userId: string;
      rawInput: string;
      expectedReviewHash: string;
      verifiedAgainstBill: boolean;
      now?: Date;
    }
  ): Promise<import('./tariff-contract').TariffAiHandoffCommitResponse> {
    const { userId, rawInput, expectedReviewHash, verifiedAgainstBill } = input;
    const now = input.now ?? new Date();
    const client = await pool.connect();
    const selectionIds: number[] = [];
    const tariffIds: number[] = [];
    let appliedActualCount = 0;
    let appliedReferenceCount = 0;
    let reattributionFrom: string | null = null;
    let reattributionTo: string | null = null;
    let hasReattribution = false;
    let reattribution: EnqueueReattributionParams | null = null;
    let queued: EnqueuedReattribution | null = null;

    try {
      await client.query('BEGIN');
      const siteRes = await client.query<{
        id: string;
        timezone: string;
        currency: string;
        rate_country?: string | null;
      }>(
        `SELECT id, timezone,
                COALESCE(json -> 'tariff_content_v2' ->> 'currency', json ->> 'currency', 'USD') AS currency,
                rate_country
         FROM "Site" WHERE id = $1 FOR UPDATE`,
        [siteId]
      );
      const site = siteRes.rows[0];
      if (!site) throw new TariffNotFoundError('Site not found');

      const timezone = site.timezone || 'UTC';
      const currency = (site.currency || 'USD').trim().toUpperCase();
      const today = siteLocalDateString(now, timezone);
      const eligibility = deriveRatePlanEligibility(site.rate_country ?? null);

      const actualSpans = await loadScopeSelectionSpans(client, siteId, 'actual', userId);
      const referenceSpans = await loadScopeSelectionSpans(client, siteId, 'reference', userId);

      const built = buildBatchAiHandoffPreviewWithDetails({
        siteId,
        timezone,
        currency,
        todaySiteLocal: today,
        eligibility,
        rawInput,
        actualSpans,
        referenceSpans,
      });

      if (built.response.reviewHash !== expectedReviewHash) {
        throw new TariffAiHandoffConflictError(built.response);
      }

      const effectiveVerified = verifiedAgainstBill || built.citesUtilityBill;

      for (const item of [...built.changedActual, ...built.changedReference]) {
        const res = await applyTariffSelectionOnClient(client, siteId, today, {
          scope: item.scope,
          effectiveFrom: item.period.effectiveFrom,
          effectiveTo: item.period.effectiveTo,
          userId,
          verifiedAgainstBill: effectiveVerified,
          candidate: {
            kind: 'manual',
            name: item.period.name,
            seasons: item.period.seasons,
            holidaysUseWeekendSchedule: true,
          },
          candidateKindOverride: 'ai_handoff',
          allowMinuteResolution: true,
          reviewHash: item.preview.reviewHash,
        });
        selectionIds.push(...res.selectionIds);
        tariffIds.push(...res.tariffIds);
        if (!res.unchanged) {
          if (item.scope === 'actual') appliedActualCount += 1;
          else appliedReferenceCount += 1;
        }
        if (item.scope === 'actual' && res.reattributionRange) {
          if (!hasReattribution) {
            hasReattribution = true;
            reattributionFrom = res.reattributionRange.fromDate;
            reattributionTo = res.reattributionRange.toDate;
          } else {
            reattributionFrom = minDate(reattributionFrom as string, res.reattributionRange.fromDate);
            reattributionTo = maxEnd(reattributionTo, res.reattributionRange.toDate);
          }
        }
      }

      if (hasReattribution && reattributionFrom !== null) {
        reattribution = {
          siteId,
          fromDate: reattributionFrom,
          toDate: reattributionTo,
          requestedByUserId: userId,
          trigger: 'update',
        };
        queued = await enqueueReattributionOnClient(client, reattribution);
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    const unchanged = appliedActualCount === 0 && appliedReferenceCount === 0;
    if (!unchanged) {
      new SiteRepo().invalidateCache(siteId);
    }
    if (reattribution && queued) {
      logReattributionEnqueued(reattribution, queued);
    }
    logEvent('info', 'tariff.ai_handoff.committed', {
      appliedActualCount,
      appliedReferenceCount,
      unchanged,
      verifiedAgainstBill,
      accountId: accountFingerprint(userId),
    });

    return {
      selectionIds,
      tariffIds: [...new Set(tariffIds)],
      appliedActualCount,
      appliedReferenceCount,
      unchanged,
      reattributionRange:
        hasReattribution && reattributionFrom !== null
          ? { fromDate: reattributionFrom, toDate: reattributionTo }
          : null,
      timeline: await this.getTimeline(siteId, userId),
    };
  }
}

async function loadScopeSpans(client: Pick<PoolClient, 'query'>, siteId: string, scope: TariffSelectionScope): Promise<ExistingSpan[]> {
  return scope === 'actual' ? loadExistingSpans(client, siteId) : loadReferenceSpans(client, siteId);
}

async function applyScopeSpanMutationPlan(
  client: Pick<PoolClient, 'query'>,
  siteId: string,
  scope: TariffSelectionScope,
  plan: SpanMutationPlan
): Promise<void> {
  if (scope === 'actual') {
    await applySpanMutationPlan(client, siteId, plan);
  } else {
    await applyReferenceSpanMutationPlan(client, siteId, plan);
  }
}

async function loadReferenceSpans(client: Pick<PoolClient, 'query'>, siteId: string): Promise<ExistingSpan[]> {
  const res = await client.query<{
    id: number;
    tariff_id: number;
    source: TariffSource;
    effective_from: string;
    effective_to: string | null;
    updated_by_user_id: string | null;
    selection_id?: number | null;
    choice_kind?: TariffSelectionChoiceKind | null;
  }>(
    `SELECT p.id, p.tariff_id, p.source, p.effective_from::text, p.effective_to::text, p.updated_by_user_id,
            p.selection_id,
            (SELECT s.choice_kind FROM "TariffSelection" s WHERE s.id = p.selection_id) AS choice_kind
     FROM "TariffReferencePeriod" p
     WHERE p.site_id = $1
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
    ...(r.selection_id !== undefined ? { selectionId: r.selection_id === null ? null : Number(r.selection_id) } : {}),
    ...(r.choice_kind ? { choiceKind: r.choice_kind } : {}),
  }));
}

async function applyReferenceSpanMutationPlan(
  client: Pick<PoolClient, 'query'>,
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
      `INSERT INTO "TariffReferencePeriod"(site_id, tariff_id, effective_from, effective_to, updated_by_user_id, source, selection_id)
       VALUES ($1, $2, $3::date, $4::date, $5, $6, $7)
       RETURNING id`,
      [siteId, row.tariffId, row.effectiveFrom, row.effectiveTo, row.updatedByUserId, row.source, row.selectionId ?? null]
    );
    inserted.push({ id: Number(res.rows[0]?.id ?? 0), tariffId: row.tariffId });
  }
  return inserted;
}
