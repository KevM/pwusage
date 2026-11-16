import type { TariffReattributionStatus, TariffSource, TariffStartSource } from './db-types';

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

export interface SiteBatteryDTO {
  nameplateEnergyWh: number;
  nameplatePowerW: number;
  backupReservePercent: number;
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
}

export interface SiteTariffsTimelineResponse {
  version: 2;
  siteId: string;
  timezone: string;
  currency: string;
  periods: TariffPeriodDTO[];
  referencePeriods: TariffPeriodDTO[];
  estimates: EstimatesStatusDTO | null;
  battery: SiteBatteryDTO | null;
  reattribution: ReattributionStatusDTO | null;
  /** Observed holidays this year and next (site-local YYYY-MM-DD): holidays use the weekend schedule. */
  holidayDates: string[];
  teslaSync: {
    latestTariffId: number | null;
    latestTariffName: string | null;
    latestUpdatedAt: string | null;
    /** When the active custom plan was saved, so clients can say which of the two is newer. */
    activeManualUpdatedAt?: string | null;
    differsFromActiveManual: boolean;
  };
}
