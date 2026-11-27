import { buildSiteTimeZone, callPWUsageCoreJson } from './pwusage-core-wasm';

export interface SolarLayoutSample {
    /** UTC epoch seconds. */
    timestampSec: number;
    solarWh: number;
}

export interface SolarLayoutDetectInput {
    samples: SolarLayoutSample[];
    latitude: number;
    longitude: number;
    timeZone: string;
    /** Optional UTC epoch seconds recorded on `forecastLayout.detectedAt`. */
    detectedAtSec?: number;
}

export interface DetectedSolarPlane {
    azimuth: number;
    tilt: number;
    dcKwp: number;
    effectiveKw: number;
    azimuthRange90: [number, number];
    tiltRange90: [number, number];
}

export type DetectedSolarLayoutStatus = 'detected' | 'low-confidence' | 'not-enough-history' | 'failed';
export type DetectedSolarLayoutShortfall =
    | 'few-producing-days'
    | 'no-daylight-production'
    | 'few-clear-samples'
    | 'few-usable-clear-days'
    | 'no-plane-fit';

export interface DetectedSolarLayoutDTO {
    status: DetectedSolarLayoutStatus;
    confidence?: string | null;
    reasons: string[];
    planes: DetectedSolarPlane[];
    acClipKw?: number | null;
    historyDays: number;
    clearDays: number;
    firstDay?: string | null;
    lastDay?: string | null;
    shortfall?: DetectedSolarLayoutShortfall | null;
}

export interface SolarLayoutPlaneDTO {
    azimuth: number;
    tilt: number;
    dcKwp: number;
}

export interface SolarLayoutDTO {
    planes: SolarLayoutPlaneDTO[];
    acClipKw?: number | null;
    confidence: 'high' | 'medium' | 'low';
    /** UTC epoch seconds. */
    detectedAt?: number | null;
}

export type SolarLayoutHistoryOutlook = 'usable' | 'moreHistoryMayHelp' | 'needsOtherAction';

export interface SolarLayoutDetectOutput {
    result: DetectedSolarLayoutDTO;
    forecastLayout?: SolarLayoutDTO | null;
    historyOutlook: SolarLayoutHistoryOutlook;
}

export interface SolarLayoutReadinessInput {
    samples: SolarLayoutSample[];
    latitude: number;
    longitude: number;
    timeZone: string;
}

export interface SolarLayoutReadinessOutput {
    producingDays: number;
    isReady: boolean;
    daysNeeded: number;
}

function sampleBounds(samples: SolarLayoutSample[]): { start: number; end: number } {
    if (samples.length === 0) {
        const nowSec = Math.floor(Date.now() / 1000);
        return { start: nowSec, end: nowSec };
    }
    let start = samples[0].timestampSec;
    let end = samples[0].timestampSec;
    for (const sample of samples) {
        if (sample.timestampSec < start) start = sample.timestampSec;
        if (sample.timestampSec > end) end = sample.timestampSec;
    }
    return { start, end };
}

export async function detectSolarLayoutWasm(input: SolarLayoutDetectInput): Promise<SolarLayoutDetectOutput> {
    const { start, end } = sampleBounds(input.samples);
    const siteTimeZone = buildSiteTimeZone(input.timeZone, start, end);
    return callPWUsageCoreJson('solar_layout_detect', {
        timestamps: input.samples.map(sample => sample.timestampSec),
        solarWh: input.samples.map(sample => sample.solarWh),
        latitude: input.latitude,
        longitude: input.longitude,
        siteTimeZone,
        detectedAt: input.detectedAtSec ?? null,
    });
}

export async function checkSolarLayoutReadinessWasm(
    input: SolarLayoutReadinessInput,
): Promise<SolarLayoutReadinessOutput> {
    const { start, end } = sampleBounds(input.samples);
    const siteTimeZone = buildSiteTimeZone(input.timeZone, start, end);
    return callPWUsageCoreJson('solar_layout_readiness', {
        timestamps: input.samples.map(sample => sample.timestampSec),
        solarWh: input.samples.map(sample => sample.solarWh),
        latitude: input.latitude,
        longitude: input.longitude,
        siteTimeZone,
    });
}
