export interface FleetProduct {
    energy_site_id: number;
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

export class TeslaClient {
    private baseUrl = "https://fleet-api.prd.na.vn.cloud.tesla.com";
    private token: string;

    constructor(token: string) {
        this.token = token;
    }

    private async fetch<T>(path: string, options?: RequestInit): Promise<T> {
        const url = `${this.baseUrl}${path}`;
        const headers = {
            "Authorization": `Bearer ${this.token}`,
            "Content-Type": "application/json",
            ...options?.headers,
        };

        const response = await fetch(url, { ...options, headers });

        if (!response.ok) {
            const body = await response.text();
            throw new Error(`Tesla API Error: ${response.status} ${body}`);
        }

        return response.json();
    }

    async getProducts(): Promise<FleetProduct[]> {
        const result = await this.fetch<{ response: FleetProduct[], count: number }>("/api/1/products");
        return result.response.filter(p => p.energy_site_id !== undefined && p.energy_site_id !== 0);
    }

    async getEnergySiteInfo(siteId: string): Promise<EnergySiteInfo> {
        const result = await this.fetch<{ response: EnergySiteInfo }>(`/api/1/energy_sites/${siteId}/site_info`);
        return result.response;
    }
}
