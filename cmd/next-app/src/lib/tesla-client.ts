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

    async getEnergyHistory(siteId: string, start: Date, end: Date, period: string = "day", timeZone: string): Promise<EnergyHistoryEntry[]> {
        const s = start.toISOString();
        const e = end.toISOString();
        // Tesla API expects specific format, but ISO might work or we need to match Go's format.
        // Go uses: 2006-01-02T15:04:05-07:00
        // JS toISOString is 2024-11-20T15:37:03.000Z (UTC).
        // We might need to handle timezone carefully if the API expects local time with offset.
        // For now, let's pass ISO string and see, or construct it manually if needed.
        // Actually, let's use a helper to format it similar to Go if we can, but standard ISO is usually safe.

        const query = new URLSearchParams({
            kind: 'energy',
            start_date: s,
            end_date: e,
            period: period,
            time_zone: timeZone
        });

        const result = await this.fetch<{ response: { time_series: EnergyHistoryEntry[] } }>(`/api/1/energy_sites/${siteId}/calendar_history?${query.toString()}`);
        return result.response.time_series;
    }

    async getLiveStatus(siteId: string): Promise<EnergySiteLiveStatus> {
        const result = await this.fetch<{ response: EnergySiteLiveStatus }>(`/api/1/energy_sites/${siteId}/live_status`);
        return result.response;
    }
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
