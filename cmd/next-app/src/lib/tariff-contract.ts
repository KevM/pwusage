import type {
  ExportRateProvenance,
  RateCountrySource,
  RatePlanEligibility,
  TariffReattributionStatus,
  TariffSelectionChoiceKind,
  TariffSelectionScope,
  TariffSource,
  TariffStartSource,
} from './db-types';

export type {
  ExportRateProvenance,
  RateCountrySource,
  RatePlanEligibility,
  TariffSelectionChoiceKind,
  TariffSelectionScope,
};

export type TariffPeriodName = 'ON_PEAK' | 'PARTIAL_PEAK' | 'OFF_PEAK' | 'SUPER_OFF_PEAK';

export interface TimePeriodWindowInput {
  touName: TariffPeriodName;
  fromHour: number;
  fromMinute: number;
  toHour: number;
  toMinute: number;
  buyRate: number;
  sellRate: number;
}

export interface TariffSeasonInput {
  name: string;
  fromMonth: number;
  toMonth: number;
  /** Day of `fromMonth` the season starts. Read-only: Tesla seasons may start mid-month; writes ignore it. */
  fromDay?: number;
  /** Day of `toMonth` the season ends (inclusive). Read-only, like `fromDay`. */
  toDay?: number;
  weekdayPeriods: TimePeriodWindowInput[];
  weekendPeriods: TimePeriodWindowInput[];
}

export interface TariffUpdatedByDTO {
  email: string | null;
  isCurrentUser: boolean;
}

export interface TariffPeriodDTO {
  periodId: number;
  tariffId: number;
  name: string;
  version: number;
  source: TariffSource;
  startSource: TariffStartSource | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  isCurrentToday: boolean;
  updatedBy: TariffUpdatedByDTO | null;
  seasons: TariffSeasonInput[];
  selectionId?: number | null;
  choiceKind?: TariffSelectionChoiceKind;
  urdbLabel?: string | null;
  verification?: TariffVerificationSummary | null;
}

export interface ReattributionStatusDTO {
  status: TariffReattributionStatus;
  fromDate: string;
  toDate: string | null;
  totalDays: number;
  processedDays: number;
  updatedDays: number;
  lastError: string | null;
  updatedAt: string;
}

export interface SystemCostDTO {
  installDate: string | null;
  price: number;
  taxCreditPercent: number | null;
  incentives: number;
}

export interface SystemCostsDTO {
  /** Site.installed as a site-local YYYY-MM-DD. */
  siteInstalled: string;
  solar: SystemCostDTO | null;
  powerwall: SystemCostDTO | null;
}

export interface SiteBatteryDTO {
  nameplateEnergyWh: number;
  nameplatePowerW: number;
  backupReservePercent: number;
}

export type RatePlanKind = 'fixed' | 'time_of_use';

export interface RatePlanPeakWindow { label: string; fromHour: number; toHour: number }
export interface RatePlanHistoryPlan {
  name: string;
  startDate: string;
  kind: RatePlanKind;
  isDefault: boolean;
  closest: boolean;
  lowRate: number;
  highRate: number;
  peakWindows: RatePlanPeakWindow[];
  /** Label of the window closest to the Tesla plan (Time of Use only). */
  closestWindow: string | null;
  /** Fixed plans: the URDB label to save. */
  fixedLabel: string | null;
}
export interface RatePlanHistoryYear { year: number; askDate: string; plans: RatePlanHistoryPlan[] }
export interface RatePlanHistoryResponse {
  utilityName: string;
  historyStart: string;
  fillThrough: string | null;
  teslaShape: RatePlanKind | null;
  /** Plans in effect on `fillThrough` (today when null): the newest plan the guide fills. */
  current: RatePlanHistoryPlan[];
  /** Newest first. */
  years: RatePlanHistoryYear[];
}

export interface SiteRateCountryDTO {
  countryCode: string | null;
  source: RateCountrySource | null;
  updatedAt: string | null;
  eligibility: RatePlanEligibility;
  hasIneligiblePublicSelection?: boolean;
}

export interface EstimatesStatusDTO {
  status: 'pending' | 'ready' | 'needs_utility' | 'needs_plan' | 'skipped' | 'failed';
  utilityName: string | null;
  teslaPlanOutOfDate: boolean;
  newerPlanName: string | null;
  /** YYYY-MM-DD start of the newer URDB revision behind teslaPlanOutOfDate. */
  newerPlanStart: string | null;
  /** YYYY-MM-DD start of the newest URDB revision behind the estimate covering today. */
  newestRevisionStart: string | null;
  /** True when that newest revision is old enough that URDB may have missed a change. */
  mayBeOutdated: boolean;
  /** Offer to walk the owner through past rate plans; null when there is nothing to fill. */
  historyGuide: { historyStart: string; fillThrough: string | null; unconfirmedDays: number } | null;
  /** Additive US public-rate-plan eligibility derived from stored site country. */
  eligibility?: RatePlanEligibility;
  /** True when site country has not been confirmed yet and requires country confirmation rather than US utility search. */
  needsCountryConfirmation?: boolean;
  /** True when an ineligible site retains an explicit owner-selected public rate plan requiring review/replacement. */
  hasIneligiblePublicSelection?: boolean;
}

export interface SiteTariffsTimelineResponse {
  version: 2;
  siteId: string;
  timezone: string;
  currency: string;
  periods: TariffPeriodDTO[];
  referencePeriods: TariffPeriodDTO[];
  estimates: EstimatesStatusDTO | null;
  /** Additive country provenance and derived US public-plan eligibility for the site. */
  rateCountry?: SiteRateCountryDTO;
  battery: SiteBatteryDTO | null;
  systemCosts: SystemCostsDTO;
  reattribution: ReattributionStatusDTO | null;
  /** Observed holidays this year and next (site-local YYYY-MM-DD): holidays use the weekend schedule. */
  holidayDates: string[];
  teslaSync: {
    latestTariffId: number | null;
    latestTariffName: string | null;
    latestUpdatedAt: string | null;
    /** When the active custom plan was saved, so clients can say which of the two is newer. */
    activeManualUpdatedAt?: string | null;
    /** True when today's plan chosen in PWUsage (manual, or a public plan an owner selected) differs from the latest Tesla plan. */
    differsFromActiveManual: boolean;
  };
}

export type TariffSelectionCandidate =
  | { kind: 'public'; label: string }
  | { kind: 'manual'; name: string; seasons: TariffSeasonInput[] }
  | { kind: 'restore_tesla'; originalSelectionId: number };

export interface TariffSelectionRequest {
  scope: TariffSelectionScope;
  candidate: TariffSelectionCandidate;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface TariffSelectionCommit extends TariffSelectionRequest {
  expectedReviewHash: string;
  verifiedAgainstBill: boolean;
}

export type TariffApproximationKind =
  | 'tier_blended'
  | 'export_inherited_from_tesla'
  | 'export_net_metering_assumed'
  | 'export_fallback_zero'
  | 'holiday_weekend_schedule'
  | 'other';

export interface TariffApproximationNote {
  kind: TariffApproximationKind;
  message: string;
}

export interface TariffVerificationSummary {
  verifiedAt: string;
  verifiedByEmail: string | null;
  verifiedByCurrentUser: boolean;
}

export interface TariffReviewPlanSnapshot {
  /** Stored Tariff.id when backed by a saved version; null for an unsaved candidate. */
  tariffId: number | null;
  /** Stored Tariff.version when backed by a saved version; null for an unsaved candidate. */
  version: number | null;
  /** Stored TariffEffectivePeriod.id when representing an existing timeline span; null for a candidate. */
  periodId: number | null;
  /** Stored selection record id when backed by a selection provenance row. */
  selectionId: number | null;
  name: string;
  utilityName: string | null;
  source: TariffSource;
  choiceKind: TariffSelectionChoiceKind;
  /** URDB label when source is 'estimated' (public utility rates). */
  urdbLabel: string | null;
  /** Informational revision start date (YYYY-MM-DD) for public utility rates; never a default effective date. */
  revisionStart: string | null;
  contentHash: string | null;
  exportRateProvenance: ExportRateProvenance;
  holidaysUseWeekendSchedule: boolean;
  seasons: TariffSeasonInput[];
  approximationNotes: TariffApproximationNote[];
  verification: TariffVerificationSummary | null;
}

export interface TariffComparisonSlotRate {
  touName: TariffPeriodName;
  buyRate: number;
  sellRate: number;
}

export interface TariffAlignedTimeRow {
  fromHour: number;
  fromMinute: number;
  toHour: number;
  toMinute: number;
  before: TariffComparisonSlotRate | null;
  after: TariffComparisonSlotRate | null;
  buyRateDelta: number | null;
  sellRateDelta: number | null;
  buyRateChanged: boolean;
  sellRateChanged: boolean;
  rateChanged: boolean;
  periodNameChanged: boolean;
}

export interface TariffAlignedSeasonComparison {
  fromMonth: number;
  fromDay: number;
  toMonth: number;
  toDay: number;
  beforeSeasonName: string | null;
  afterSeasonName: string | null;
  weekdayRows: TariffAlignedTimeRow[];
  weekendRows: TariffAlignedTimeRow[];
  hasBuyRateChanges: boolean;
  hasSellRateChanges: boolean;
  hasRateChanges: boolean;
  hasPeriodNameChanges: boolean;
}

export interface TariffRestorationOriginalRef {
  originalSelectionId: number | null;
  tariffId: number;
  name: string;
  version: number | null;
  contentHash: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export type TariffIntervalRestorationProvenance =
  | { status: 'not_applicable' }
  | { status: 'preserves_tesla_original'; original: TariffRestorationOriginalRef }
  | { status: 'restoring_original'; original: TariffRestorationOriginalRef }
  | { status: 'unavailable'; reason: string };

export type TariffReviewAffectedIntervalKind =
  | 'replace'
  | 'fill_gap'
  | 'restore'
  | 'restore_unavailable';

export interface TariffReviewAffectedInterval {
  effectiveFrom: string;
  effectiveTo: string | null;
  kind: TariffReviewAffectedIntervalKind;
  before: TariffReviewPlanSnapshot | null;
  after: TariffReviewPlanSnapshot | null;
  seasons: TariffAlignedSeasonComparison[];
  hasBuyRateChanges: boolean;
  hasSellRateChanges: boolean;
  hasRateChanges: boolean;
  hasPeriodNameChanges: boolean;
  restoration: TariffIntervalRestorationProvenance;
}

export interface TariffReviewUnchangedPeriod {
  effectiveFrom: string;
  effectiveTo: string | null;
  relation: 'before_range' | 'after_range';
  wasTrimmed: boolean;
  originalEffectiveFrom: string;
  originalEffectiveTo: string | null;
  plan: TariffReviewPlanSnapshot;
}

export interface TariffReviewRestorationSummary {
  preservedOriginals: TariffRestorationOriginalRef[];
  restoredOriginals: TariffRestorationOriginalRef[];
  unavailableRanges: Array<{
    effectiveFrom: string;
    effectiveTo: string | null;
    reason: string;
  }>;
  canApplyRestoration: boolean;
}

export interface TariffSelectionPreviewResponse {
  reviewHash: string;
  siteId: string;
  scope: TariffSelectionScope;
  effectiveFrom: string;
  effectiveTo: string | null;
  currency: string;
  unit: 'kWh';
  timezone: string;
  holidaysUseWeekendSchedule: boolean;
  recalculatesHistory: boolean;
  recalculationRange: {
    fromDate: string;
    toDate: string | null;
  } | null;
  affectsPowerwallPlan: false;
  candidatePlan: TariffReviewPlanSnapshot | null;
  affectedIntervals: TariffReviewAffectedInterval[];
  unchangedOutsidePeriods: TariffReviewUnchangedPeriod[];
  restoration: TariffReviewRestorationSummary;
  approximationNotes: TariffApproximationNote[];
  summary: {
    hasBuyRateChanges: boolean;
    hasSellRateChanges: boolean;
    hasRateChanges: boolean;
    hasPeriodNameChanges: boolean;
    fillsGap: boolean;
    replacesExistingPlan: boolean;
  };
}

export interface PublicUtilityPlanDTO {
  label: string;
  name: string;
  utilityName: string;
  startDate: string;
  revisionStart: string;
  kind: RatePlanKind;
  isDefault: boolean;
  currency: string;
  unit: 'kWh';
  holidaysUseWeekendSchedule: boolean;
  exportRateProvenance: ExportRateProvenance;
  seasons: TariffSeasonInput[];
  approximationNotes: TariffApproximationNote[];
}

export interface PublicUtilityPlansResponse {
  utilityName: string;
  effectiveDate: string;
  currency: string;
  unit: 'kWh';
  plans: PublicUtilityPlanDTO[];
}

export interface TariffSelectionCommitResponse {
  selectionIds: number[];
  tariffIds: number[];
  createdNewTariffVersion: boolean;
  unchanged: boolean;
  reattributionRange: { fromDate: string; toDate: string | null } | null;
  timeline: SiteTariffsTimelineResponse;
}

export interface TariffSelectionConflictResponse {
  error: string;
  code: 'REVIEW_STALE';
  refreshPath: string;
  preview: TariffSelectionPreviewResponse;
}
