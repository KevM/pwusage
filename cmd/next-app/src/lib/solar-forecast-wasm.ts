import { buildSiteTimeZone, callPWUsageCoreJson } from './pwusage-core-wasm';
import type { SolarLayoutDTO } from './solar-layout-wasm';

export interface OpenMeteoWeatherHourlyDTO {
    time: number[];
    shortwave_radiation: Array<number | null>;
    direct_normal_irradiance: Array<number | null>;
    diffuse_radiation: Array<number | null>;
}

export interface OpenMeteoWeatherDTO {
    utc_offset_seconds: number;
    hourly_units: Record<string, string>;
    hourly: OpenMeteoWeatherHourlyDTO;
}

export interface SolarHomeLocationDTO {
    latitude: number;
    longitude: number;
}

export interface SolarForecastIntervalDTO {
    /** UTC epoch seconds. */
    periodStart: number;
    /** UTC epoch seconds. */
    periodEnd: number;
    powerKw: number;
    cautiousPowerKw?: number | null;
}

export interface OpenMeteoForecastInput {
    weather: OpenMeteoWeatherDTO;
    layout: SolarLayoutDTO;
    location: SolarHomeLocationDTO;
    /** UTC epoch seconds. */
    windowStartSec: number;
    /** UTC epoch seconds. */
    windowEndSec: number;
    timeZone: string;
}

export interface SolarForecastHourEnergy {
    /** UTC epoch seconds for the hour start. */
    hourStartSec: number;
    energyWh: number;
}

export interface SolarActualsHourDTO {
    /** UTC epoch seconds for the hour start. */
    hourStartSec: number;
    energyWh: number;
    complete: boolean;
}

export interface SolarForecastCorrectInput {
    intervals: SolarForecastIntervalDTO[];
    /** UTC epoch seconds. */
    fetchedAtSec: number;
    /** UTC epoch seconds. */
    nowSec: number;
    timeZone: string;
    acClipKw?: number | null;
    sameDayPastForecast: SolarForecastHourEnergy[];
    dayAheadPastForecast: SolarForecastHourEnergy[];
    actuals: SolarActualsHourDTO[];
}

export interface SolarForecastCorrectionDTO {
    hourFactors: Record<string, number>;
    fallbackFactor: number;
    samples: number;
}

export interface SolarForecastCorrectOutput {
    sameDay: SolarForecastCorrectionDTO;
    dayAhead: SolarForecastCorrectionDTO;
    intervals: SolarForecastIntervalDTO[];
}

export async function computeOpenMeteoForecastWasm(
    input: OpenMeteoForecastInput,
): Promise<SolarForecastIntervalDTO[]> {
    const siteTimeZone = buildSiteTimeZone(input.timeZone, input.windowStartSec, input.windowEndSec);
    const response = await callPWUsageCoreJson<unknown, { intervals: SolarForecastIntervalDTO[] }>(
        'solar_forecast_open_meteo',
        {
            weather: input.weather,
            layout: input.layout,
            location: input.location,
            windowStart: input.windowStartSec,
            windowEnd: input.windowEndSec,
            siteTimeZone,
        },
    );
    return response.intervals;
}

export async function correctSolarForecastWasm(
    input: SolarForecastCorrectInput,
): Promise<SolarForecastCorrectOutput> {
    const endSec = input.intervals.reduce(
        (max, interval) => Math.max(max, interval.periodEnd),
        Math.max(input.nowSec, input.fetchedAtSec),
    );
    const startSec = Math.min(input.nowSec, input.fetchedAtSec);
    const siteTimeZone = buildSiteTimeZone(input.timeZone, startSec, endSec);
    return callPWUsageCoreJson('solar_forecast_correct', {
        intervals: input.intervals,
        fetchedAt: input.fetchedAtSec,
        now: input.nowSec,
        siteTimeZone,
        acClipKw: input.acClipKw ?? null,
        sameDayPastForecast: input.sameDayPastForecast.map(item => ({
            hourStart: item.hourStartSec,
            energyWh: item.energyWh,
        })),
        dayAheadPastForecast: input.dayAheadPastForecast.map(item => ({
            hourStart: item.hourStartSec,
            energyWh: item.energyWh,
        })),
        actuals: input.actuals.map(item => ({
            hourStart: item.hourStartSec,
            wh: item.energyWh,
            complete: item.complete,
        })),
    });
}
