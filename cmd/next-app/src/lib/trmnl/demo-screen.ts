/**
 * A demo TRMNL screen for public pages (e.g. /help/trmnl): the real renderer fed with sample data,
 * so the preview always matches what the plugin draws today. Only the clock time, active period
 * and billing-cycle dates follow `now`; the numbers are fixed sample values.
 */
import { TrmnlRenderer } from '../trmnl-renderer';
import type { LoadTimingPeriod, LoadTimingView } from '../load-timing';
import type { RenderContext } from './types';

const DEMO_TIMEZONE = 'America/Los_Angeles';
const ON_PEAK_START_HOUR = 16;
const ON_PEAK_END_HOUR = 21;

function zonedParts(now: Date): { month: number; hour: number } {
    const parts = Object.fromEntries(
        new Intl.DateTimeFormat('en-US', {
            timeZone: DEMO_TIMEZONE, month: 'numeric', hour: 'numeric', hourCycle: 'h23'
        }).formatToParts(now).map((p) => [p.type, p.value])
    );
    return { month: Number(parts.month), hour: Number(parts.hour) };
}

function demoLoadTiming(onPeakActive: boolean, hour: number): LoadTimingView {
    const offPeak: LoadTimingPeriod = {
        name: 'OFF_PEAK', marginalCost: 0.12, buyRate: 0.12, sellRate: 0.04, basis: 'buy',
        cycleNetExportKwh: -260, isActive: !onPeakActive,
        nextStartPhrase: onPeakActive ? `today at ${ON_PEAK_END_HOUR - 12} PM` : null
    };
    const onPeak: LoadTimingPeriod = {
        name: 'ON_PEAK', marginalCost: 0.38, buyRate: 0.38, sellRate: 0.08, basis: 'buy',
        cycleNetExportKwh: -20, isActive: onPeakActive,
        nextStartPhrase: onPeakActive ? null : `${hour < ON_PEAK_START_HOUR ? 'today' : 'tomorrow'} at ${ON_PEAK_START_HOUR - 12} PM`
    };
    const periods = [offPeak, onPeak];
    const nextCheaper = onPeakActive
        ? { name: 'OFF_PEAK', marginalCost: 0.12, phrase: offPeak.nextStartPhrase ?? '' }
        : null;
    return {
        hasTariff: true,
        hasCycleData: true,
        activeIsCheapest: !onPeakActive,
        periods,
        pricingPeriods: periods,
        nextCheaper,
        nextCheaperPhrase: nextCheaper?.phrase ?? null,
        nextStartPhraseByKey: {}
    };
}

export function buildTrmnlDemoContext(now: Date): RenderContext {
    const { month, hour } = zonedParts(now);
    const onPeakActive = hour >= ON_PEAK_START_HOUR && hour < ON_PEAK_END_HOUR;
    const time = now.toLocaleTimeString('en-US', {
        timeZone: DEMO_TIMEZONE, hour: 'numeric', minute: '2-digit', hour12: true
    }).toLowerCase().replace(/\s+/g, '');
    const nextMonth = month === 12 ? 1 : month + 1;

    return {
        siteName: `Demo Home @ ${time}`,
        dateRange: `${month}/1 - ${nextMonth}/1`,
        // Energy in Wh; the renderer shows kWh. Off-peak carries most of the grid import.
        tariffGroups: [{
            tariffId: 1,
            tariffName: 'Demo ToU',
            periods: [
                { touName: 'OFF_PEAK', label: 'Off-Peak', home: 420_000, solar: 150_000, grid: 260_000, battery: 10_000, cost: 31.2 },
                { touName: 'ON_PEAK', label: 'On-Peak', home: 180_000, solar: 140_000, grid: 20_000, battery: 20_000, cost: 7.6 }
            ]
        }],
        totalCost: 38.8,
        currency: '$',
        displayCost: '$38.80',
        costLabel: 'Total Cost',
        currentTouName: onPeakActive ? 'ON_PEAK' : 'OFF_PEAK',
        batterySoc: 82,
        batteryStatus: onPeakActive ? 'discharging' : 'charging',
        todayHome: 1.8,
        todayGrid: 0.3,
        todaySolar: 3.7,
        componentConfig: {
            showLiveGrid: true,
            showLiveSolar: true,
            showLiveBattery: true,
            showEnergyChart: false,
            showBatterySoc: false,
            showEstimatedBill: true,
            showLoadTiming: true,
            batterySocMode: 'glyph'
        },
        loadTiming: demoLoadTiming(onPeakActive, hour),
        timezone: DEMO_TIMEZONE
    };
}

export function renderTrmnlDemoMarkup(now: Date): string {
    return TrmnlRenderer.renderFull(buildTrmnlDemoContext(now));
}
