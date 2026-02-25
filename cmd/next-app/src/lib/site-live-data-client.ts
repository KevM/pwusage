export interface SiteLiveData {
    solarPower: number;
    loadPower: number;
    batteryPower: number;
    gridPower: number;
    percentageCharged: number;
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
