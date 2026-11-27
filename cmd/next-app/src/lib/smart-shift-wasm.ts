import { buildSiteTimeZone, callPWUsageCoreJson } from './pwusage-core-wasm';
import type { SolarForecastIntervalDTO } from './solar-forecast-wasm';

export interface SmartShiftTariffSegmentDTO {
    /** UTC epoch seconds. */
    start: number;
    /** UTC epoch seconds. */
    end: number;
    periodKey: string;
    name: string;
    buyRate: number;
    sellRate: number;
}

export interface SmartShiftPeriodDTO {
    name: string;
    marginalCost?: number | null;
    basis: string;
    cycleNetExportKwh: number;
    isActive: boolean;
    nextStartPhrase?: string | null;
    buyRate: number;
    sellRate: number;
}

export interface SmartShiftLoadTimingDTO {
    hasTariff: boolean;
    hasCycleData: boolean;
    activeIsCheapest: boolean;
    periods: SmartShiftPeriodDTO[];
    pricingPeriods: SmartShiftPeriodDTO[];
    tariffTimeline: SmartShiftTariffSegmentDTO[];
    nextCheaper?: { name: string; marginalCost: number; phrase: string } | null;
    nextCheaperPhrase?: string | null;
    nextStartPhraseByKey: Record<string, string>;
}

export interface SmartShiftPlanningSlotDTO {
    localMinute: number;
    homeKw?: number | null;
    batteryNetChargeKw?: number | null;
    gridNetExportKw?: number | null;
    cautiousGridNetExportKw?: number | null;
}

export interface SmartShiftPlanningContextDTO {
    timeZone: string;
    slots: SmartShiftPlanningSlotDTO[];
    /** UTC epoch seconds. */
    asOf: number;
}

export interface SmartShiftCarSettingsDTO {
    capacityKwh: number;
    initialStateOfCharge: number;
    targetStateOfCharge: number;
    chargingLevel: 'level1' | 'level2';
}

export interface SmartShiftLoadProfileDTO {
    id: string;
    name: string;
    kind: 'car' | 'appliance' | 'custom';
    energyKwh: number;
    durationHours: number;
    carSettings?: SmartShiftCarSettingsDTO | null;
    size?: 'small' | 'medium' | 'large' | null;
    actionVerb?: string | null;
    symbol?: string | null;
}

export interface SmartShiftEvaluateInput {
    /** UTC epoch seconds. */
    nowSec: number;
    timing: SmartShiftLoadTimingDTO;
    forecastAvailable: boolean;
    intervals?: SolarForecastIntervalDTO[] | null;
    context?: SmartShiftPlanningContextDTO | null;
    /** UTC epoch seconds. */
    balanceSourceTimeSec?: number | null;
    /** UTC epoch seconds. */
    billingCycleEndSec: number;
    currencyCode: string;
    timeZone: string;
    profiles: SmartShiftLoadProfileDTO[];
}

export type SmartShiftProjectionKind = 'forecast' | 'history' | 'flat';
export type SmartShiftUnavailableReason =
    | 'invalidInput'
    | 'missingTariff'
    | 'incompleteBalance'
    | 'staleBalance'
    | 'incompleteCoverage'
    | 'incompleteContext'
    | 'noFittingRun'
    | 'noEnergyNeeded';

export interface SmartShiftBalancePointDTO {
    date: number;
    kwh: number;
}

export interface SmartShiftBalanceLaneDTO {
    periodKey: string;
    startKwh: number;
    recommended: SmartShiftBalancePointDTO[];
    startNow: SmartShiftBalancePointDTO[];
    projectedKwh: number;
    projectedAfterRecommendedKwh: number;
    projectedAfterStartNowKwh: number;
}

export interface SmartShiftComparisonDTO {
    costNow: number;
    recommendedStart: number;
    recommendedEnd: number;
    recommendedCost: number;
    savings: number;
    bestAlternativeSavings: number;
    estimatedSolarContribution: number;
    horizonStart: number;
    horizonEnd: number;
    evaluatedStarts: number[];
    assumptions: string[];
    hasUnobservedBalance: boolean;
    lanes: SmartShiftBalanceLaneDTO[];
    periodSwitches: number[];
    projectionEnd: number;
    projectionEndsAtRateChange: boolean;
    safetyEnd: number;
    safety: Record<string, unknown>;
    ruledOut?: { start: number; cost: number; periodKey: string } | null;
    usesHistory: boolean;
}

export interface SmartShiftEvaluationDTO {
    profileId: string;
    projection?: SmartShiftProjectionKind | null;
    forecastUnavailableReason?: SmartShiftUnavailableReason | null;
    comparison?: SmartShiftComparisonDTO | null;
    unavailableReason?: SmartShiftUnavailableReason | null;
}

export async function evaluateSmartShiftWasm(
    input: SmartShiftEvaluateInput,
): Promise<SmartShiftEvaluationDTO[]> {
    const startSec = Math.min(input.nowSec, input.balanceSourceTimeSec ?? input.nowSec);
    const endSec = Math.max(input.nowSec, input.billingCycleEndSec);
    const siteTimeZone = buildSiteTimeZone(input.timeZone, startSec, endSec);
    const response = await callPWUsageCoreJson<unknown, { evaluations: SmartShiftEvaluationDTO[] }>(
        'smart_shift_evaluate',
        {
            now: input.nowSec,
            timing: input.timing,
            forecastAvailable: input.forecastAvailable,
            intervals: input.intervals ?? null,
            context: input.context ?? null,
            balanceSourceTime: input.balanceSourceTimeSec ?? null,
            billingCycleEnd: input.billingCycleEndSec,
            currencyCode: input.currencyCode,
            siteTimeZone,
            profiles: input.profiles,
        },
    );
    return response.evaluations;
}
