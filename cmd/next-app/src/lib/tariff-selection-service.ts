import type {
  ExportRateProvenance,
  PublicUtilityPlanDTO,
  PublicUtilityPlansResponse,
  TariffApproximationNote,
  TariffReviewPlanSnapshot,
  TariffSeasonInput,
  TariffSelectionCommitResponse,
  TariffSelectionPreviewResponse,
} from './tariff-contract';
import { tariffContentHash } from './importer/tariff-parser';
import {
  buildTariffSelectionPreview,
  type ConversionInputsRecord,
  validateTariffSelectionCommit,
  validateTariffSelectionRequest,
} from './tariff-selection';
import {
  compileSeasonsToParsedTariff,
  siteLocalDateString,
  TariffValidationError,
  validateEffectiveDates,
  validateTariffPlanInput,
} from './tariff-timeline';
import {
  type ResolvedPublicCandidatePlan,
  TariffNotFoundError,
  TariffTimelineRepo,
  UtilityChangedError,
} from './tariff-timeline-repo';
import * as urdbClient from './urdb/client';
import { isFixedRate, urdbRateToSeasons } from './urdb/convert';
import { monthlyUsage as defaultMonthlyUsage, ownerPlanMatchesUtility, type UrdbApi } from './urdb/estimate-job';
import { memoisedApi } from './urdb/memoised-api';
import { urdbStartDate } from './urdb/match';
import {
  assertUsRatePlanEligibility,
  deriveRatePlanEligibility,
  type RatePlanEligibility,
} from './rate-plan-eligibility';
import type { UrdbRate } from './urdb/types';
import { normalizeUtilityName } from './urdb/utility-lookup';

type UrdbRateWithCurrency = UrdbRate & { currency?: unknown };

export interface TariffSelectionServiceDeps {
  now?: () => Date;
  repo?: Pick<
    TariffTimelineRepo,
    | 'getSiteUtilityContext'
    | 'loadSitePublicConversionContext'
    | 'loadSelectionTimelineSnapshot'
    | 'commitReviewedSelection'
    | 'getTimeline'
  >;
  urdb?: Pick<UrdbApi, 'ratesEffectiveOn' | 'rateByLabel'>;
  monthlyUsage?: (siteId: string, timezone: string, now: Date) => Promise<number | null>;
}

function round3(value: number): number {
  const rounded = Math.round(value * 1000) / 1000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function round5(value: number): number {
  const rounded = Math.round(value * 100_000) / 100_000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function siteEligibilityFromContext(ctx: {
  eligibility?: RatePlanEligibility;
  rateCountry?: string | null;
}): RatePlanEligibility {
  if (ctx.eligibility !== undefined) {
    return ctx.eligibility;
  }
  return deriveRatePlanEligibility(ctx.rateCountry ?? null);
}

function assertSiteCurrencySupportsPublicPlans(siteCurrency: string): void {
  const normalized = siteCurrency.trim().toUpperCase();
  if (normalized !== 'USD') {
    throw new TariffValidationError(
      `Public utility rate plans are billed in USD and cannot be applied to a site in ${normalized}.`
    );
  }
}

function assertUrdbRateCurrencyCompatible(rate: UrdbRateWithCurrency, siteCurrency: string): void {
  const normalizedSite = siteCurrency.trim().toUpperCase();
  assertSiteCurrencySupportsPublicPlans(normalizedSite);
  if (rate.currency !== undefined && rate.currency !== null) {
    if (typeof rate.currency !== 'string' || rate.currency.trim().toUpperCase() !== normalizedSite) {
      const rateCurrency = typeof rate.currency === 'string' ? rate.currency.trim().toUpperCase() : 'unknown';
      throw new TariffValidationError(
        `This public rate plan uses ${rateCurrency} and does not match your site currency (${normalizedSite}).`
      );
    }
  }
}

function collectUsedScheduleIndices(rate: UrdbRate): number[] {
  const indices = new Set<number>();
  for (const row of rate.energyweekdayschedule ?? []) {
    for (const idx of row) {
      if (Number.isInteger(idx)) indices.add(idx);
    }
  }
  for (const row of rate.energyweekendschedule ?? []) {
    for (const idx of row) {
      if (Number.isInteger(idx)) indices.add(idx);
    }
  }
  return [...indices];
}

export type PublicRateConversionResult =
  | {
      ok: true;
      name: string;
      seasons: TariffSeasonInput[];
      contentHash: string;
      revisionStart: string;
      kind: 'fixed' | 'time_of_use';
      isDefault: boolean;
      exportRateProvenance: ExportRateProvenance;
      approximationNotes: TariffApproximationNote[];
    }
  | { ok: false; reason: string };

export function convertUrdbRateWithProvenance(
  rate: UrdbRateWithCurrency,
  ctx: {
    siteCurrency: string;
    effectiveFrom: string;
    effectiveTo: string | null;
    todaySiteLocal: string;
    medianMonthlyKwh: number | null;
    fallbackSellRate: number;
    hasTeslaSellFallback: boolean;
  }
): PublicRateConversionResult {
  try {
    assertUrdbRateCurrencyCompatible(rate, ctx.siteCurrency);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'Currency is incompatible.' };
  }

  const revisionStart = urdbStartDate(rate);
  if (revisionStart === null) {
    return { ok: false, reason: 'This public rate plan is missing an effective start date.' };
  }

  const converted = urdbRateToSeasons(rate, {
    medianMonthlyKwh: ctx.medianMonthlyKwh,
    fallbackSellRate: ctx.fallbackSellRate,
  });
  if (!converted.ok) {
    return {
      ok: false,
      reason: 'This public rate plan cannot be converted into supported seasons and rate periods.',
    };
  }

  let validated;
  try {
    validated = validateTariffPlanInput(
      {
        name: converted.name,
        effectiveFrom: ctx.effectiveFrom,
        effectiveTo: ctx.effectiveTo,
        seasons: converted.seasons,
      },
      ctx.todaySiteLocal
    );
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : 'This public rate plan uses unsupported rates or schedule periods.',
    };
  }

  const usedIndices = collectUsedScheduleIndices(rate);
  const structure = rate.energyratestructure ?? [];
  const hasTieredUsage = usedIndices.some(idx => (structure[idx]?.length ?? 0) > 1);
  const allExportsPublished = usedIndices.every(idx => {
    const sell = structure[idx]?.[0]?.sell;
    return typeof sell === 'number' && Number.isFinite(sell);
  });

  const approximationNotes: TariffApproximationNote[] = [];
  if (hasTieredUsage) {
    approximationNotes.push({
      kind: 'tier_blended',
      message:
        ctx.medianMonthlyKwh !== null && ctx.medianMonthlyKwh > 0
          ? `Tiered grid rates were blended using your recent monthly home use (${Math.round(ctx.medianMonthlyKwh)} kWh/month).`
          : 'Tiered grid rates use the base tier because recent monthly home use is unavailable.',
    });
  }

  let exportRateProvenance: ExportRateProvenance;
  if (allExportsPublished) {
    exportRateProvenance = 'published';
  } else if (rate.dgrules === 'Net Metering') {
    exportRateProvenance = 'net_metering';
    approximationNotes.push({
      kind: 'export_net_metering_assumed',
      message:
        'Export rates match grid rates under Net Metering rules because separate export prices were not published.',
    });
  } else if (ctx.hasTeslaSellFallback) {
    exportRateProvenance = 'inherited';
    approximationNotes.push({
      kind: 'export_inherited_from_tesla',
      message:
        'Export rates were inherited from your saved Tesla rate plan rather than published in public utility rates.',
    });
  } else {
    exportRateProvenance = 'inherited';
    approximationNotes.push({
      kind: 'export_fallback_zero',
      message: 'Public utility rates did not publish export prices, so export rates default to $0.00/kWh.',
    });
  }

  const parsed = compileSeasonsToParsedTariff(validated.name, validated.seasons);
  const contentHash = tariffContentHash(parsed);

  return {
    ok: true,
    name: validated.name,
    seasons: validated.seasons,
    contentHash,
    revisionStart,
    kind: isFixedRate(rate) ? 'fixed' : 'time_of_use',
    isDefault: Boolean(rate.is_default),
    exportRateProvenance,
    approximationNotes,
  };
}

function buildResolvedPublicPlan(ctx: {
  rate: UrdbRate;
  siteCurrency: string;
  utilityName: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  todaySiteLocal: string;
  medianMonthlyKwh: number | null;
  fallbackSellRate: number;
  hasTeslaSellFallback: boolean;
}): ResolvedPublicCandidatePlan {
  const conversion = convertUrdbRateWithProvenance(ctx.rate, ctx);
  if (!conversion.ok) {
    throw new TariffValidationError(conversion.reason);
  }

  const candidatePlan: TariffReviewPlanSnapshot = {
    tariffId: null,
    version: null,
    periodId: null,
    selectionId: null,
    name: conversion.name,
    utilityName: ctx.utilityName,
    source: 'estimated',
    choiceKind: 'owner',
    urdbLabel: ctx.rate.label,
    revisionStart: conversion.revisionStart,
    contentHash: conversion.contentHash,
    exportRateProvenance: conversion.exportRateProvenance,
    holidaysUseWeekendSchedule: true,
    seasons: conversion.seasons,
    approximationNotes: conversion.approximationNotes,
    verification: null,
  };

  const conversionInputs: ConversionInputsRecord = {
    medianMonthlyKwh: ctx.medianMonthlyKwh,
    fallbackSellRate: round5(ctx.fallbackSellRate),
    hasTeslaSellFallback: ctx.hasTeslaSellFallback,
    siteCurrency: ctx.siteCurrency,
  };

  return {
    candidatePlan,
    applyCandidate: {
      kind: 'public',
      name: conversion.name,
      seasons: conversion.seasons,
      urdbLabel: ctx.rate.label,
      utilityName: ctx.utilityName,
      revisionStart: conversion.revisionStart,
      exportRateProvenance: conversion.exportRateProvenance,
      approximationNotes: conversion.approximationNotes,
      holidaysUseWeekendSchedule: true,
    },
    conversionInputs,
  };
}

function buildManualCandidateSnapshot(name: string, seasons: TariffSeasonInput[]): TariffReviewPlanSnapshot {
  const parsed = compileSeasonsToParsedTariff(name, seasons);
  return {
    tariffId: null,
    version: null,
    periodId: null,
    selectionId: null,
    name,
    utilityName: null,
    source: 'manual',
    choiceKind: 'owner',
    urdbLabel: null,
    revisionStart: null,
    contentHash: tariffContentHash(parsed),
    exportRateProvenance: 'manual',
    holidaysUseWeekendSchedule: true,
    seasons,
    approximationNotes: [],
    verification: null,
  };
}

async function resolvePublicRateForSite(
  urdb: Pick<UrdbApi, 'ratesEffectiveOn' | 'rateByLabel'>,
  utilityName: string,
  label: string,
  effectiveFrom: string,
  timezone: string,
  siteCurrency: string
): Promise<UrdbRate> {
  const selected = await urdb.rateByLabel(label);
  if (!selected) {
    throw new TariffValidationError('That public rate plan could not be found.');
  }
  assertUrdbRateCurrencyCompatible(selected, siteCurrency);

  const directMatch = normalizeUtilityName(selected.utility) === normalizeUtilityName(utilityName);
  if (!directMatch) {
    const inEffect = await urdb.ratesEffectiveOn(utilityName, effectiveFrom, timezone);
    if (!ownerPlanMatchesUtility(selected, utilityName, inEffect)) {
      throw new TariffValidationError('That rate plan is not listed for your utility.');
    }
  }

  return selected;
}

function resolveServiceDeps(deps?: TariffSelectionServiceDeps) {
  const memo = memoisedApi(urdbClient);
  return {
    now: deps?.now ?? (() => new Date()),
    repo: deps?.repo ?? new TariffTimelineRepo(),
    urdb: deps?.urdb ?? memo,
    monthlyUsage: deps?.monthlyUsage ?? defaultMonthlyUsage,
  };
}

export async function listPublicUtilityPlansForSite(
  siteId: string,
  opts: { effectiveDate?: string | null; now?: Date } = {},
  deps?: TariffSelectionServiceDeps
): Promise<PublicUtilityPlansResponse> {
  const { now: getNow, repo, urdb, monthlyUsage } = resolveServiceDeps(deps);
  const now = opts.now ?? getNow();

  const site = await repo.getSiteUtilityContext(siteId);
  if (!site) throw new TariffNotFoundError('Site not found');

  const timezone = site.timezone || 'UTC';
  const siteCurrency = (site.currency || 'USD').trim().toUpperCase();
  const today = siteLocalDateString(now, timezone);

  let effectiveDate = today;
  if (opts.effectiveDate !== undefined && opts.effectiveDate !== null) {
    effectiveDate = opts.effectiveDate.trim();
    validateEffectiveDates(effectiveDate, null, today);
  }

  assertUsRatePlanEligibility(siteEligibilityFromContext(site));

  const utility = site.name;
  if (!utility || site.choice === 'skipped') {
    throw new UtilityChangedError('Choose a utility first.');
  }
  assertSiteCurrencySupportsPublicPlans(siteCurrency);

  const loadFallback = typeof repo.loadSitePublicConversionContext === 'function'
    ? repo.loadSitePublicConversionContext(siteId, effectiveDate)
    : Promise.resolve({ fallbackSellRate: 0, hasTeslaSellFallback: false });

  const [rates, rawMonthly, fallback] = await Promise.all([
    urdb.ratesEffectiveOn(utility, effectiveDate, timezone),
    monthlyUsage(siteId, timezone, now),
    loadFallback,
  ]);
  const medianMonthlyKwh = rawMonthly === null ? null : round3(rawMonthly);

  const plans: PublicUtilityPlanDTO[] = [];
  for (const rate of rates) {
    const converted = convertUrdbRateWithProvenance(rate, {
      siteCurrency,
      effectiveFrom: effectiveDate,
      effectiveTo: null,
      todaySiteLocal: today,
      medianMonthlyKwh,
      fallbackSellRate: fallback.fallbackSellRate,
      hasTeslaSellFallback: fallback.hasTeslaSellFallback,
    });
    if (!converted.ok) continue;
    plans.push({
      label: rate.label,
      name: converted.name,
      utilityName: utility,
      startDate: converted.revisionStart,
      revisionStart: converted.revisionStart,
      kind: converted.kind,
      isDefault: converted.isDefault,
      currency: siteCurrency,
      unit: 'kWh',
      holidaysUseWeekendSchedule: true,
      exportRateProvenance: converted.exportRateProvenance,
      seasons: converted.seasons,
      approximationNotes: converted.approximationNotes,
    });
  }

  plans.sort((a, b) => a.name.localeCompare(b.name) || a.label.localeCompare(b.label));

  return {
    utilityName: utility,
    effectiveDate,
    currency: siteCurrency,
    unit: 'kWh',
    plans,
  };
}

async function preparePublicRateOutsideLock(params: {
  siteId: string;
  eligibility: RatePlanEligibility;
  utilityName: string | null;
  utilityChoice: 'auto' | 'owner' | 'skipped' | null;
  siteCurrency: string;
  timezone: string;
  todaySiteLocal: string;
  label: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  now: Date;
  urdb: Pick<UrdbApi, 'ratesEffectiveOn' | 'rateByLabel'>;
  monthlyUsage: (siteId: string, timezone: string, now: Date) => Promise<number | null>;
}): Promise<{ rate: UrdbRate; preLockUtilityName: string; medianMonthlyKwh: number | null }> {
  assertUsRatePlanEligibility(params.eligibility);
  if (!params.utilityName || params.utilityChoice === 'skipped') {
    throw new UtilityChangedError('Choose a utility first.');
  }
  assertSiteCurrencySupportsPublicPlans(params.siteCurrency);

  const [rate, rawMonthly] = await Promise.all([
    resolvePublicRateForSite(
      params.urdb,
      params.utilityName,
      params.label,
      params.effectiveFrom,
      params.timezone,
      params.siteCurrency
    ),
    params.monthlyUsage(params.siteId, params.timezone, params.now),
  ]);
  const medianMonthlyKwh = rawMonthly === null ? null : round3(rawMonthly);

  // Reject unconvertible/unsupported public rates before acquiring any DB lock or loading spans.
  const check = convertUrdbRateWithProvenance(rate, {
    siteCurrency: params.siteCurrency,
    effectiveFrom: params.effectiveFrom,
    effectiveTo: params.effectiveTo,
    todaySiteLocal: params.todaySiteLocal,
    medianMonthlyKwh,
    fallbackSellRate: 0,
    hasTeslaSellFallback: false,
  });
  if (!check.ok) {
    throw new TariffValidationError(check.reason);
  }

  return {
    rate,
    preLockUtilityName: params.utilityName,
    medianMonthlyKwh,
  };
}

export async function previewTariffSelection(
  siteId: string,
  viewerUserId: string,
  rawRequest: unknown,
  deps?: TariffSelectionServiceDeps
): Promise<TariffSelectionPreviewResponse> {
  const { now: getNow, repo, urdb, monthlyUsage } = resolveServiceDeps(deps);
  const now = getNow();

  const site = await repo.getSiteUtilityContext(siteId);
  if (!site) throw new TariffNotFoundError('Site not found');

  const timezone = site.timezone || 'UTC';
  const siteCurrency = (site.currency || 'USD').trim().toUpperCase();
  const today = siteLocalDateString(now, timezone);
  const eligibility = siteEligibilityFromContext(site);

  const validatedRequest = validateTariffSelectionRequest(rawRequest, today);
  if (validatedRequest.scope === 'reference' && validatedRequest.candidate.kind === 'restore_tesla') {
    throw new TariffValidationError('Tesla restoration is only available for your rate plan.');
  }

  const preparedPublic = validatedRequest.candidate.kind === 'public'
    ? await preparePublicRateOutsideLock({
        siteId,
        eligibility,
        utilityName: site.name,
        utilityChoice: site.choice ?? null,
        siteCurrency,
        timezone,
        todaySiteLocal: today,
        label: validatedRequest.candidate.label,
        effectiveFrom: validatedRequest.effectiveFrom,
        effectiveTo: validatedRequest.effectiveTo,
        now,
        urdb,
        monthlyUsage,
      })
    : null;

  const snapshot = await repo.loadSelectionTimelineSnapshot({
    siteId,
    scope: validatedRequest.scope,
    viewerUserId,
    request: validatedRequest,
  });

  if (validatedRequest.candidate.kind === 'manual' && snapshot.manualNameTaken) {
    throw new TariffValidationError(
      `A rate plan named "${validatedRequest.candidate.name.trim()}" already exists. Choose a different name.`
    );
  }

  let candidatePlan: TariffReviewPlanSnapshot | null = null;
  let conversionInputs: ConversionInputsRecord | undefined;

  if (validatedRequest.candidate.kind === 'public' && preparedPublic) {
    const resolved = buildResolvedPublicPlan({
      rate: preparedPublic.rate,
      siteCurrency,
      utilityName: preparedPublic.preLockUtilityName,
      effectiveFrom: validatedRequest.effectiveFrom,
      effectiveTo: validatedRequest.effectiveTo,
      todaySiteLocal: today,
      medianMonthlyKwh: preparedPublic.medianMonthlyKwh,
      fallbackSellRate: snapshot.fallbackSellRate,
      hasTeslaSellFallback: snapshot.hasTeslaSellFallback,
    });
    candidatePlan = resolved.candidatePlan;
    conversionInputs = resolved.conversionInputs;
  } else if (validatedRequest.candidate.kind === 'manual') {
    candidatePlan = buildManualCandidateSnapshot(
      validatedRequest.candidate.name,
      validatedRequest.candidate.seasons
    );
  }

  return buildTariffSelectionPreview({
    siteId,
    timezone,
    currency: siteCurrency,
    todaySiteLocal: today,
    holidaysUseWeekendSchedule: true,
    request: validatedRequest,
    existingSpans: snapshot.existingSpans,
    candidatePlan,
    restorationTargets: snapshot.restorationTargets,
    eligibility,
    conversionInputs,
  });
}

export async function commitTariffSelection(
  siteId: string,
  userId: string,
  rawCommit: unknown,
  deps?: TariffSelectionServiceDeps
): Promise<TariffSelectionCommitResponse> {
  const { now: getNow, repo, urdb, monthlyUsage } = resolveServiceDeps(deps);
  const now = getNow();

  const site = await repo.getSiteUtilityContext(siteId);
  if (!site) throw new TariffNotFoundError('Site not found');

  const timezone = site.timezone || 'UTC';
  const siteCurrency = (site.currency || 'USD').trim().toUpperCase();
  const today = siteLocalDateString(now, timezone);
  const eligibility = siteEligibilityFromContext(site);

  const commit = validateTariffSelectionCommit(rawCommit, today);
  if (commit.scope === 'reference' && commit.candidate.kind === 'restore_tesla') {
    throw new TariffValidationError('Tesla restoration is only available for your rate plan.');
  }

  const publicRate = commit.candidate.kind === 'public'
    ? await preparePublicRateOutsideLock({
        siteId,
        eligibility,
        utilityName: site.name,
        utilityChoice: site.choice ?? null,
        siteCurrency,
        timezone,
        todaySiteLocal: today,
        label: commit.candidate.label,
        effectiveFrom: commit.effectiveFrom,
        effectiveTo: commit.effectiveTo,
        now,
        urdb,
        monthlyUsage,
      })
    : undefined;

  return repo.commitReviewedSelection(siteId, {
    userId,
    commit,
    publicRate,
    resolvePublicPlan: buildResolvedPublicPlan,
    deriveEligibility: ({ rateCountry }) => deriveRatePlanEligibility(rateCountry),
    now,
  });
}
