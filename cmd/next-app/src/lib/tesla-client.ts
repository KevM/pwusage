import { TeslaRefreshError } from './tesla-refresh-outcome';
import { ioSignal, checkIoDeadline, abortable, ioDelay } from './io-deadline';
import {
    DEFAULT_FLEET_BASE_URL,
    normalizeFleetBaseUrl,
    parseTesla421,
    type Tesla421Kind,
} from './tesla-region';
export interface FleetProduct {
    energy_site_id?: number;
    resource_type: string;
    site_name: string;
    id: string;
    gateway_id: string;
    asset_site_id: string;
    warp_site_number: string;
    percentage_charged: number;
    battery_type: string;
    backup_capable: boolean;
    battery_power: number;
    storm_mode_enabled: boolean;
    sync_grid_alert_enabled: boolean;
    breaker_alert_enabled: boolean;
    id_s?: string;
    vehicle_id?: number;
    vin?: string;
    display_name?: string;
    color?: string;
    option_codes?: string;
    state?: string;
    components: {
        battery: boolean;
        battery_type: string;
        solar: boolean;
        solar_type: string;
        grid: boolean;
        load_meter: boolean;
        market_type: string;
    };
}

export interface EnergySiteInfo {
    id: string;
    // Tesla can omit these for products still being commissioned or non-Powerwall
    // products lacking full metadata; upsertSite defaults them (see site-repo.ts).
    site_name?: string;
    backup_reserve_percent: number;
    default_real_mode: string;
    installation_date: string;
    user_settings: {
        storm_mode_enabled: boolean;
        sync_grid_alert_enabled: boolean;
        breaker_alert_enabled: boolean;
    };
    components: {
        solar: boolean;
        battery: boolean;
        grid: boolean;
        backup: boolean;
        gateway: string;
        load_meter: boolean;
        tou_capable: boolean;
        storm_mode_capable: boolean;
        battery_type: string;
        configurable: boolean;
        grid_services_enabled: boolean;
    };
    version: string;
    battery_count: number;
    nameplate_power: number;
    nameplate_energy: number;
    installation_time_zone?: string;
    tariff_content_v2: TariffV2;
}

export interface TariffV2 {
    code: string;
    name: string;
    utility: string;
    currency?: string;
    energy_charges: Record<string, EnergyChargeRates>;
    seasons: Record<string, Season>;
    sell_tariff: {
        name: string;
        utility: string;
        energy_charges: Record<string, EnergyChargeRates>;
        seasons: Record<string, Season>;
    };
}

export interface EnergyChargeRates {
    rates: Record<string, number>;
}

export interface Season {
    fromDay: number;
    toDay: number;
    fromMonth: number;
    toMonth: number;
    tou_periods: Record<string, SeasonPeriods>;
}

export interface SeasonPeriods {
    periods: SeasonPeriod[];
}

export interface SeasonPeriod {
    fromDayOfWeek: number;
    fromHour: number;
    fromMinute: number;
    toDayOfWeek: number;
    toHour: number;
    toMinute: number;
}

export interface StoredTeslaCredentials {
    access_token?: string | null;
    refresh_token?: string | null;
}

export interface TeslaClientConfig {
    accessToken: string;
    /**
     * Runs before each Fleet request. It may return the account's stored
     * credentials; a rotated pair is adopted so a stale copy never reaches Tesla.
     */
    beforeRequest?: () => Promise<StoredTeslaCredentials | null | void>;
    refreshToken?: string;
    onTokenUpdate?: (accessToken: string, refreshToken: string) => void;
    onTokenError?: (error: Error) => void;
    tokenRefreshHandler?: (refreshToken: string) => Promise<{ access_token: string; refresh_token: string }>;
    /** The account's regional Fleet host; unknown or unrecognized hosts use North America. */
    baseUrl?: string | null;
    /** Called when Tesla points this account at another regional host (users/region or a 421). */
    onBaseUrlChange?: (baseUrl: string) => void | Promise<void>;
}

const RATE_LIMIT_MAX_RETRIES = 2;
// Per-attempt Fleet API deadline. Without it a blackholed host can hold the
// login callback open until the route's maxDuration. Retries (401/421/429) each
// get their own attempt, so this bounds one request rather than the whole call.
const FLEET_REQUEST_TIMEOUT_MS = 8000;
const RATE_LIMIT_DEFAULT_DELAY_MS = 1000;
const RATE_LIMIT_MAX_DELAY_MS = 60_000;

const sleep = ioDelay;

/**
 * Parse an HTTP `Retry-After` header (delta-seconds or HTTP-date) into a delay
 * in milliseconds, falling back to a default and capping absurd values.
 */
function parseRetryAfter(header: string | null): number {
    if (!header) return RATE_LIMIT_DEFAULT_DELAY_MS;

    const seconds = Number(header);
    if (Number.isFinite(seconds)) {
        return Math.min(Math.max(seconds, 0) * 1000, RATE_LIMIT_MAX_DELAY_MS);
    }

    const dateMs = Date.parse(header);
    if (!Number.isNaN(dateMs)) {
        return Math.min(Math.max(dateMs - Date.now(), 0), RATE_LIMIT_MAX_DELAY_MS);
    }

    return RATE_LIMIT_DEFAULT_DELAY_MS;
}

export class TeslaAuthError extends Error {
    readonly status: number;

    constructor(message: string, status: number = 401) {
        super(message);
        this.name = 'TeslaAuthError';
        this.status = status;
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, TeslaAuthError);
        }
    }
}

function regionErrorMessage(kind: Tesla421Kind, host: string): string {
    if (kind === 'partner-not-registered') {
        return `Tesla API Error: 421 Tesla partner account is not registered in ${host}`;
    }
    if (kind === 'out-of-region') {
        return `Tesla API Error: 421 region response did not resolve to a different host than ${host}`;
    }
    return 'Tesla API Error: 421 response did not identify a supported regional host';
}

/**
 * A 421 that must not be followed as a host redirect: the partner app is not
 * registered in the region, the body named no allowlisted host, or following
 * the redirect did not fix the response. The raw Tesla body is never included
 * in the message because isTeslaAuthError matches message substrings.
 */
export class TeslaRegionError extends Error {
    readonly kind: Tesla421Kind;
    readonly host: string;

    constructor(kind: Tesla421Kind, host: string) {
        super(regionErrorMessage(kind, host));
        this.name = 'TeslaRegionError';
        this.kind = kind;
        this.host = host;
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, TeslaRegionError);
        }
    }
}
export function isTeslaAuthError(error: unknown): boolean {
    if (error instanceof TeslaAuthError || (error instanceof Error && error.name === 'TeslaAuthError')) {
        return true;
    }
    return error instanceof TeslaRefreshError && error.outcome === 'credential_rejected';
}

/**
 * The `time_series` of a calendar_history answer. An empty result counts as a
 * stored fact ("Tesla has no data for this day"), so only the shapes Tesla uses
 * for that are empty: `time_series: []`, and for a day with no data (observed
 * 2026-10-25) an energy answer with an empty `serial_number` and no
 * `time_series`, or an SOE `response` of "". Anything else is malformed and
 * throws, like a failed request, so it is retried instead of recorded.
 */
function calendarTimeSeries<T>(result: unknown, kind: 'energy' | 'soe'): T[] {
    const response = (result as { response?: unknown } | null)?.response;
    if (response !== null && typeof response === 'object') {
        const body = response as { time_series?: unknown; serial_number?: unknown };
        if (Array.isArray(body.time_series)) return body.time_series as T[];
        if (kind === 'energy' && !('time_series' in body) && body.serial_number === '') return [];
    } else if (kind === 'soe' && response === '') {
        return [];
    }
    // The body is logged, never put in the message: isTeslaAuthError matches message substrings
    // (e.g. `invalid_grant`), and a terminal error revokes the owner (DesignDecisions.md).
    const message = `Malformed Tesla ${kind === 'energy' ? 'energy' : 'SOE'} history response`;
    console.warn(`[TeslaClient] ${message}:`, JSON.stringify(result).substring(0, 200));
    throw new Error(message);
}

export class TeslaClient {
    private baseUrl: string;
    private config: TeslaClientConfig;
    private retiredRefreshTokens = new Set<string>();

    constructor(config: TeslaClientConfig | string) {
        if (typeof config === 'string') {
            this.config = { accessToken: config };
        } else {
            this.config = config;
        }
        this.baseUrl = normalizeFleetBaseUrl(this.config.baseUrl) ?? DEFAULT_FLEET_BASE_URL;
    }

    getBaseUrl(): string {
        return this.baseUrl;
    }

    /** Switch to an allowlisted regional host and tell the owner so it can be stored. */
    private async adoptBaseUrl(baseUrl: string): Promise<void> {
        if (baseUrl === this.baseUrl) return;
        console.log(`[TeslaClient] Switching Fleet API host ${this.baseUrl} -> ${baseUrl}`);
        this.baseUrl = baseUrl;
        try {
            await this.config.onBaseUrlChange?.(baseUrl);
        } catch (err) {
            // Persisting is best effort: a later 421 re-learns the host.
            console.error('[TeslaClient] Failed to record Fleet API host:', err);
        }
    }

    /**
     * Take another worker's rotation instead of refreshing a consumed grant.
     * A grant this client already replaced is never adopted back.
     */
    private adoptStoredCredentials(stored: StoredTeslaCredentials | null | void): void {
        if (!stored?.access_token || !stored.refresh_token) return;
        if (stored.refresh_token === this.config.refreshToken || this.retiredRefreshTokens.has(stored.refresh_token)) return;
        if (this.config.refreshToken) this.retiredRefreshTokens.add(this.config.refreshToken);
        this.config.accessToken = stored.access_token;
        this.config.refreshToken = stored.refresh_token;
    }

    private async fetch<T>(path: string, options?: RequestInit): Promise<T> {
        // The host this request last went to. Concurrent requests share this.baseUrl,
        // so a 421 is judged against the host that answered it, not the current one.
        let requestBaseUrl = this.baseUrl;
        // The credentials this request was sent with. Parallel requests share
        // this.config, so a 401 is judged against what it actually sent.
        let sentAccessToken = this.config.accessToken;
        let sentRefreshToken = this.config.refreshToken;
        const makeRequest = async () => {
            if (this.config.beforeRequest) this.adoptStoredCredentials(await this.config.beforeRequest());
            const token = this.config.accessToken;
            sentAccessToken = token;
            sentRefreshToken = this.config.refreshToken;
            requestBaseUrl = this.baseUrl;
            const url = `${requestBaseUrl}${path}`;
            const headers = {
                "Authorization": `Bearer ${token}`,
                "Content-Type": "application/json",
                ...options?.headers,
            };
            checkIoDeadline();
            const signals: AbortSignal[] = [AbortSignal.timeout(FLEET_REQUEST_TIMEOUT_MS)];
            const inherited = ioSignal();
            if (inherited) signals.push(inherited);
            if (options?.signal) signals.push(options.signal);
            const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);
            return abortable(fetch(url, { ...options, headers, signal }), signal);
        };

        let response = await makeRequest();

        // Handle 401 (refresh once) and 429 (bounded backoff) in a single loop so
        // an expired/revoked token surfaced *after* a 429 retry still triggers the
        // refresh path instead of falling straight through to a hard error.
        let refreshAttempted = false;
        let rateLimitAttempt = 0;
        let regionRetried = false;
        let regionError: TeslaRegionError | undefined;
        let errorBody: string | undefined;
        while (true) {
            if (response.status === 401 && sentRefreshToken && !refreshAttempted) {
                refreshAttempted = true;
                if (this.config.accessToken !== sentAccessToken) {
                    // A parallel request on this client already refreshed:
                    // retry with its credentials instead of rotating again.
                    response = await makeRequest();
                    continue;
                }
                console.log('Tesla API 401, attempting refresh...');
                try {
                    let newTokens: { access_token: string; refresh_token: string };
                    if (this.config.tokenRefreshHandler) {
                        newTokens = await abortable(this.config.tokenRefreshHandler(sentRefreshToken));
                    } else {
                        newTokens = await TeslaClient.refreshAccessToken(sentRefreshToken);
                    }
                    if (sentRefreshToken !== newTokens.refresh_token) this.retiredRefreshTokens.add(sentRefreshToken);
                    this.config.accessToken = newTokens.access_token;
                    this.config.refreshToken = newTokens.refresh_token;

                    if (this.config.onTokenUpdate) {
                        this.config.onTokenUpdate(newTokens.access_token, newTokens.refresh_token);
                    }
                } catch (refreshError) {
                    checkIoDeadline();
                    console.error('Token refresh failed:', refreshError);
                    if (this.config.onTokenError && refreshError instanceof Error) {
                        await this.config.onTokenError(refreshError);
                    }
                    // Preserve the refresh failure. The original 401 only says
                    // the access token expired; a transient token-endpoint error
                    // must not be reclassified as revoked credentials.
                    throw refreshError;
                }
                // A retry can reach Tesla and then lose its response. Keep that
                // transport failure distinct from the original rejected request.
                response = await makeRequest();
                continue;
            }

            // Honor Tesla's rate limiting: back off on 429 and retry a bounded
            // number of times before surfacing the error.
            if (response.status === 429 && rateLimitAttempt < RATE_LIMIT_MAX_RETRIES) {
                const delayMs = parseRetryAfter(response.headers.get('Retry-After'));
                console.warn(`Tesla API 429, retrying in ${delayMs}ms (attempt ${rateLimitAttempt + 1}/${RATE_LIMIT_MAX_RETRIES})`);
                await sleep(delayMs);
                rateLimitAttempt++;
                response = await makeRequest();
                continue;
            }

            // Wrong region: Tesla names the account's host in the body. Follow an
            // out-of-region redirect once, and only to an allowlisted Fleet host.
            // A 421 can also mean the partner app is not registered in the region
            // that answered; that host is usually the current one, so retrying is
            // a no-op and must surface as a region error instead.
            if (response.status === 421) {
                errorBody = await abortable(response.text());
                const parsed = parseTesla421(errorBody);
                const kind: Tesla421Kind = parsed.kind === 'out-of-region' && !parsed.baseUrl
                    ? 'unknown'
                    : parsed.kind;

                if (kind === 'out-of-region' && !regionRetried
                    && parsed.baseUrl && parsed.baseUrl !== requestBaseUrl) {
                    regionRetried = true;
                    await this.adoptBaseUrl(parsed.baseUrl);
                    errorBody = undefined;
                    response = await makeRequest();
                    continue;
                }

                regionError = new TeslaRegionError(kind, requestBaseUrl);
                if (kind === 'partner-not-registered') {
                    console.error(
                        `[TeslaClient] Tesla partner app is not registered for ${requestBaseUrl}. Register the app for this region.`
                    );
                } else if (kind === 'out-of-region') {
                    console.warn(
                        `[TeslaClient] Tesla 421 did not resolve to a different host than ${requestBaseUrl}`
                    );
                } else {
                    console.warn('[TeslaClient] Tesla 421 named no supported regional host');
                }
            }

            break;
        }

        if (regionError) {
            throw regionError;
        }

        if (!response.ok) {
            const body = errorBody ?? await abortable(response.text());
            const shortBody = body.length > 200 ? body.substring(0, 200) + '...' : body;
            if (response.status === 401 || response.status === 403) {
                throw new TeslaAuthError(`Tesla API Error: ${response.status} ${shortBody}`, response.status);
            }
            throw new Error(`Tesla API Error: ${response.status} ${shortBody}`);
        }

        return abortable(response.json());
    }

    async getProducts(): Promise<FleetProduct[]> {
        const result = await this.fetch<{ response: FleetProduct[], count: number }>("/api/1/products");
        // Return ALL products, but we might want to distinguish them
        return result.response;
    }

    async getEnergySiteInfo(siteId: string): Promise<EnergySiteInfo> {
        const result = await this.fetch<{ response: EnergySiteInfo }>(`/api/1/energy_sites/${siteId}/site_info`);
        return result.response;
    }

    async getEnergyHistory(siteId: string, start: Date, end: Date, period: string = "day", timeZone: string): Promise<EnergyHistoryEntry[]> {
        const s = formatDateWithTimezone(start, timeZone);
        const e = formatDateWithTimezone(end, timeZone);
        const query = new URLSearchParams({
            kind: 'energy',
            start_date: s,
            end_date: e,
            period: period,
            time_zone: timeZone
        });

        console.log(`[TeslaClient] Fetching ${siteId} history: kind=energy, period=${period}, time_zone=${timeZone}`);
        console.log(`[TeslaClient] Params: start_date=${s}, end_date=${e}`);

        const teslaStart = Date.now();
        const result = await this.fetch<unknown>(`/api/1/energy_sites/${siteId}/calendar_history?${query.toString()}`);
        console.log(`[TeslaClient] History fetch duration: ${Date.now() - teslaStart}ms`);

        console.log(`[TeslaClient] History Response for ${start.toISOString()}-${end.toISOString()} (${period}):`, JSON.stringify(result).substring(0, 200));
        return calendarTimeSeries<EnergyHistoryEntry>(result, 'energy');
    }

    async getSoeHistory(siteId: string, start: Date, end: Date, period: string = "day", timeZone: string): Promise<SoeHistoryEntry[]> {
        const s = formatDateWithTimezone(start, timeZone);
        const e = formatDateWithTimezone(end, timeZone);
        const query = new URLSearchParams({
            kind: 'soe',
            start_date: s,
            end_date: e,
            period,
            time_zone: timeZone
        });

        const result = await this.fetch<unknown>(`/api/1/energy_sites/${siteId}/calendar_history?${query.toString()}`);
        const rows = calendarTimeSeries<RawSoeHistoryEntry>(result, 'soe');

        return rows
            .map((row) => {
                const normalizedSoc = typeof row.percentage_charged === 'number'
                    ? row.percentage_charged
                    : row.soe;

                return {
                    timestamp: row.timestamp,
                    percentage_charged: normalizedSoc
                };
            })
            .filter((row): row is SoeHistoryEntry => typeof row.timestamp === 'string' && typeof row.percentage_charged === 'number');
    }

    async getLiveStatus(siteId: string): Promise<EnergySiteLiveStatus> {
        const teslaStart = Date.now();
        const result = await this.fetch<{ response: EnergySiteLiveStatus }>(`/api/1/energy_sites/${siteId}/live_status`);
        console.log(`[TeslaClient] Live Status fetch duration: ${Date.now() - teslaStart}ms`);
        return result.response;
    }

    static async refreshAccessToken(refreshToken: string): Promise<{ access_token: string; refresh_token: string }> {
        // Delegate to standalone auth module
        const { refreshAccessToken } = await import('./tesla-auth');
        return refreshAccessToken(refreshToken);
    }

    /**
     * Ask Tesla which regional host serves this account (GET /api/1/users/region,
     * answered by any region) and use it for later calls. Returns the host in use.
     */
    async resolveRegion(): Promise<string> {
        const result = await this.fetch<{ response?: { region?: string; fleet_api_base_url?: string } }>("/api/1/users/region");
        const baseUrl = normalizeFleetBaseUrl(result.response?.fleet_api_base_url);
        if (baseUrl) {
            await this.adoptBaseUrl(baseUrl);
        } else {
            console.warn('[TeslaClient] users/region returned no recognized Fleet host:', JSON.stringify(result).substring(0, 200));
        }
        return this.baseUrl;
    }

    async getUserInfo(): Promise<TeslaUserInfo> {
        const result = await this.fetch<{ response: TeslaUserInfo }>("/api/1/users/me");
        return result.response;
    }

    /**
     * Set the site's backup reserve percentage.
     *
     * POST /api/1/energy_sites/{site_id}/backup with `{ backup_reserve_percent }`.
     * This is a *write* command against a live Powerwall — it changes how much
     * battery the site holds in reserve for grid outages.
     *
     * @param siteId Energy site id.
     * @param backupReservePercent Integer 0-100.
     * @returns Tesla command response. Observed live: `{ Code: 200, Message: 'Backup reserve updated' }`.
     *   Note: the new reserve is applied asynchronously — `site_info` can lag the
     *   command by minutes (its `backup_reserve_percent` is cached).
     */
    async setBackupReserve(siteId: string, backupReservePercent: number): Promise<EnergyCommandResponse> {
        if (!Number.isInteger(backupReservePercent) || backupReservePercent < 0 || backupReservePercent > 100) {
            throw new Error(
                `Invalid backup_reserve_percent: ${backupReservePercent}. Must be an integer between 0 and 100.`
            );
        }

        const result = await this.fetch<{ response: EnergyCommandResponse }>(
            `/api/1/energy_sites/${siteId}/backup`,
            {
                method: "POST",
                body: JSON.stringify({ backup_reserve_percent: backupReservePercent }),
            }
        );
        return result.response;
    }
}

/**
 * Tesla Fleet API command acknowledgement returned by energy site write
 * endpoints (e.g. `/backup`).
 *
 * Note the PascalCase keys: the live `/backup` endpoint returns
 * `{ "Code": 200, "Message": "Backup reserve updated" }`, which differs from the
 * lowercase `{ code, message }` shown in some Tesla docs. Fields are optional so
 * callers can tolerate the inconsistency across endpoints/regions.
 */
export interface EnergyCommandResponse {
    Code?: number;
    Message?: string;
}

export interface TeslaUserInfo {
    email: string;
    full_name?: string;
    profile_image_url?: string;
    vault_uuid?: string;
    sub?: string;
    id?: string;
}

export interface EnergySiteLiveStatus {
    solar_power: number;
    percentage_charged: number;
    backup_capable: boolean;
    battery_power: number;
    load_power: number;
    grid_status: string;
    grid_services_active: boolean;
    grid_power: number;
    grid_services_power: number;
    generator_power: number;
    island_status: string;
    storm_mode_active: boolean;
    timestamp: string;
}

export interface EnergyHistoryEntry {
    timestamp: string;
    solar_energy_exported: number;
    generator_energy_exported: number;
    grid_energy_imported: number;
    grid_services_energy_imported: number;
    grid_services_energy_exported: number;
    grid_energy_exported_from_solar: number;
    grid_energy_exported_from_generator: number;
    grid_energy_exported_from_battery: number;
    battery_energy_exported: number;
    battery_energy_imported_from_grid: number;
    battery_energy_imported_from_solar: number;
    battery_energy_imported_from_generator: number;
    consumer_energy_imported_from_grid: number;
    consumer_energy_imported_from_solar: number;
    consumer_energy_imported_from_battery: number;
    consumer_energy_imported_from_generator: number;
    total_home_usage: number;
    total_solar_generation: number;
    total_battery_charge: number;
    total_battery_discharge: number;
    total_grid_energy_exported: number;
}

export interface SoeHistoryEntry {
    timestamp: string;
    percentage_charged: number;
}

interface RawSoeHistoryEntry {
    timestamp?: string;
    percentage_charged?: number;
    soe?: number;
}

function formatDateWithTimezone(date: Date, timeZone: string): string {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
        timeZoneName: 'shortOffset'
    }).formatToParts(date);

    const get = (type: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === type)?.value ?? '';
    const year = get('year');
    const month = get('month');
    const day = get('day');
    const hour = get('hour');
    const minute = get('minute');
    const second = get('second');
    const tzName = get('timeZoneName'); // e.g. GMT-05 or GMT-05:00

    let offsetMinutes = 0;
    const match = tzName.match(/GMT([+-]?)(\d{1,2})(?::?(\d{2}))?/i);
    if (match) {
        const sign = match[1] === '-' ? -1 : 1;
        const hrs = Number(match[2]);
        const mins = match[3] ? Number(match[3]) : 0;
        offsetMinutes = sign * (hrs * 60 + mins);
    } else {
        // Fallback to local offset in the target timezone via toLocaleString
        const localMs = date.getTime();
        const loc = new Date(date.toLocaleString('en-US', { timeZone })).getTime();
        // offsetMinutes should be (SiteTime - UTC) / 60000.
        // e.g. 00:00 Wall - 07:00 UTC = -420 mins (-7h).
        offsetMinutes = Math.round((loc - localMs) / (60 * 1000));
    }

    const offH = Math.floor(Math.abs(offsetMinutes) / 60)
        .toString()
        .padStart(2, '0');
    const offM = Math.abs(offsetMinutes % 60)
        .toString()
        .padStart(2, '0');
    const sign = offsetMinutes >= 0 ? '+' : '-';
    const offset = `${sign}${offH}:${offM}`;

    return `${year}-${month}-${day}T${hour}:${minute}:${second}${offset}`;
}
