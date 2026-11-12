import type { TariffReattributionStatus, TariffSource } from './db-types';

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

export interface SiteTariffsTimelineResponse {
  version: 2;
  siteId: string;
  timezone: string;
  currency: string;
  periods: TariffPeriodDTO[];
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
