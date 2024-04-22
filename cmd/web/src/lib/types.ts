export interface UsageReport {
    range: string
	start: Date;
	end: Date
    tariffs: UsageTariff[]
}

export interface UsageTariff {
    tariff : string
    home_usage : number
    solar_production:    number
    grid_imported:   number
    grid_exported:   number
}

export enum UsageRange {
    day = "day",
    week = "week",
    month = "month",
    year = "year"
}

export interface CurrentlyReport {
    grid_exported: number
    grid_imported: number
    load_imported: number
    solar_exported: number
    battery_soc: number
    tariff: string 
}

export interface DashboardReport {
    start: Date
    currently: CurrentlyReport
    year: UsageReport
    month: UsageReport
    week: UsageReport
    day: UsageReport
}
