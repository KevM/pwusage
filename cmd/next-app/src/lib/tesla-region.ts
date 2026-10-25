/**
 * Tesla Fleet API regional hosts. Each Tesla account is served from one region;
 * calling another region's host answers 421 "user out of region, use base URL: …".
 * See https://developer.tesla.com/docs/fleet-api/getting-started/regions-countries.
 *
 * Base URLs come back from Tesla (users/region, 421 bodies) and are stored per
 * user, and the access token is sent to whatever host we use, so only these
 * exact origins are ever accepted.
 */
export const DEFAULT_FLEET_BASE_URL = 'https://fleet-api.prd.na.vn.cloud.tesla.com';
export const EU_FLEET_BASE_URL = 'https://fleet-api.prd.eu.vn.cloud.tesla.com';
const CN_FLEET_BASE_URL = 'https://fleet-api.prd.cn.vn.cloud.tesla.cn';

const FLEET_BASE_URLS = new Set([DEFAULT_FLEET_BASE_URL, EU_FLEET_BASE_URL, CN_FLEET_BASE_URL]);

/** The canonical origin for an allowlisted Fleet host, or null for anything else. */
export function normalizeFleetBaseUrl(value: unknown): string | null {
    if (typeof value !== 'string' || value === '') return null;
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return null;
    }
    if (url.username || url.password || url.port || url.search || url.hash) return null;
    if (url.pathname !== '/' && url.pathname !== '') return null;
    return FLEET_BASE_URLS.has(url.origin) ? url.origin : null;
}

/** The allowlisted base URL a 421 out-of-region body points to, if any. */
export function fleetBaseUrlFrom421(body: string): string | null {
    for (const candidate of body.match(/https:\/\/[^\s"',]+/g) ?? []) {
        const baseUrl = normalizeFleetBaseUrl(candidate);
        if (baseUrl) return baseUrl;
    }
    return null;
}

export type Tesla421Kind = 'out-of-region' | 'partner-not-registered' | 'unknown';

export interface ParsedTesla421 {
    kind: Tesla421Kind;
    /** The allowlisted host named by the body, if any. */
    baseUrl: string | null;
}

/**
 * A 421 has two meanings that must not be collapsed into "switch host":
 * the account belongs to another region, or the partner application itself is
 * not registered in the region that answered. The second names the current host,
 * so following it is a no-op and the request would fail again.
 */
export function parseTesla421(body: string): ParsedTesla421 {
    const baseUrl = fleetBaseUrlFrom421(body);
    if (/must be registered in the current region/i.test(body)) {
        return { kind: 'partner-not-registered', baseUrl };
    }
    if (/user out of region/i.test(body)) {
        return { kind: 'out-of-region', baseUrl };
    }
    return { kind: 'unknown', baseUrl };
}
