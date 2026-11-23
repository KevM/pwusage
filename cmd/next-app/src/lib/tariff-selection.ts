import { createHash } from 'crypto';
import { REATTRIBUTION_HISTORY_START } from './tariff-reattribution-queue';
import type {
  TariffAlignedSeasonComparison,
  TariffAlignedTimeRow,
  TariffApproximationNote,
  TariffComparisonSlotRate,
  TariffIntervalRestorationProvenance,
  TariffRestorationOriginalRef,
  TariffReviewAffectedInterval,
  TariffReviewAffectedIntervalKind,
  TariffReviewPlanSnapshot,
  TariffReviewUnchangedPeriod,
  TariffSeasonInput,
  TariffSelectionCandidate,
  TariffSelectionCommit,
  TariffSelectionPreviewResponse,
  TariffSelectionRequest,
  TariffSelectionScope,
  TimePeriodWindowInput,
} from './tariff-contract';
import {
  addCalendarDays,
  TariffValidationError,
  validateEffectiveDates,
  validateTariffPlanInput,
} from './tariff-timeline';

const MONTH_MAX_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const RATE_EPSILON = 1e-9;
const UNAVAILABLE_RESTORATION_REASON = 'No saved Tesla rate plan exists for this date range.';

/** 366-day canonical leap year (Jan 1 .. Dec 31 including Feb 29) for full-year season alignment. */
const CANONICAL_YEAR_DAYS: ReadonlyArray<{ month: number; day: number }> = (() => {
  const days: Array<{ month: number; day: number }> = [];
  for (let month = 1; month <= 12; month++) {
    const maxDay = MONTH_MAX_DAYS[month - 1];
    for (let day = 1; day <= maxDay; day++) {
      days.push({ month, day });
    }
  }
  return days;
})();

export interface ExistingTimelineSpanInput {
  effectiveFrom: string;
  effectiveTo: string | null;
  plan: TariffReviewPlanSnapshot;
  /** Saved Tesla original preserved by an earlier override on this span, if any. */
  preservedTeslaOriginal?: TariffRestorationOriginalRef | null;
}

export interface RestorationTargetSpanInput {
  effectiveFrom: string;
  effectiveTo: string | null;
  original: TariffRestorationOriginalRef;
  plan: TariffReviewPlanSnapshot;
}

export type CandidateRevision = Pick<ExistingTimelineSpanInput, 'effectiveFrom' | 'effectiveTo' | 'plan'>;
export type FollowedReferencePlan = { label: string | null; from: string | null };

export type ConversionInputsRecord = Record<string, string | number | boolean | null>;

export interface TariffSelectionReviewInput {
  siteId: string;
  timezone: string;
  currency: string;
  todaySiteLocal: string;
  holidaysUseWeekendSchedule?: boolean;
  request: TariffSelectionRequest;
  existingSpans: ExistingTimelineSpanInput[];
  /** Resolved candidate plan for 'public', 'manual', or single-original 'restore_tesla'. */
  candidatePlan?: TariffReviewPlanSnapshot | null;
  candidateRevisions?: CandidateRevision[];
  followedReference?: FollowedReferencePlan;
  /** Interval-scoped saved Tesla originals when `request.candidate.kind === 'restore_tesla'`. */
  restorationTargets?: RestorationTargetSpanInput[];
  /** Optional site eligibility state folded into `reviewHash`. */
  eligibility?: string | null;
  /** Optional public-plan conversion inputs folded into `reviewHash`. */
  conversionInputs?: ConversionInputsRecord;
  /** Allow non-half-hour boundaries (used by AI handoff for existing Tesla schedules). */
  allowMinuteResolution?: boolean;
}

export interface TariffSeasonScheduleComparisonSummary {
  seasons: TariffAlignedSeasonComparison[];
  hasBuyRateChanges: boolean;
  hasSellRateChanges: boolean;
  hasRateChanges: boolean;
  hasPeriodNameChanges: boolean;
}

export interface TariffSelectionReviewHashInput {
  siteId: string;
  scope: TariffSelectionScope;
  request: TariffSelectionRequest;
  currency: string;
  timezone: string;
  holidaysUseWeekendSchedule: boolean;
  eligibility: string | null;
  conversionInputs: ConversionInputsRecord | null;
  followedReference?: FollowedReferencePlan;
  recalculatesHistory: boolean;
  recalculationRange: { fromDate: string; toDate: string | null } | null;
  candidatePlan: TariffReviewPlanSnapshot | null;
  affectedIntervals: TariffReviewAffectedInterval[];
  unchangedOutsidePeriods: TariffReviewUnchangedPeriod[];
}

function round5(value: number): number {
  const rounded = Math.round(value * 100_000) / 100_000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function cmpEnd(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

function minEnd(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a <= b ? a : b;
}

function maxStart(a: string, b: string): string {
  return a >= b ? a : b;
}

function spansOverlap(aFrom: string, aTo: string | null, bFrom: string, bTo: string | null): boolean {
  if (aTo !== null && aTo < bFrom) return false;
  if (bTo !== null && bTo < aFrom) return false;
  return true;
}

function spanContainsDate(from: string, to: string | null, date: string): boolean {
  return from <= date && (to === null || to >= date);
}

function inclusiveDayCount(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  const startMs = Date.UTC(fy, fm - 1, fd);
  const endMs = Date.UTC(ty, tm - 1, td);
  return Math.floor((endMs - startMs) / 86_400_000) + 1;
}

function parseMonthDay(isoDate: string): { month: number; day: number } {
  const [, m, d] = isoDate.split('-').map(Number);
  return { month: m, day: d };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates that both `effectiveFrom` and `effectiveTo` were explicitly supplied.
 * Never defaults missing dates from today, a public revision date, or a Tesla import date.
 * `effectiveTo: null` explicitly represents an ongoing range; `undefined` or `""` is rejected.
 */
export function validateSelectionDates(
  effectiveFrom: unknown,
  effectiveTo: unknown,
  todaySiteLocal: string
): { effectiveFrom: string; effectiveTo: string | null } {
  if (typeof effectiveFrom !== 'string' || effectiveFrom.trim().length === 0) {
    throw new TariffValidationError('An effective start date is required');
  }
  const normalizedFrom = effectiveFrom.trim();

  let normalizedTo: string | null;
  if (effectiveTo === null) {
    normalizedTo = null;
  } else if (typeof effectiveTo === 'string' && effectiveTo.trim().length > 0) {
    normalizedTo = effectiveTo.trim();
  } else {
    throw new TariffValidationError('An effective end date or ongoing range (null) must be explicitly specified');
  }

  validateEffectiveDates(normalizedFrom, normalizedTo, todaySiteLocal);
  return { effectiveFrom: normalizedFrom, effectiveTo: normalizedTo };
}

export function validateTariffSelectionRequest(
  raw: unknown,
  todaySiteLocal: string,
  options?: { allowMinuteResolution?: boolean }
): TariffSelectionRequest {
  if (!isPlainObject(raw)) {
    throw new TariffValidationError('Rate plan selection request must be an object');
  }

  const scope = raw.scope;
  if (scope !== 'actual' && scope !== 'reference') {
    throw new TariffValidationError('Rate plan selection scope must be "actual" or "reference"');
  }

  if (!('effectiveFrom' in raw) || !('effectiveTo' in raw)) {
    throw new TariffValidationError('Both effectiveFrom and effectiveTo must be explicitly provided');
  }
  const { effectiveFrom, effectiveTo } = validateSelectionDates(raw.effectiveFrom, raw.effectiveTo, todaySiteLocal);

  const rawCandidate = raw.candidate;
  if (!isPlainObject(rawCandidate) || typeof rawCandidate.kind !== 'string') {
    throw new TariffValidationError('Rate plan selection candidate is required');
  }

  let candidate: TariffSelectionCandidate;
  switch (rawCandidate.kind) {
    case 'public': {
      if ('seasons' in rawCandidate && rawCandidate.seasons !== undefined) {
        throw new TariffValidationError('Public rate plan candidates must reference a label rather than client-supplied rates');
      }
      if (typeof rawCandidate.label !== 'string' || rawCandidate.label.trim().length === 0) {
        throw new TariffValidationError('Public rate plan label is required');
      }
      candidate = { kind: 'public', label: rawCandidate.label.trim() };
      break;
    }
    case 'manual': {
      if (!Array.isArray(rawCandidate.seasons)) {
        throw new TariffValidationError('Rate plan must include 1–6 seasons');
      }
      for (const s of rawCandidate.seasons) {
        if (!isPlainObject(s)) {
          throw new TariffValidationError('Each season must be an object');
        }
        if (
          !Array.isArray(s.weekdayPeriods) ||
          !Array.isArray(s.weekendPeriods) ||
          !s.weekdayPeriods.every(isPlainObject) ||
          !s.weekendPeriods.every(isPlainObject)
        ) {
          throw new TariffValidationError('Each season must provide weekdayPeriods and weekendPeriods');
        }
      }
      const validated = validateTariffPlanInput(
        {
          name: typeof rawCandidate.name === 'string' ? rawCandidate.name : '',
          effectiveFrom,
          effectiveTo,
          seasons: rawCandidate.seasons as TariffSeasonInput[],
        },
        todaySiteLocal,
        options
      );
      candidate = {
        kind: 'manual',
        name: validated.name,
        seasons: validated.seasons,
      };
      break;
    }
    case 'restore_tesla': {
      if ('seasons' in rawCandidate && rawCandidate.seasons !== undefined) {
        throw new TariffValidationError('Restoration candidates must reference a saved original selection');
      }
      const id = rawCandidate.originalSelectionId;
      if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
        throw new TariffValidationError('originalSelectionId must be a positive integer');
      }
      candidate = { kind: 'restore_tesla', originalSelectionId: id };
      break;
    }
    default:
      throw new TariffValidationError(`Unsupported rate plan candidate kind: ${String(rawCandidate.kind)}`);
  }

  return { scope, candidate, effectiveFrom, effectiveTo };
}

/** An open-ended utility plan chosen for the comparison means "this plan": its later revisions are followed. */
export function followsUtilityPlan(request: { scope: TariffSelectionScope; candidate: { kind: string }; effectiveTo: string | null }): boolean {
  return request.scope === 'reference' && request.candidate.kind === 'public' && request.effectiveTo === null;
}

/** An open-ended owner choice starting on or before the followed range replaces the follow; closed ranges never do (owner rows outrank estimates). */
export function supersedesFollowedLabel(effectiveFrom: string, effectiveTo: string | null, followedFrom: string | null): boolean {
  return effectiveTo === null && followedFrom !== null && effectiveFrom <= followedFrom;
}

export function validateTariffSelectionCommit(
  raw: unknown,
  todaySiteLocal: string
): TariffSelectionCommit {
  const base = validateTariffSelectionRequest(raw, todaySiteLocal);
  const record = raw as Record<string, unknown>;
  if (typeof record.expectedReviewHash !== 'string' || record.expectedReviewHash.trim().length === 0) {
    throw new TariffValidationError('expectedReviewHash is required to apply a reviewed rate plan change');
  }
  if (typeof record.verifiedAgainstBill !== 'boolean') {
    throw new TariffValidationError('verifiedAgainstBill must be explicitly provided as a boolean');
  }
  return {
    ...base,
    expectedReviewHash: record.expectedReviewHash.trim(),
    verifiedAgainstBill: record.verifiedAgainstBill,
  };
}

function seasonMatchesMonthDay(month: number, day: number, season: TariffSeasonInput): boolean {
  const fromDay = season.fromDay ?? 1;
  const toDay = season.toDay ?? MONTH_MAX_DAYS[season.toMonth - 1];
  const target = month * 100 + day;
  const start = season.fromMonth * 100 + fromDay;
  const end = season.toMonth * 100 + toDay;
  if (start <= end) {
    return target >= start && target <= end;
  }
  return target >= start || target <= end;
}

function findMatchingSeasonIndex(seasons: TariffSeasonInput[] | null, month: number, day: number): number {
  if (!seasons || seasons.length === 0) return -1;
  return seasons.findIndex(season => seasonMatchesMonthDay(month, day, season));
}

function windowMatchesMinute(window: TimePeriodWindowInput, minute: number): boolean {
  const start = window.fromHour * 60 + window.fromMinute;
  const rawEnd = window.toHour * 60 + window.toMinute;
  if (start === 0 && (rawEnd === 1440 || rawEnd === 0)) {
    return true;
  }
  const end = rawEnd === 1440 ? 1440 : rawEnd % 1440;
  if (start < end) {
    return minute >= start && minute < end;
  }
  return minute >= start || minute < end;
}

function slotRateAtMinute(periods: TimePeriodWindowInput[] | null, minute: number): TariffComparisonSlotRate | null {
  if (!periods || periods.length === 0) return null;
  const match = periods.find(window => windowMatchesMinute(window, minute));
  if (!match) return null;
  return {
    touName: match.touName,
    buyRate: round5(match.buyRate),
    sellRate: round5(match.sellRate),
  };
}

function sameSlotRate(a: TariffComparisonSlotRate | null, b: TariffComparisonSlotRate | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return (
    a.touName === b.touName &&
    Math.abs(a.buyRate - b.buyRate) <= RATE_EPSILON &&
    Math.abs(a.sellRate - b.sellRate) <= RATE_EPSILON
  );
}

function alignDayScheduleRows(
  beforePeriods: TimePeriodWindowInput[] | null,
  afterPeriods: TimePeriodWindowInput[] | null
): TariffAlignedTimeRow[] {
  if ((!beforePeriods || beforePeriods.length === 0) && (!afterPeriods || afterPeriods.length === 0)) {
    return [];
  }

  const boundarySet = new Set<number>([0, 1440]);
  for (const list of [beforePeriods, afterPeriods]) {
    if (!list) continue;
    for (const w of list) {
      const start = (w.fromHour * 60 + w.fromMinute) % 1440;
      const rawEnd = w.toHour * 60 + w.toMinute;
      const end = rawEnd === 1440 ? 1440 : rawEnd % 1440;
      boundarySet.add(start);
      boundarySet.add(end);
    }
  }

  const points = [...boundarySet].sort((a, b) => a - b);
  const rows: TariffAlignedTimeRow[] = [];

  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i];
    const end = points[i + 1];
    if (start >= end) continue;

    const before = slotRateAtMinute(beforePeriods, start);
    const after = slotRateAtMinute(afterPeriods, start);

    const prev = rows[rows.length - 1];
    if (prev && sameSlotRate(prev.before, before) && sameSlotRate(prev.after, after)) {
      prev.toHour = Math.floor(end / 60);
      prev.toMinute = end % 60;
      continue;
    }

    const buyRateDelta = before !== null && after !== null ? round5(after.buyRate - before.buyRate) : null;
    const sellRateDelta = before !== null && after !== null ? round5(after.sellRate - before.sellRate) : null;
    const buyRateChanged =
      before === null || after === null
        ? before !== after
        : Math.abs(after.buyRate - before.buyRate) > RATE_EPSILON;
    const sellRateChanged =
      before === null || after === null
        ? before !== after
        : Math.abs(after.sellRate - before.sellRate) > RATE_EPSILON;
    const periodNameChanged = before !== null && after !== null && before.touName !== after.touName;

    rows.push({
      fromHour: Math.floor(start / 60),
      fromMinute: start % 60,
      toHour: Math.floor(end / 60),
      toMinute: end % 60,
      before,
      after,
      buyRateDelta,
      sellRateDelta,
      buyRateChanged,
      sellRateChanged,
      rateChanged: buyRateChanged || sellRateChanged,
      periodNameChanged,
    });
  }

  return rows;
}

interface SeasonSliceRun {
  fromMonth: number;
  fromDay: number;
  toMonth: number;
  toDay: number;
  beforeIdx: number;
  afterIdx: number;
}

function buildSeasonSliceRuns(
  beforeSeasons: TariffSeasonInput[] | null,
  afterSeasons: TariffSeasonInput[] | null,
  dateRange?: { effectiveFrom: string; effectiveTo: string | null }
): SeasonSliceRun[] {
  const useFullYear =
    !dateRange ||
    dateRange.effectiveTo === null ||
    inclusiveDayCount(dateRange.effectiveFrom, dateRange.effectiveTo) >= 365;

  const runs: SeasonSliceRun[] = [];

  if (useFullYear) {
    for (const { month, day } of CANONICAL_YEAR_DAYS) {
      const beforeIdx = findMatchingSeasonIndex(beforeSeasons, month, day);
      const afterIdx = findMatchingSeasonIndex(afterSeasons, month, day);
      const prev = runs[runs.length - 1];
      if (prev && prev.beforeIdx === beforeIdx && prev.afterIdx === afterIdx) {
        prev.toMonth = month;
        prev.toDay = day;
      } else {
        runs.push({ fromMonth: month, fromDay: day, toMonth: month, toDay: day, beforeIdx, afterIdx });
      }
    }
    if (
      runs.length > 1 &&
      runs[0].beforeIdx === runs[runs.length - 1].beforeIdx &&
      runs[0].afterIdx === runs[runs.length - 1].afterIdx
    ) {
      const wrappedHead = runs.shift();
      if (wrappedHead) {
        const last = runs[runs.length - 1];
        last.toMonth = wrappedHead.toMonth;
        last.toDay = wrappedHead.toDay;
      }
    }
    return runs;
  }

  let cursor = dateRange.effectiveFrom;
  const limit = dateRange.effectiveTo as string;
  while (cursor <= limit) {
    const { month, day } = parseMonthDay(cursor);
    const beforeIdx = findMatchingSeasonIndex(beforeSeasons, month, day);
    const afterIdx = findMatchingSeasonIndex(afterSeasons, month, day);
    const prev = runs[runs.length - 1];
    if (prev && prev.beforeIdx === beforeIdx && prev.afterIdx === afterIdx) {
      prev.toMonth = month;
      prev.toDay = day;
    } else {
      runs.push({ fromMonth: month, fromDay: day, toMonth: month, toDay: day, beforeIdx, afterIdx });
    }
    cursor = addCalendarDays(cursor, 1);
  }

  return runs;
}

/**
 * Aligns two plans' seasonal schedules across calendar season boundaries and minute-level
 * weekday/weekend time boundaries. When `dateRange` is shorter than a full year, only
 * seasons occurring during `[effectiveFrom, effectiveTo]` are included.
 */
export function compareTariffSeasons(
  beforeSeasons: TariffSeasonInput[] | null,
  afterSeasons: TariffSeasonInput[] | null,
  dateRange?: { effectiveFrom: string; effectiveTo: string | null }
): TariffAlignedSeasonComparison[] {
  if ((!beforeSeasons || beforeSeasons.length === 0) && (!afterSeasons || afterSeasons.length === 0)) {
    return [];
  }

  const runs = buildSeasonSliceRuns(beforeSeasons, afterSeasons, dateRange);
  return runs.map(run => {
    const beforeSeason = run.beforeIdx >= 0 && beforeSeasons ? beforeSeasons[run.beforeIdx] : null;
    const afterSeason = run.afterIdx >= 0 && afterSeasons ? afterSeasons[run.afterIdx] : null;
    const weekdayRows = alignDayScheduleRows(
      beforeSeason ? beforeSeason.weekdayPeriods : null,
      afterSeason ? afterSeason.weekdayPeriods : null
    );
    const weekendRows = alignDayScheduleRows(
      beforeSeason ? beforeSeason.weekendPeriods : null,
      afterSeason ? afterSeason.weekendPeriods : null
    );
    const allRows = [...weekdayRows, ...weekendRows];
    const hasBuyRateChanges = allRows.some(row => row.buyRateChanged);
    const hasSellRateChanges = allRows.some(row => row.sellRateChanged);
    const hasPeriodNameChanges = allRows.some(row => row.periodNameChanged);

    return {
      fromMonth: run.fromMonth,
      fromDay: run.fromDay,
      toMonth: run.toMonth,
      toDay: run.toDay,
      beforeSeasonName: beforeSeason?.name ?? null,
      afterSeasonName: afterSeason?.name ?? null,
      weekdayRows,
      weekendRows,
      hasBuyRateChanges,
      hasSellRateChanges,
      hasRateChanges: hasBuyRateChanges || hasSellRateChanges,
      hasPeriodNameChanges,
    };
  });
}

/**
 * Compares two complete rate plans across the full calendar year by actual buy/sell schedules,
 * rather than by Peak/Off-Peak labels alone.
 */
export function compareTariffSchedules(
  beforeSeasons: TariffSeasonInput[],
  afterSeasons: TariffSeasonInput[]
): TariffSeasonScheduleComparisonSummary {
  const seasons = compareTariffSeasons(beforeSeasons, afterSeasons);
  const hasBuyRateChanges = seasons.some(s => s.hasBuyRateChanges);
  const hasSellRateChanges = seasons.some(s => s.hasSellRateChanges);
  const hasPeriodNameChanges = seasons.some(s => s.hasPeriodNameChanges);
  return {
    seasons,
    hasBuyRateChanges,
    hasSellRateChanges,
    hasRateChanges: hasBuyRateChanges || hasSellRateChanges,
    hasPeriodNameChanges,
  };
}

export function canonicalizeValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(item => canonicalizeValue(item));
  }
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    const entry = obj[key];
    if (entry !== undefined) {
      sorted[key] = canonicalizeValue(entry);
    }
  }
  return sorted;
}

function canonicalizeWindow(window: TimePeriodWindowInput): TimePeriodWindowInput {
  return {
    touName: window.touName,
    fromHour: window.fromHour,
    fromMinute: window.fromMinute,
    toHour: window.toHour,
    toMinute: window.toMinute,
    buyRate: round5(window.buyRate),
    sellRate: round5(window.sellRate),
  };
}

function canonicalizeSeason(season: TariffSeasonInput): TariffSeasonInput {
  const sortWindows = (windows: TimePeriodWindowInput[]): TimePeriodWindowInput[] =>
    [...windows]
      .map(canonicalizeWindow)
      .sort((a, b) =>
        a.fromHour - b.fromHour ||
        a.fromMinute - b.fromMinute ||
        a.toHour - b.toHour ||
        a.toMinute - b.toMinute ||
        a.touName.localeCompare(b.touName)
      );

  return {
    name: season.name,
    fromMonth: season.fromMonth,
    toMonth: season.toMonth,
    ...(season.fromDay !== undefined ? { fromDay: season.fromDay } : {}),
    ...(season.toDay !== undefined ? { toDay: season.toDay } : {}),
    weekdayPeriods: sortWindows(season.weekdayPeriods),
    weekendPeriods: sortWindows(season.weekendPeriods),
  };
}

function canonicalizePlanSnapshot(plan: TariffReviewPlanSnapshot | null): TariffReviewPlanSnapshot | null {
  if (plan === null) return null;
  return {
    ...plan,
    seasons: [...plan.seasons]
      .map(canonicalizeSeason)
      .sort((a, b) =>
        a.fromMonth - b.fromMonth ||
        (a.fromDay ?? 1) - (b.fromDay ?? 1) ||
        a.toMonth - b.toMonth ||
        (a.toDay ?? MONTH_MAX_DAYS[a.toMonth - 1]) - (b.toDay ?? MONTH_MAX_DAYS[b.toMonth - 1]) ||
        a.name.localeCompare(b.name)
      ),
    approximationNotes: [...plan.approximationNotes].sort((a, b) =>
      a.kind.localeCompare(b.kind) || a.message.localeCompare(b.message)
    ),
  };
}

/**
 * Deterministic SHA-256 fingerprint covering the canonical request, candidate content,
 * affected intervals, outside periods, restoration provenance, conversion inputs, eligibility,
 * and the followed plan for reference selections.
 */
export function computeTariffSelectionReviewHash(input: TariffSelectionReviewHashInput): string {
  const canonicalPayload = canonicalizeValue({
    version: 1,
    siteId: input.siteId,
    scope: input.scope,
    request:
      input.request.candidate.kind === 'manual'
        ? {
            ...input.request,
            candidate: {
              kind: 'manual',
              name: input.request.candidate.name,
              seasons: [...input.request.candidate.seasons]
                .map(canonicalizeSeason)
                .sort((a, b) =>
                  a.fromMonth - b.fromMonth ||
                  (a.fromDay ?? 1) - (b.fromDay ?? 1) ||
                  a.name.localeCompare(b.name)
                ),
            },
          }
        : input.request,
    currency: input.currency,
    timezone: input.timezone,
    holidaysUseWeekendSchedule: input.holidaysUseWeekendSchedule,
    eligibility: input.eligibility,
    conversionInputs: input.conversionInputs,
    followedReference: input.followedReference,
    recalculatesHistory: input.recalculatesHistory,
    recalculationRange: input.recalculationRange,
    candidatePlan: canonicalizePlanSnapshot(input.candidatePlan),
    affectedIntervals: input.affectedIntervals.map(interval => ({
      effectiveFrom: interval.effectiveFrom,
      effectiveTo: interval.effectiveTo,
      kind: interval.kind,
      before: canonicalizePlanSnapshot(interval.before),
      after: canonicalizePlanSnapshot(interval.after),
      seasons: interval.seasons,
      restoration: interval.restoration,
    })),
    unchangedOutsidePeriods: input.unchangedOutsidePeriods.map(period => ({
      effectiveFrom: period.effectiveFrom,
      effectiveTo: period.effectiveTo,
      relation: period.relation,
      wasTrimmed: period.wasTrimmed,
      originalEffectiveFrom: period.originalEffectiveFrom,
      originalEffectiveTo: period.originalEffectiveTo,
      plan: canonicalizePlanSnapshot(period.plan),
    })),
  });

  return createHash('sha256').update(JSON.stringify(canonicalPayload)).digest('hex');
}

function buildPreservedOriginalForSpan(
  span: ExistingTimelineSpanInput | undefined,
  segFrom: string,
  segTo: string | null
): TariffRestorationOriginalRef | null {
  if (!span) return null;
  if (span.plan.source === 'tesla' && span.plan.tariffId !== null) {
    return {
      originalSelectionId: span.plan.selectionId,
      tariffId: span.plan.tariffId,
      name: span.plan.name,
      version: span.plan.version,
      contentHash: span.plan.contentHash,
      effectiveFrom: segFrom,
      effectiveTo: segTo,
    };
  }
  if (span.preservedTeslaOriginal) {
    return {
      ...span.preservedTeslaOriginal,
      effectiveFrom: segFrom,
      effectiveTo: segTo,
    };
  }
  return null;
}

function dedupeApproximationNotes(notes: TariffApproximationNote[]): TariffApproximationNote[] {
  const seen = new Set<string>();
  const out: TariffApproximationNote[] = [];
  for (const note of notes) {
    const key = `${note.kind}\0${note.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(note);
    }
  }
  return out;
}

function resolveRestorationTargets(
  request: TariffSelectionRequest,
  candidatePlan: TariffReviewPlanSnapshot | null | undefined,
  restorationTargets: RestorationTargetSpanInput[] | undefined
): RestorationTargetSpanInput[] {
  if (request.candidate.kind !== 'restore_tesla') {
    return [];
  }
  if (restorationTargets !== undefined) {
    return [...restorationTargets].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  }
  if (candidatePlan && candidatePlan.tariffId !== null) {
    return [
      {
        effectiveFrom: request.effectiveFrom,
        effectiveTo: request.effectiveTo,
        original: {
          originalSelectionId: request.candidate.originalSelectionId,
          tariffId: candidatePlan.tariffId,
          name: candidatePlan.name,
          version: candidatePlan.version,
          contentHash: candidatePlan.contentHash,
          effectiveFrom: request.effectiveFrom,
          effectiveTo: request.effectiveTo,
        },
        plan: candidatePlan,
      },
    ];
  }
  return [];
}

/**
 * The plan billing uses for a day in a gap: the nearest earlier plan by end date, else (before
 * every plan) the earliest. Same pick as `resolveTariffForDate` and `pickActivePeriodForDate`.
 */
function fallbackPlanForGap(
  spans: ReadonlyArray<ExistingTimelineSpanInput>,
  date: string
): TariffReviewPlanSnapshot | null {
  let nearest: ExistingTimelineSpanInput | null = null;
  for (const span of spans) {
    if (span.effectiveTo !== null && span.effectiveTo < date && (nearest === null || span.effectiveTo > (nearest.effectiveTo as string))) {
      nearest = span;
    }
  }
  if (nearest) return nearest.plan;
  const earliest = [...spans].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))[0];
  return earliest?.plan ?? null;
}

function collectBoundaryStarts(
  reqFrom: string,
  reqTo: string | null,
  spans: ReadonlyArray<{ effectiveFrom: string; effectiveTo: string | null }>
): string[] {
  const starts = new Set<string>([reqFrom]);
  for (const span of spans) {
    if (!spansOverlap(span.effectiveFrom, span.effectiveTo, reqFrom, reqTo)) {
      continue;
    }
    const clippedFrom = maxStart(span.effectiveFrom, reqFrom);
    const clippedTo = minEnd(span.effectiveTo, reqTo);
    starts.add(clippedFrom);
    if (clippedTo !== null && (reqTo === null || clippedTo < reqTo)) {
      starts.add(addCalendarDays(clippedTo, 1));
    }
  }
  return [...starts].sort((a, b) => a.localeCompare(b));
}

type Recalculation = {
  recalculatesHistory: boolean;
  recalculatesFromHistoryStart: boolean;
  recalculationRange: { fromDate: string; toDate: string | null } | null;
};

const NO_RECALCULATION: Recalculation = {
  recalculatesHistory: false,
  recalculatesFromHistoryStart: false,
  recalculationRange: null,
};

/**
 * The dates the commit reprices, widened by the same fallback rules as
 * `enqueueReattributionOnClient`: days before the earliest plan are priced from it, and days in
 * a gap after the range are priced from the plan before them.
 */
function computeRecalculation(
  scope: TariffSelectionScope,
  todaySiteLocal: string,
  affectedIntervals: TariffReviewAffectedInterval[],
  existingSpans: ReadonlyArray<{ effectiveFrom: string; effectiveTo: string | null }>
): Recalculation {
  if (scope !== 'actual') return NO_RECALCULATION;
  const actionable = affectedIntervals.filter(interval => interval.kind !== 'restore_unavailable');
  if (actionable.length === 0) return NO_RECALCULATION;

  const requestedFrom = actionable[0].effectiveFrom;
  const earliestExisting = existingSpans.reduce<string | null>(
    (min, span) => (min === null || span.effectiveFrom < min ? span.effectiveFrom : min),
    null
  );
  const recalculatesFromHistoryStart = earliestExisting === null || requestedFrom <= earliestExisting;
  const fromDate = recalculatesFromHistoryStart ? REATTRIBUTION_HISTORY_START : requestedFrom;
  if (fromDate > todaySiteLocal) return NO_RECALCULATION;

  let toDate = actionable[actionable.length - 1].effectiveTo;
  if (toDate !== null) {
    const dayAfter = addCalendarDays(toDate, 1);
    const nextFrom = existingSpans
      .filter(span => span.effectiveTo === null || span.effectiveTo >= dayAfter)
      .map(span => maxStart(span.effectiveFrom, dayAfter))
      .reduce<string | null>((min, from) => (min === null || from < min ? from : min), null);
    if (nextFrom === null) toDate = null;
    else if (nextFrom > dayAfter) toDate = addCalendarDays(nextFrom, -1);
  }
  return {
    recalculatesHistory: true,
    recalculatesFromHistoryStart,
    recalculationRange: { fromDate, toDate: toDate === null || toDate > todaySiteLocal ? null : toDate },
  };
}

/**
 * Pure review builder shared by preview and commit. Validates explicit effective dates,
 * splits the requested range at existing-plan, candidate revision, and restoration-original boundaries,
 * aligns season and weekday/weekend time rows on buy and sell rates, identifies unchanged
 * outside periods, captures restoration provenance, and computes a deterministic reviewHash.
 */
export function buildTariffSelectionPreview(
  input: TariffSelectionReviewInput
): TariffSelectionPreviewResponse {
  if (!input.siteId || input.siteId.trim().length === 0) {
    throw new TariffValidationError('siteId is required');
  }
  const validatedRequest = validateTariffSelectionRequest(input.request, input.todaySiteLocal, {
    allowMinuteResolution: input.allowMinuteResolution,
  });
  const { scope, candidate, effectiveFrom, effectiveTo } = validatedRequest;
  const holidaysUseWeekendSchedule = input.holidaysUseWeekendSchedule ?? true;

  if (candidate.kind !== 'restore_tesla' && !input.candidatePlan) {
    throw new TariffValidationError('A resolved candidate rate plan is required to build a review');
  }

  const sortedExisting = [...input.existingSpans].sort((a, b) =>
    a.effectiveFrom.localeCompare(b.effectiveFrom)
  );
  const resolvedRestorationTargets = resolveRestorationTargets(
    validatedRequest,
    input.candidatePlan,
    input.restorationTargets
  );

  // Build unchanged outside periods (completely outside + trimmed remnants of overlapping spans).
  const unchangedOutsidePeriods: TariffReviewUnchangedPeriod[] = [];
  for (const span of sortedExisting) {
    if (!spansOverlap(span.effectiveFrom, span.effectiveTo, effectiveFrom, effectiveTo)) {
      unchangedOutsidePeriods.push({
        effectiveFrom: span.effectiveFrom,
        effectiveTo: span.effectiveTo,
        relation: span.effectiveFrom < effectiveFrom ? 'before_range' : 'after_range',
        wasTrimmed: false,
        originalEffectiveFrom: span.effectiveFrom,
        originalEffectiveTo: span.effectiveTo,
        plan: span.plan,
      });
      continue;
    }
    if (span.effectiveFrom < effectiveFrom) {
      unchangedOutsidePeriods.push({
        effectiveFrom: span.effectiveFrom,
        effectiveTo: addCalendarDays(effectiveFrom, -1),
        relation: 'before_range',
        wasTrimmed: true,
        originalEffectiveFrom: span.effectiveFrom,
        originalEffectiveTo: span.effectiveTo,
        plan: span.plan,
      });
    }
    if (effectiveTo !== null && cmpEnd(span.effectiveTo, effectiveTo) > 0) {
      unchangedOutsidePeriods.push({
        effectiveFrom: addCalendarDays(effectiveTo, 1),
        effectiveTo: span.effectiveTo,
        relation: 'after_range',
        wasTrimmed: true,
        originalEffectiveFrom: span.effectiveFrom,
        originalEffectiveTo: span.effectiveTo,
        plan: span.plan,
      });
    }
  }
  unchangedOutsidePeriods.sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));

  const segmentStarts = collectBoundaryStarts(effectiveFrom, effectiveTo, [
    ...sortedExisting,
    ...resolvedRestorationTargets,
    ...(input.candidateRevisions ?? []),
  ]);

  const affectedIntervals: TariffReviewAffectedInterval[] = [];
  const preservedOriginals: TariffRestorationOriginalRef[] = [];
  const restoredOriginals: TariffRestorationOriginalRef[] = [];
  const unavailableRanges: Array<{ effectiveFrom: string; effectiveTo: string | null; reason: string }> = [];
  const collectedNotes: TariffApproximationNote[] = [];

  const candidatePlans = input.candidateRevisions?.map(revision => revision.plan) ?? (input.candidatePlan ? [input.candidatePlan] : []);
  collectedNotes.push(...candidatePlans.flatMap(plan => plan.approximationNotes));

  for (let i = 0; i < segmentStarts.length; i++) {
    const segFrom = segmentStarts[i];
    const segTo = i + 1 < segmentStarts.length ? addCalendarDays(segmentStarts[i + 1], -1) : effectiveTo;
    const existingMatch = sortedExisting.find(span => spanContainsDate(span.effectiveFrom, span.effectiveTo, segFrom));
    // A gap in the actual timeline is billed with a borrowed plan, so compare against that.
    const fallbackPlan = !existingMatch && scope === 'actual' ? fallbackPlanForGap(sortedExisting, segFrom) : null;
    const beforePlan = existingMatch?.plan ?? fallbackPlan;
    // The comparison can hide a replaced plan's day-specific rates as easily as a new one's.
    if (beforePlan) collectedNotes.push(...beforePlan.approximationNotes.filter(n => n.kind === 'day_specific_schedule'));

    let afterPlan: TariffReviewPlanSnapshot | null;
    let kind: TariffReviewAffectedIntervalKind;
    let restoration: TariffIntervalRestorationProvenance;

    if (candidate.kind === 'restore_tesla') {
      const target = resolvedRestorationTargets.find(t => spanContainsDate(t.effectiveFrom, t.effectiveTo, segFrom));
      if (target) {
        afterPlan = target.plan;
        kind = 'restore';
        const clippedOriginal: TariffRestorationOriginalRef = {
          ...target.original,
          effectiveFrom: segFrom,
          effectiveTo: segTo,
        };
        restoration = { status: 'restoring_original', original: clippedOriginal };
        restoredOriginals.push(clippedOriginal);
        collectedNotes.push(...target.plan.approximationNotes);
      } else {
        // Applying writes only the restoration targets, so these dates keep the plan they have.
        afterPlan = beforePlan;
        kind = 'restore_unavailable';
        restoration = { status: 'unavailable', reason: UNAVAILABLE_RESTORATION_REASON };
        unavailableRanges.push({
          effectiveFrom: segFrom,
          effectiveTo: segTo,
          reason: UNAVAILABLE_RESTORATION_REASON,
        });
      }
    } else {
      afterPlan = input.candidateRevisions
        ? input.candidateRevisions.find(span => spanContainsDate(span.effectiveFrom, span.effectiveTo, segFrom))?.plan ?? null
        : input.candidatePlan ?? null;
      kind = existingMatch ? 'replace' : 'fill_gap';
      const preserved = buildPreservedOriginalForSpan(existingMatch, segFrom, segTo);
      if (preserved) {
        restoration = { status: 'preserves_tesla_original', original: preserved };
        preservedOriginals.push(preserved);
      } else {
        restoration = { status: 'not_applicable' };
      }
    }

    const seasons = compareTariffSeasons(
      beforePlan ? beforePlan.seasons : null,
      afterPlan ? afterPlan.seasons : null,
      { effectiveFrom: segFrom, effectiveTo: segTo }
    );
    const hasBuyRateChanges = seasons.some(s => s.hasBuyRateChanges);
    const hasSellRateChanges = seasons.some(s => s.hasSellRateChanges);
    const hasPeriodNameChanges = seasons.some(s => s.hasPeriodNameChanges);

    affectedIntervals.push({
      effectiveFrom: segFrom,
      effectiveTo: segTo,
      kind,
      before: beforePlan,
      beforeIsFallback: fallbackPlan !== null,
      after: afterPlan,
      seasons,
      hasBuyRateChanges,
      hasSellRateChanges,
      hasRateChanges: hasBuyRateChanges || hasSellRateChanges,
      hasPeriodNameChanges,
      restoration,
    });
  }

  const { recalculatesHistory, recalculatesFromHistoryStart, recalculationRange } = computeRecalculation(
    scope,
    input.todaySiteLocal,
    affectedIntervals,
    input.existingSpans
  );

  const distinctRestoredTariffIds = new Set(restoredOriginals.map(o => o.tariffId));
  const resolvedCandidatePlan: TariffReviewPlanSnapshot | null =
    candidate.kind === 'restore_tesla'
      ? distinctRestoredTariffIds.size === 1
        ? (affectedIntervals.find(i => i.kind === 'restore')?.after ?? null)
        : null
      : (input.candidatePlan ?? null);

  const reviewHash = computeTariffSelectionReviewHash({
    siteId: input.siteId,
    scope,
    request: validatedRequest,
    currency: input.currency,
    timezone: input.timezone,
    holidaysUseWeekendSchedule,
    eligibility: input.eligibility ?? null,
    conversionInputs: input.conversionInputs ?? null,
    followedReference: scope === 'reference' ? input.followedReference ?? { label: null, from: null } : undefined,
    recalculatesHistory,
    recalculationRange,
    candidatePlan: resolvedCandidatePlan,
    affectedIntervals,
    unchangedOutsidePeriods,
  });

  const hasBuyRateChanges = affectedIntervals.some(i => i.hasBuyRateChanges);
  const hasSellRateChanges = affectedIntervals.some(i => i.hasSellRateChanges);
  const hasPeriodNameChanges = affectedIntervals.some(i => i.hasPeriodNameChanges);

  return {
    reviewHash,
    siteId: input.siteId,
    scope,
    effectiveFrom,
    effectiveTo,
    currency: input.currency,
    unit: 'kWh',
    timezone: input.timezone,
    holidaysUseWeekendSchedule,
    recalculatesHistory,
    recalculatesFromHistoryStart,
    recalculationRange,
    affectsPowerwallPlan: false,
    candidatePlan: resolvedCandidatePlan,
    affectedIntervals,
    unchangedOutsidePeriods,
    restoration: {
      preservedOriginals,
      restoredOriginals,
      unavailableRanges,
      canApplyRestoration: candidate.kind === 'restore_tesla' && restoredOriginals.length > 0,
    },
    approximationNotes: dedupeApproximationNotes(collectedNotes),
    summary: {
      hasBuyRateChanges,
      hasSellRateChanges,
      hasRateChanges: hasBuyRateChanges || hasSellRateChanges,
      hasPeriodNameChanges,
      fillsGap: affectedIntervals.some(i => i.kind === 'fill_gap' && i.after !== null),
      replacesExistingPlan: affectedIntervals.some(i => i.kind === 'replace' || i.kind === 'restore'),
    },
  };
}
