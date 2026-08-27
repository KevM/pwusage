import type { LoadGlyph } from './load-profiles';

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
