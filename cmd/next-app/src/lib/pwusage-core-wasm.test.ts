import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSiteTimeZone } from './pwusage-core-wasm';
import {
    evaluateSmartShiftWasm,
    type SmartShiftLoadProfileDTO,
    type SmartShiftLoadTimingDTO,
    type SmartShiftPlanningSlotDTO,
} from './smart-shift-wasm';
import {
    computeOpenMeteoForecastWasm,
    correctSolarForecastWasm,
    type OpenMeteoWeatherDTO,
    type SolarActualsHourDTO,
    type SolarForecastHourEnergy,
} from './solar-forecast-wasm';
import {
    checkSolarLayoutReadinessWasm,
    detectSolarLayoutWasm,
    type SolarLayoutDTO,
    type SolarLayoutSample,
} from './solar-layout-wasm';

const shouldTestWasm = Boolean(process.env.CI) || existsSync('wasm/pwusage-core.wasm');

interface SolarLayoutFixture {
    input: {
        latitude: number;
        longitude: number;
        timeZone: string;
        start: string;
        stepMinutes: number;
        solarWh: string;
    };
    result: {
        status: string;
        confidence: string | null;
        planes: Array<{ azimuth: number; tilt: number; dcKwp: number }>;
        acClipKw: number | null;
        historyDays: number;
        clearDays: number;
        firstDay: string | null;
        lastDay: string | null;
    };
}

function loadSolarLayoutFixture(name: string): {
    fixture: SolarLayoutFixture;
    samples: SolarLayoutSample[];
} {
    const path = resolve(
        process.cwd(),
        '../ios-app/Packages/PWUsageCore/Tests/PWUsageCoreTests/Fixtures/SolarLayout',
        name,
    );
    const fixture = JSON.parse(readFileSync(path, 'utf8')) as SolarLayoutFixture;
    const raw = Buffer.from(fixture.input.solarWh, 'base64');
    const floats = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
    const startSec = Math.floor(Date.parse(fixture.input.start) / 1000);
    const stepSec = fixture.input.stepMinutes * 60;
    const samples: SolarLayoutSample[] = [];
    for (let index = 0; index < floats.length; index += 1) {
        const value = floats[index];
        if (Number.isFinite(value)) {
            samples.push({ timestampSec: startSec + index * stepSec, solarWh: value });
        }
    }
    return { fixture, samples };
}

describe('buildSiteTimeZone', () => {
    it('resolves US DST transitions to the exact second', () => {
        const start = Date.parse('2026-02-01T00:00:00Z') / 1000;
        const end = Date.parse('2026-12-01T00:00:00Z') / 1000;
        const zone = buildSiteTimeZone('America/Los_Angeles', start, end);
        expect(zone.identifier).toBe('America/Los_Angeles');
        expect(zone.initialOffsetSeconds).toBe(-8 * 3600);
        expect(zone.transitions).toContainEqual({
            atEpochSeconds: Date.parse('2026-03-08T10:00:00Z') / 1000,
            offsetSeconds: -7 * 3600,
        });
        expect(zone.transitions).toContainEqual({
            atEpochSeconds: Date.parse('2026-11-01T09:00:00Z') / 1000,
            offsetSeconds: -8 * 3600,
        });
    });

    it('handles Southern Hemisphere half-hour DST zones and UTC', () => {
        const start = Date.parse('2026-02-01T00:00:00Z') / 1000;
        const end = Date.parse('2026-11-01T00:00:00Z') / 1000;
        const adelaide = buildSiteTimeZone('Australia/Adelaide', start, end);
        expect(adelaide.initialOffsetSeconds).toBe(10.5 * 3600);
        expect(adelaide.transitions.some(t => t.offsetSeconds === 9.5 * 3600)).toBe(true);
        expect(adelaide.transitions.some(t => t.offsetSeconds === 10.5 * 3600)).toBe(true);

        const utc = buildSiteTimeZone('UTC', start, end);
        expect(utc.initialOffsetSeconds).toBe(0);
        expect(utc.transitions).toEqual([]);
    });
});

describe('PWUsageCore Wasm bridge', () => {
    it.runIf(shouldTestWasm)('checks solar layout readiness and detects planes matching Swift fixtures', async () => {
        const shortData = loadSolarLayoutFixture('east-west-30d.json');
        const readiness = await checkSolarLayoutReadinessWasm({
            samples: shortData.samples,
            latitude: shortData.fixture.input.latitude,
            longitude: shortData.fixture.input.longitude,
            timeZone: shortData.fixture.input.timeZone,
        });
        expect(readiness).toEqual({ producingDays: 30, isReady: false, daysNeeded: 12 });

        const shortDetect = await detectSolarLayoutWasm({
            samples: shortData.samples,
            latitude: shortData.fixture.input.latitude,
            longitude: shortData.fixture.input.longitude,
            timeZone: shortData.fixture.input.timeZone,
        });
        expect(shortDetect.result.status).toBe('not-enough-history');
        expect(shortDetect.result.historyDays).toBe(30);
        expect(shortDetect.result.firstDay).toBe('2026-05-01');
        expect(shortDetect.result.lastDay).toBe('2026-05-30');
        expect(shortDetect.forecastLayout ?? null).toBeNull();
        expect(shortDetect.historyOutlook).toBe('moreHistoryMayHelp');

        const fullData = loadSolarLayoutFixture('east-west-clipped-60d.json');
        const detected = await detectSolarLayoutWasm({
            samples: fullData.samples,
            latitude: fullData.fixture.input.latitude,
            longitude: fullData.fixture.input.longitude,
            timeZone: fullData.fixture.input.timeZone,
            detectedAtSec: Date.parse('2026-06-30T00:00:00Z') / 1000,
        });
        expect(detected.result.status).toBe(fullData.fixture.result.status);
        expect(detected.result.confidence).toBe(fullData.fixture.result.confidence);
        expect(detected.result.historyDays).toBe(fullData.fixture.result.historyDays);
        expect(detected.result.clearDays).toBe(fullData.fixture.result.clearDays);
        expect(detected.result.firstDay).toBe(fullData.fixture.result.firstDay);
        expect(detected.result.lastDay).toBe(fullData.fixture.result.lastDay);
        expect(detected.result.acClipKw).toBeCloseTo(fullData.fixture.result.acClipKw ?? 0, 1);
        expect(detected.result.planes).toHaveLength(fullData.fixture.result.planes.length);
        for (let index = 0; index < fullData.fixture.result.planes.length; index += 1) {
            expect(detected.result.planes[index].azimuth).toBeCloseTo(
                fullData.fixture.result.planes[index].azimuth,
                1,
            );
            expect(detected.result.planes[index].tilt).toBeCloseTo(
                fullData.fixture.result.planes[index].tilt,
                1,
            );
            expect(detected.result.planes[index].dcKwp).toBeCloseTo(
                fullData.fixture.result.planes[index].dcKwp,
                1,
            );
        }
        expect(detected.forecastLayout?.planes).toHaveLength(2);
        expect(detected.historyOutlook).toBe('usable');
    }, 30_000);

    it.runIf(shouldTestWasm)('computes Open-Meteo solar forecast intervals and applies cohort correction', async () => {
        const startSec = Date.parse('2026-06-15T00:00:00Z') / 1000;
        const hours = 72;
        const time: number[] = [];
        const ghi: number[] = [];
        const dni: number[] = [];
        const dhi: number[] = [];
        for (let index = 1; index <= hours; index += 1) {
            const endSec = startSec + index * 3600;
            time.push(endSec);
            const utcHour = new Date((endSec - 1800) * 1000).getUTCHours();
            // Clear-sky bell curve around solar noon in California (UTC 14..26 => PDT 7..19).
            const localHour = (utcHour + 24 - 7) % 24;
            const daylight = localHour >= 7 && localHour <= 18
                ? Math.sin(((localHour - 6) / 13) * Math.PI)
                : 0;
            ghi.push(Math.round(daylight * 900));
            dni.push(Math.round(daylight * 850));
            dhi.push(Math.round(daylight * 120));
        }

        const weather: OpenMeteoWeatherDTO = {
            utc_offset_seconds: 0,
            hourly_units: {
                time: 'unixtime',
                shortwave_radiation: 'W/m²',
                direct_normal_irradiance: 'W/m²',
                diffuse_radiation: 'W/m²',
            },
            hourly: {
                time,
                shortwave_radiation: ghi,
                direct_normal_irradiance: dni,
                diffuse_radiation: dhi,
            },
        };
        const layout: SolarLayoutDTO = {
            planes: [{ azimuth: 180, tilt: 25, dcKwp: 8 }],
            acClipKw: 5.5,
            confidence: 'high',
            detectedAt: startSec,
        };

        const intervals = await computeOpenMeteoForecastWasm({
            weather,
            layout,
            location: { latitude: 37.77, longitude: -122.42 },
            windowStartSec: startSec + 6 * 3600,
            windowEndSec: startSec + 60 * 3600,
            timeZone: 'America/Los_Angeles',
        });

        expect(intervals.length).toBeGreaterThanOrEqual(54);
        const peakKw = Math.max(...intervals.map(interval => interval.powerKw));
        expect(peakKw).toBeGreaterThan(4);
        expect(peakKw).toBeLessThanOrEqual(5.5);

        // Build 6 days of complete noon actuals at 0.8x same-day and 1.2x day-ahead forecast.
        const nowSec = startSec + 18 * 3600;
        const sameDayPastForecast: SolarForecastHourEnergy[] = [];
        const dayAheadPastForecast: SolarForecastHourEnergy[] = [];
        const actuals: SolarActualsHourDTO[] = [];
        for (let day = 1; day <= 6; day += 1) {
            const noonUtcSec = Date.parse(`2026-06-${String(15 - day).padStart(2, '0')}T19:00:00Z`) / 1000;
            sameDayPastForecast.push({ hourStartSec: noonUtcSec, energyWh: 4000 });
            dayAheadPastForecast.push({ hourStartSec: noonUtcSec, energyWh: 2500 });
            actuals.push({ hourStartSec: noonUtcSec, energyWh: 3200, complete: true });
        }

        const corrected = await correctSolarForecastWasm({
            intervals,
            fetchedAtSec: nowSec,
            nowSec,
            timeZone: 'America/Los_Angeles',
            acClipKw: 5.5,
            sameDayPastForecast,
            dayAheadPastForecast,
            actuals,
        });

        expect(corrected.sameDay.samples).toBe(6);
        expect(corrected.sameDay.fallbackFactor).toBeCloseTo(0.8, 3);
        expect(corrected.dayAhead.fallbackFactor).toBeCloseTo(1.28, 3);
        expect(corrected.intervals).toHaveLength(intervals.length);
        for (const interval of corrected.intervals) {
            expect(interval.powerKw).toBeLessThanOrEqual(5.5 + 1e-9);
        }
    });

    it.runIf(shouldTestWasm)('evaluates Smart Shift jobs across forecast and flat projections', async () => {
        // 2026-06-15 16:00 PDT = 23:00 UTC (Peak starts at 16:00 local, Off-Peak starts at 21:00 local).
        const nowSec = Date.parse('2026-06-15T23:00:00Z') / 1000;
        const balanceSourceTimeSec = nowSec - 5 * 60;
        const billingCycleEndSec = nowSec + 5 * 86_400;

        // Build contiguous tariff segments covering 5 days (Peak 16..21 local = 23..04 UTC, Off-Peak otherwise).
        const tariffTimeline: SmartShiftLoadTimingDTO['tariffTimeline'] = [];
        const baseDayStart = Date.parse('2026-06-15T07:00:00Z') / 1000; // 00:00 PDT
        for (let day = 0; day < 7; day += 1) {
            const midnight = baseDayStart + day * 86_400;
            const peakStart = midnight + 16 * 3600;
            const peakEnd = midnight + 21 * 3600;
            tariffTimeline.push(
                { start: midnight, end: peakStart, periodKey: 'Off-Peak', name: 'Off-Peak', buyRate: 0.15, sellRate: 0.05 },
                { start: peakStart, end: peakEnd, periodKey: 'Peak', name: 'Peak', buyRate: 0.55, sellRate: 0.08 },
                { start: peakEnd, end: midnight + 86_400, periodKey: 'Off-Peak', name: 'Off-Peak', buyRate: 0.15, sellRate: 0.05 },
            );
        }

        const periods: SmartShiftLoadTimingDTO['periods'] = [
            {
                name: 'Peak', marginalCost: 0.55, basis: 'buy', cycleNetExportKwh: -10,
                isActive: true, buyRate: 0.55, sellRate: 0.08,
            },
            {
                name: 'Off-Peak', marginalCost: 0.15, basis: 'buy', cycleNetExportKwh: -20,
                isActive: false, buyRate: 0.15, sellRate: 0.05,
            },
        ];

        const timing: SmartShiftLoadTimingDTO = {
            hasTariff: true,
            hasCycleData: true,
            activeIsCheapest: false,
            periods,
            pricingPeriods: periods,
            tariffTimeline,
            nextCheaper: { name: 'Off-Peak', marginalCost: 0.15, phrase: 'at 9 PM' },
            nextCheaperPhrase: 'at 9 PM',
            nextStartPhraseByKey: { 'Off-Peak': 'at 9 PM' },
        };

        const slots: SmartShiftPlanningSlotDTO[] = [];
        for (let minute = 0; minute < 1440; minute += 30) {
            slots.push({
                localMinute: minute,
                homeKw: 1.0,
                batteryNetChargeKw: 0,
                gridNetExportKw: -0.5,
                cautiousGridNetExportKw: -0.8,
            });
        }

        const forecastIntervals = [];
        for (let hour = -1; hour < 72; hour += 1) {
            const pStart = nowSec + hour * 3600;
            const localHour = (new Date(pStart * 1000).getUTCHours() + 24 - 7) % 24;
            const sunKw = localHour >= 9 && localHour <= 15 ? 4.5 : 0;
            forecastIntervals.push({
                periodStart: pStart,
                periodEnd: pStart + 3600,
                powerKw: sunKw,
                cautiousPowerKw: sunKw * 0.7,
            });
        }

        const profiles: SmartShiftLoadProfileDTO[] = [
            { id: 'dishwasher', name: 'Dishwasher', kind: 'appliance', energyKwh: 2, durationHours: 2 },
            {
                id: 'ev', name: 'EV', kind: 'car', energyKwh: 0, durationHours: 0,
                carSettings: {
                    capacityKwh: 75, initialStateOfCharge: 50, targetStateOfCharge: 70, chargingLevel: 'level2',
                },
            },
        ];

        const forecastEval = await evaluateSmartShiftWasm({
            nowSec,
            timing,
            forecastAvailable: true,
            intervals: forecastIntervals,
            context: { timeZone: 'America/Los_Angeles', slots, asOf: nowSec },
            balanceSourceTimeSec,
            billingCycleEndSec,
            currencyCode: 'USD',
            timeZone: 'America/Los_Angeles',
            profiles,
        });

        expect(forecastEval).toHaveLength(2);
        for (const item of forecastEval) {
            expect(item.projection).toBe('forecast');
            expect(item.unavailableReason ?? null).toBeNull();
            expect(item.comparison).toBeDefined();
            expect(item.comparison!.savings).toBeGreaterThan(0);
            expect(item.comparison!.recommendedCost).toBeLessThan(item.comparison!.costNow);
            expect(item.comparison!.lanes.length).toBeGreaterThan(0);
        }

        const flatEval = await evaluateSmartShiftWasm({
            nowSec,
            timing,
            forecastAvailable: false,
            intervals: null,
            context: null,
            balanceSourceTimeSec,
            billingCycleEndSec,
            currencyCode: 'USD',
            timeZone: 'America/Los_Angeles',
            profiles: [profiles[0]],
        });
        expect(flatEval[0].projection).toBe('flat');
        expect(flatEval[0].comparison?.savings).toBeGreaterThan(0);
    });
});
