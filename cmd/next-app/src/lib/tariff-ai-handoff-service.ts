import { createHash } from 'crypto';
import { tariffContentHash } from './importer/tariff-parser';
import { deriveRatePlanEligibility, type RatePlanEligibility } from './rate-plan-eligibility';
import { parseRatePlanAiHandoffInput, sourcesCiteUtilityBill } from './tariff-ai-handoff';
import type {
  TariffAiHandoffCommitResponse,
  TariffAiHandoffPreviewResponse,
  TariffReviewPlanSnapshot,
  TariffSelectionPreviewResponse,
  TariffSelectionScope,
} from './tariff-contract';
import {
  buildTariffSelectionPreview,
  type ExistingTimelineSpanInput,
} from './tariff-selection';
import {
  addCalendarDays,
  compileSeasonsToParsedTariff,
  MAX_PLAN_NAME_LENGTH,
  siteLocalDateString,
  TariffValidationError,
  type TariffPlanWriteInput,
} from './tariff-timeline';
import { TariffNotFoundError, TariffTimelineRepo } from './tariff-timeline-repo';

export class TariffAiHandoffConflictError extends Error {
  readonly status = 409;
  readonly code = 'REVIEW_STALE' as const;
  readonly preview: TariffAiHandoffPreviewResponse;

  constructor(preview: TariffAiHandoffPreviewResponse) {
    super('Your rate plans changed while you were reviewing. Review the updated changes before applying.');
    this.name = 'TariffAiHandoffConflictError';
    this.preview = preview;
  }
}

export interface PreparedAiHandoffPeriod {
  scope: TariffSelectionScope;
  period: TariffPlanWriteInput;
  contentHash: string;
  preview: TariffSelectionPreviewResponse;
}

export interface BuiltBatchAiHandoffPreview {
  response: TariffAiHandoffPreviewResponse;
  changedActual: PreparedAiHandoffPeriod[];
  changedReference: PreparedAiHandoffPeriod[];
  citesUtilityBill: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function disambiguateBatchPlanName(
  baseName: string,
  contentHash: string,
  effectiveFrom: string,
  effectiveTo: string | null,
  existingSpans: ExistingTimelineSpanInput[],
  assignedInBatch: Array<{ name: string; contentHash: string }>
): string {
  const trimmed = baseName.trim();
  const isNameTaken = (candidate: string): boolean => {
    const lower = candidate.trim().toLowerCase();
    const clashInBatch = assignedInBatch.some(
      a => a.name.trim().toLowerCase() === lower && a.contentHash !== contentHash
    );
    if (clashInBatch) return true;

    return existingSpans.some(span => {
      if (span.plan.source === 'estimated' && span.plan.choiceKind !== 'owner') return false;
      const fullyReplaced =
        span.effectiveFrom >= effectiveFrom &&
        (effectiveTo === null || (span.effectiveTo !== null && span.effectiveTo <= effectiveTo));
      if (fullyReplaced) return false;
      return span.plan.name.trim().toLowerCase() === lower && span.plan.contentHash !== contentHash;
    });
  };

  const withSuffix = (suffix: string) =>
    `${trimmed.slice(0, MAX_PLAN_NAME_LENGTH - suffix.length).trimEnd()}${suffix}`;
  const candidates = [
    trimmed,
    withSuffix(` (${effectiveFrom.slice(0, 4)})`),
    withSuffix(` (${effectiveFrom})`),
  ];
  for (const c of candidates) {
    if (!isNameTaken(c)) return c;
  }
  for (let i = 2; ; i++) {
    const c = withSuffix(` (${effectiveFrom}, ${i})`);
    if (!isNameTaken(c)) return c;
  }
}

function simulateSpanReplacement(
  spans: ExistingTimelineSpanInput[],
  incoming: TariffPlanWriteInput,
  candidatePlan: TariffReviewPlanSnapshot
): ExistingTimelineSpanInput[] {
  const next: ExistingTimelineSpanInput[] = [];
  for (const span of spans) {
    const overlaps =
      (span.effectiveTo === null || span.effectiveTo >= incoming.effectiveFrom) &&
      (incoming.effectiveTo === null || incoming.effectiveTo >= span.effectiveFrom);
    if (!overlaps) {
      next.push(span);
      continue;
    }
    if (span.effectiveFrom < incoming.effectiveFrom) {
      next.push({
        ...span,
        effectiveTo: addCalendarDays(incoming.effectiveFrom, -1),
      });
    }
    if (incoming.effectiveTo !== null && (span.effectiveTo === null || span.effectiveTo > incoming.effectiveTo)) {
      next.push({
        ...span,
        effectiveFrom: addCalendarDays(incoming.effectiveTo, 1),
      });
    }
  }
  next.push({
    effectiveFrom: incoming.effectiveFrom,
    effectiveTo: incoming.effectiveTo,
    plan: candidatePlan,
  });
  return next.sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
}

function prepareScopePreviews(params: {
  siteId: string;
  timezone: string;
  currency: string;
  todaySiteLocal: string;
  eligibility: RatePlanEligibility;
  scope: TariffSelectionScope;
  periods: TariffPlanWriteInput[];
  initialSpans: ExistingTimelineSpanInput[];
}): {
  unchangedCount: number;
  prepared: PreparedAiHandoffPeriod[];
} {
  let currentSpans = [...params.initialSpans];
  let unchangedCount = 0;
  const prepared: PreparedAiHandoffPeriod[] = [];
  const assignedNames: Array<{ name: string; contentHash: string }> = [];

  for (const rawPeriod of params.periods) {
    const rawParsed = compileSeasonsToParsedTariff(rawPeriod.name, rawPeriod.seasons);
    const rawHash = tariffContentHash(rawParsed);

    const exactMatch = currentSpans.find(s => {
      if (s.effectiveFrom !== rawPeriod.effectiveFrom || s.effectiveTo !== rawPeriod.effectiveTo) return false;
      if (s.plan.name.trim().toLowerCase() !== rawPeriod.name.trim().toLowerCase()) return false;
      if (s.plan.approximationNotes.some(n => n.kind === 'day_specific_schedule')) return false;
      const normalizedExistingHash = tariffContentHash(
        compileSeasonsToParsedTariff(s.plan.name, s.plan.seasons)
      );
      return normalizedExistingHash === rawHash;
    });
    if (exactMatch) {
      unchangedCount += 1;
      assignedNames.push({ name: exactMatch.plan.name, contentHash: rawHash });
      continue;
    }

    const finalName =
      params.scope === 'actual'
        ? disambiguateBatchPlanName(
            rawPeriod.name,
            rawHash,
            rawPeriod.effectiveFrom,
            rawPeriod.effectiveTo,
            currentSpans,
            assignedNames
          )
        : rawPeriod.name.trim();
    const period: TariffPlanWriteInput = { ...rawPeriod, name: finalName };
    const parsed = compileSeasonsToParsedTariff(period.name, period.seasons);
    const contentHash = tariffContentHash(parsed);
    assignedNames.push({ name: finalName, contentHash });

    const candidatePlan: TariffReviewPlanSnapshot = {
      tariffId: null,
      version: null,
      periodId: null,
      selectionId: null,
      name: period.name,
      utilityName: null,
      source: 'manual',
      choiceKind: 'owner',
      urdbLabel: null,
      revisionStart: null,
      contentHash,
      exportRateProvenance: 'manual',
      holidaysUseWeekendSchedule: true,
      seasons: period.seasons,
      approximationNotes: [],
      verification: null,
    };

    const preview = buildTariffSelectionPreview({
      siteId: params.siteId,
      timezone: params.timezone,
      currency: params.currency,
      todaySiteLocal: params.todaySiteLocal,
      holidaysUseWeekendSchedule: true,
      request: {
        scope: params.scope,
        candidate: { kind: 'manual', name: period.name, seasons: period.seasons },
        effectiveFrom: period.effectiveFrom,
        effectiveTo: period.effectiveTo,
      },
      existingSpans: currentSpans,
      candidatePlan,
      eligibility: params.eligibility,
      allowMinuteResolution: true,
    });

    prepared.push({ scope: params.scope, period, contentHash, preview });
    currentSpans = simulateSpanReplacement(currentSpans, period, candidatePlan);
  }

  return { unchangedCount, prepared };
}

export function buildBatchAiHandoffPreviewWithDetails(params: {
  siteId: string;
  timezone: string;
  currency: string;
  todaySiteLocal: string;
  eligibility: RatePlanEligibility;
  rawInput: string;
  actualSpans: ExistingTimelineSpanInput[];
  referenceSpans: ExistingTimelineSpanInput[];
}): BuiltBatchAiHandoffPreview {
  const parsed = parseRatePlanAiHandoffInput(params.rawInput, params.todaySiteLocal);

  const actualResult = prepareScopePreviews({
    siteId: params.siteId,
    timezone: params.timezone,
    currency: params.currency,
    todaySiteLocal: params.todaySiteLocal,
    eligibility: params.eligibility,
    scope: 'actual',
    periods: parsed.actualPeriods,
    initialSpans: params.actualSpans,
  });

  const referenceResult = prepareScopePreviews({
    siteId: params.siteId,
    timezone: params.timezone,
    currency: params.currency,
    todaySiteLocal: params.todaySiteLocal,
    eligibility: params.eligibility,
    scope: 'reference',
    periods: parsed.referencePeriods,
    initialSpans: params.referenceSpans,
  });

  const actualPreviews = actualResult.prepared.map(p => p.preview);
  const referencePreviews = referenceResult.prepared.map(p => p.preview);

  let fromDate: string | null = null;
  let toDate: string | null = null;
  let hasNullEnd = false;
  let recalculatesFromHistoryStart = false;

  for (const prev of actualPreviews) {
    if (!prev.recalculatesHistory || !prev.recalculationRange) continue;
    if (prev.recalculatesFromHistoryStart) recalculatesFromHistoryStart = true;
    if (fromDate === null || prev.recalculationRange.fromDate < fromDate) {
      fromDate = prev.recalculationRange.fromDate;
    }
    if (prev.recalculationRange.toDate === null) {
      hasNullEnd = true;
      toDate = null;
    } else if (!hasNullEnd && (toDate === null || prev.recalculationRange.toDate > toDate)) {
      toDate = prev.recalculationRange.toDate;
    }
  }

  const recalculatesHistory = fromDate !== null;
  const recalculationRange = fromDate !== null ? { fromDate, toDate: hasNullEnd ? null : toDate } : null;

  const reviewHash = createHash('sha256')
    .update(
      JSON.stringify({
        siteId: params.siteId,
        actualHashes: actualPreviews.map(p => p.reviewHash),
        referenceHashes: referencePreviews.map(p => p.reviewHash),
        unchangedActualCount: actualResult.unchangedCount,
        unchangedReferenceCount: referenceResult.unchangedCount,
      })
    )
    .digest('hex');

  return {
    response: {
      reviewHash,
      siteId: params.siteId,
      currency: params.currency,
      unit: 'kWh',
      timezone: params.timezone,
      notes: parsed.notes,
      sources: parsed.sources,
      unchangedActualCount: actualResult.unchangedCount,
      unchangedReferenceCount: referenceResult.unchangedCount,
      actualPreviews,
      referencePreviews,
      recalculatesHistory,
      recalculatesFromHistoryStart,
      recalculationRange,
      affectsPowerwallPlan: false,
    },
    changedActual: actualResult.prepared,
    changedReference: referenceResult.prepared,
    citesUtilityBill: sourcesCiteUtilityBill(parsed.sources),
  };
}

export function buildBatchAiHandoffPreview(params: {
  siteId: string;
  timezone: string;
  currency: string;
  todaySiteLocal: string;
  eligibility: RatePlanEligibility;
  rawInput: string;
  actualSpans: ExistingTimelineSpanInput[];
  referenceSpans: ExistingTimelineSpanInput[];
}): TariffAiHandoffPreviewResponse {
  return buildBatchAiHandoffPreviewWithDetails(params).response;
}

export interface TariffAiHandoffServiceDeps {
  now?: () => Date;
  repo?: Pick<
    TariffTimelineRepo,
    'getSiteUtilityContext' | 'loadAiHandoffSpans' | 'commitAiHandoffSelections'
  >;
}

export async function previewAiRatePlanHandoff(
  siteId: string,
  viewerUserId: string,
  rawBody: unknown,
  deps?: TariffAiHandoffServiceDeps
): Promise<TariffAiHandoffPreviewResponse> {
  if (!isPlainObject(rawBody) || typeof rawBody.rawInput !== 'string') {
    throw new TariffValidationError('rawInput is required.');
  }
  const repo = deps?.repo ?? new TariffTimelineRepo();
  const now = (deps?.now ?? (() => new Date()))();
  const site = await repo.getSiteUtilityContext(siteId);
  if (!site) throw new TariffNotFoundError('Site not found');

  const timezone = site.timezone || 'UTC';
  const currency = (site.currency || 'USD').trim().toUpperCase();
  const todaySiteLocal = siteLocalDateString(now, timezone);
  const eligibility = site.eligibility ?? deriveRatePlanEligibility(site.rateCountry ?? null);

  const { actualSpans, referenceSpans } = await repo.loadAiHandoffSpans(siteId, viewerUserId);

  return buildBatchAiHandoffPreview({
    siteId,
    timezone,
    currency,
    todaySiteLocal,
    eligibility,
    rawInput: rawBody.rawInput,
    actualSpans,
    referenceSpans,
  });
}

export async function commitAiRatePlanHandoff(
  siteId: string,
  userId: string,
  rawBody: unknown,
  deps?: TariffAiHandoffServiceDeps
): Promise<TariffAiHandoffCommitResponse> {
  if (!isPlainObject(rawBody) || typeof rawBody.rawInput !== 'string') {
    throw new TariffValidationError('rawInput is required.');
  }
  if (typeof rawBody.expectedReviewHash !== 'string' || rawBody.expectedReviewHash.trim().length === 0) {
    throw new TariffValidationError('expectedReviewHash is required.');
  }
  if (typeof rawBody.verifiedAgainstBill !== 'boolean') {
    throw new TariffValidationError('verifiedAgainstBill must be a boolean.');
  }

  const repo = deps?.repo ?? new TariffTimelineRepo();
  const now = (deps?.now ?? (() => new Date()))();

  return repo.commitAiHandoffSelections(siteId, {
    userId,
    rawInput: rawBody.rawInput,
    expectedReviewHash: rawBody.expectedReviewHash.trim(),
    verifiedAgainstBill: rawBody.verifiedAgainstBill,
    now,
  });
}
