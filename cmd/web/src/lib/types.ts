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