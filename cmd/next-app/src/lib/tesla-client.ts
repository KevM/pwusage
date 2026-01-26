
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
    site_name: string;
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
    installation_time_zone: string;
    tariff_content_v2: TariffV2;
}

export interface TariffV2 {
    code: string;
    name: string;
    utility: string;
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

export interface TeslaClientConfig {
    accessToken: string;
    refreshToken?: string;
    onTokenUpdate?: (accessToken: string, refreshToken: string) => void;
    tokenRefreshHandler?: (refreshToken: string) => Promise<{ access_token: string; refresh_token: string }>;
}

export class TeslaClient {
    private baseUrl = "https://fleet-api.prd.na.vn.cloud.tesla.com";
    private config: TeslaClientConfig;

    constructor(config: TeslaClientConfig | string) {
        if (typeof config === 'string') {
            this.config = { accessToken: config };
        } else {
            this.config = config;
        }
    }

    private async fetch<T>(path: string, options?: RequestInit): Promise<T> {
        const makeRequest = async (token: string) => {
            const url = `${this.baseUrl}${path}`;
            const headers = {
                "Authorization": `Bearer ${token}`,
                "Content-Type": "application/json",
                ...options?.headers,
            };
            return fetch(url, { ...options, headers });
        };

        let response = await makeRequest(this.config.accessToken);

        if (response.status === 401 && this.config.refreshToken) {
            console.log('Tesla API 401, attempting refresh...');
            try {
                let newTokens: { access_token: string; refresh_token: string };
                if (this.config.tokenRefreshHandler) {
                    newTokens = await this.config.tokenRefreshHandler(this.config.refreshToken);
                } else {
                    newTokens = await TeslaClient.refreshAccessToken(this.config.refreshToken);
                }
                this.config.accessToken = newTokens.access_token;
                this.config.refreshToken = newTokens.refresh_token;

                if (this.config.onTokenUpdate) {
                    this.config.onTokenUpdate(newTokens.access_token, newTokens.refresh_token);
                }

                // Retry with new token
                response = await makeRequest(this.config.accessToken);
            } catch (refreshError) {
                console.error('Token refresh failed:', refreshError);
                // Fall through to original error
            }
        }


        if (!response.ok) {
            const body = await response.text();
            throw new Error(`Tesla API Error: ${response.status} ${body}`);
        }

        return response.json();
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

        const result = await this.fetch<{ response: { time_series: EnergyHistoryEntry[] } }>(`/api/1/energy_sites/${siteId}/calendar_history?${query.toString()}`);
        console.log(`[TeslaClient] History Response for ${start.toISOString()}-${end.toISOString()} (${period}):`, JSON.stringify(result).substring(0, 200));
        return result.response?.time_series ?? [];
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

        const result = await this.fetch<{ response: { time_series: SoeHistoryEntry[] } }>(`/api/1/energy_sites/${siteId}/calendar_history?${query.toString()}`);
        return result.response.time_series;
    }

    async getLiveStatus(siteId: string): Promise<EnergySiteLiveStatus> {
        const result = await this.fetch<{ response: EnergySiteLiveStatus }>(`/api/1/energy_sites/${siteId}/live_status`);
        return result.response;
    }

    static async refreshAccessToken(refreshToken: string): Promise<{ access_token: string; refresh_token: string }> {
        // Delegate to standalone auth module
        const { refreshAccessToken } = await import('./tesla-auth');
        return refreshAccessToken(refreshToken);
    }

    async getUserInfo(): Promise<TeslaUserInfo> {
        const result = await this.fetch<{ response: TeslaUserInfo }>("/api/1/users/me");
        return result.response;
    }
}

export interface TeslaUserInfo {
    email: string;
    full_name: string;
    profile_image_url: string;
    vault_uuid?: string;
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
        offsetMinutes = Math.round((localMs - loc) / (60 * 1000));
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
