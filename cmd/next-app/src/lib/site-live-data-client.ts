import type { LoadGlyph } from './load-profiles';
import type { MobileBillSummary, MobileDashboardContract } from './mobile-dashboard-contract';

export interface SiteLiveSparklinePoint {
    timestamp: string;
    watts: number;
}

export interface SiteLiveSparklines {
    solar: SiteLiveSparklinePoint[];
    grid: SiteLiveSparklinePoint[];
    load: SiteLiveSparklinePoint[];
}

export interface SiteLiveSparklineScale {
    minWatts: number;
    maxWatts: number;
}

export interface SiteLiveSparklineScales {
    solar: SiteLiveSparklineScale;
    grid: SiteLiveSparklineScale;
    load: SiteLiveSparklineScale;
}

export interface SiteLiveDataHeadroom {
    surplusKwh: number;
    periodName: string;
    glyph: LoadGlyph | null;
    profileLabel: string | null;
}

export interface SiteLiveData {
    solarPower: number;
    loadPower: number;
    batteryPower: number;
    gridPower: number;
    percentageCharged: number;
    currentTariff?: string;
    loadHeadroom?: SiteLiveDataHeadroom | null;
    sparklines?: SiteLiveSparklines;
    sparklineScales?: SiteLiveSparklineScales;
}

/** `view=card`: the lightweight response a Products card polls. */
export interface SiteLiveCardData {
    solarPower: number;
    loadPower: number;
    batteryPower: number;
    gridPower: number;
    percentageCharged: number;
    /** `percentageCharged` when the reading is recent enough to be current; otherwise null. */
    stateOfCharge: number | null;
    currentTariff?: string;
}

export class SiteLiveDataFetchError extends Error {
    readonly status: number;

    constructor(status: number, message: string) {
        super(message);
        this.name = 'SiteLiveDataFetchError';
        this.status = status;
    }
}

export function isValidSiteId(siteId: string | null | undefined): siteId is string {
    return Boolean(siteId && siteId !== 'undefined');
}

export async function fetchSiteLiveData(siteId: string, signal?: AbortSignal): Promise<SiteLiveData> {
    const response = await fetch(`/api/site-live-data?siteId=${encodeURIComponent(siteId)}`, {
        signal
    });

    if (!response.ok) {
        throw new SiteLiveDataFetchError(response.status, `Failed to fetch site live data (${response.status})`);
    }

    return response.json() as Promise<SiteLiveData>;
}

export async function fetchSiteLiveCardData(siteId: string, signal?: AbortSignal): Promise<SiteLiveCardData> {
    const response = await fetch(`/api/site-live-data?siteId=${encodeURIComponent(siteId)}&view=card`, { signal });
    if (!response.ok) {
        throw new SiteLiveDataFetchError(response.status, `Failed to fetch site live data (${response.status})`);
    }
    return response.json() as Promise<SiteLiveCardData>;
}

export async function fetchMobileDashboardContract(
    siteId: string,
    signal?: AbortSignal
): Promise<MobileDashboardContract> {
    const response = await fetch(`/api/site-live-data?siteId=${encodeURIComponent(siteId)}&view=mobile`, { signal });
    if (!response.ok) {
        throw new SiteLiveDataFetchError(response.status, `Failed to fetch mobile dashboard (${response.status})`);
    }
    return response.json() as Promise<MobileDashboardContract>;
}

export async function fetchMobileBillSummary(siteId: string, signal?: AbortSignal): Promise<MobileBillSummary> {
    const response = await fetch(`/api/mobile/bill-summary?siteId=${encodeURIComponent(siteId)}`, { signal });
    if (!response.ok) {
        throw new SiteLiveDataFetchError(response.status, `Failed to fetch mobile bill summary (${response.status})`);
    }
    return response.json() as Promise<MobileBillSummary>;
}
