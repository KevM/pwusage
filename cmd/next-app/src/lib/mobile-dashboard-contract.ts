import type { EnergySiteLiveStatus } from './tesla-client';
import { sumTodayRows, type TodayTotals } from './energy-repo';
import type { EnergyData } from './db-types';
import type { MobileActiveLoadTiming } from './mobile-load-timing';
import type { LoadTimingView } from './load-timing';

export const MOBILE_DASHBOARD_CONTRACT_VERSION = 1;
export const MOBILE_SOC_STALE_AFTER_MS = 20 * 60 * 1000;
export const MOBILE_SOC_MAX_AGE_MS = 2 * 60 * 60 * 1000;

export interface MobileDashboardContractInput {
    site: { id: string; name: string; timezone: string };
    live: Pick<EnergySiteLiveStatus, 'solar_power' | 'load_power' | 'battery_power' | 'grid_power' | 'timestamp'> & { percentage_charged: number | null };
    fallbackSoc?: { value: number; timestamp: Date } | null;
    energyTimestamp: Date | null;
    now: Date;
    activeTariff: string;
    activeLoadTiming?: MobileActiveLoadTiming | null;
    today: MobileTodayTotals;
    todayComplete: boolean;
    bill: {
        estimatedCost: number | null;
        currency: string;
        cycleStart: Date;
        cycleEnd: Date;
        periods?: MobileBillPeriod[];
    } | null;
    todayDate: string;
}

export interface MobileCurrentBill {
    estimatedCost: number | null;
    currency: string;
    cycleStart: string;
    cycleEnd: string;
    periods: MobileBillPeriod[];
}

export interface MobileBillPeriod {
    tariffName: string;
    periodName: string;
    netGridKwh: number;
    cost: number;
}

export interface MobileBillSummary {
    version: number;
    site: { id: string; name: string; timezone: string };
    currentBill: MobileCurrentBill;
    loadTiming?: LoadTimingView | null;
    sources: { calculatedAt: string; energyDataThrough: string | null };
}

export type MobileTodayTotals = Pick<TodayTotals,
    'homeKwh' | 'solarKwh' | 'gridNetKwh' | 'batteryNetKwh'>;

export interface MobileDashboardWithBillSummary extends MobileDashboardContract {
    billSources: MobileBillSummary['sources'];
    loadTiming?: LoadTimingView | null;
}

export function withMobileBillSummary(
    dashboard: MobileDashboardContract,
    summary: MobileBillSummary
): MobileDashboardWithBillSummary {
    if (dashboard.site.id !== summary.site.id) {
        throw new Error('Mobile dashboard and bill summary belong to different sites.');
    }
    return {
        ...dashboard,
        currentBill: summary.currentBill,
        billSources: summary.sources,
        ...(summary.loadTiming !== undefined ? { loadTiming: summary.loadTiming } : {}),
    };
}

export interface MobileDashboardContract {
    version: number;
    site: { id: string; name: string; timezone: string; localDate: string };
    live: { solarPower: number; loadPower: number; batteryPower: number; gridPower: number };
    stateOfCharge: number | null;
    activeTariff: string | null;
    activeLoadTiming?: MobileActiveLoadTiming | null;
    today: MobileTodayTotals;
    todayComplete: boolean;
    currentBill: MobileCurrentBill | null;
    sources: { liveStatusAt: string | null; energyDataThrough: string | null; stateOfChargeAt: string | null };
}

export function buildMobileDashboardContract(input: MobileDashboardContractInput): MobileDashboardContract {
    const sourceTimestamp = new Date(input.live.timestamp);
    const liveStatusAgeMs = Number.isFinite(sourceTimestamp.getTime())
        ? input.now.getTime() - sourceTimestamp.getTime()
        : Number.POSITIVE_INFINITY;
    const liveSocValid = typeof input.live.percentage_charged === 'number'
        && Number.isFinite(input.live.percentage_charged)
        && input.live.percentage_charged >= 0 && input.live.percentage_charged <= 100;
    const fallbackAgeMs = input.fallbackSoc
        ? input.now.getTime() - input.fallbackSoc.timestamp.getTime()
        : Number.POSITIVE_INFINITY;
    const fallbackSocValid = input.fallbackSoc
        && Number.isFinite(input.fallbackSoc.value)
        && input.fallbackSoc.value >= 0 && input.fallbackSoc.value <= 100
        && fallbackAgeMs >= 0 && fallbackAgeMs <= MOBILE_SOC_MAX_AGE_MS;
    const useLiveSoc = liveSocValid && liveStatusAgeMs >= 0 && liveStatusAgeMs <= MOBILE_SOC_MAX_AGE_MS;
    const stateOfCharge = useLiveSoc ? input.live.percentage_charged
        : fallbackSocValid ? input.fallbackSoc!.value : null;
    const stateOfChargeAt = useLiveSoc ? sourceTimestamp.toISOString()
        : fallbackSocValid ? input.fallbackSoc!.timestamp.toISOString() : null;

    return {
        version: MOBILE_DASHBOARD_CONTRACT_VERSION,
        site: { id: input.site.id, name: input.site.name, timezone: input.site.timezone, localDate: input.todayDate },
        live: {
            solarPower: input.live.solar_power,
            loadPower: input.live.load_power,
            batteryPower: input.live.battery_power,
            gridPower: input.live.grid_power,
        },
        stateOfCharge,
        activeTariff: input.activeTariff || null,
        ...(input.activeLoadTiming !== undefined ? { activeLoadTiming: input.activeLoadTiming } : {}),
        today: input.today,
        todayComplete: input.todayComplete,
        currentBill: input.bill ? {
            estimatedCost: input.bill.estimatedCost,
            currency: input.bill.currency,
            cycleStart: input.bill.cycleStart.toISOString(),
            cycleEnd: input.bill.cycleEnd.toISOString(),
            periods: input.bill.periods ?? [],
        } : null,
        sources: {
            liveStatusAt: Number.isFinite(sourceTimestamp.getTime()) ? sourceTimestamp.toISOString() : null,
            energyDataThrough: input.energyTimestamp?.toISOString() ?? null,
            stateOfChargeAt,
        },
    };
}

/** Latest underlying five-minute sample represented by the returned buckets. */
export function maxBucketSampleTimestamp(rows: EnergyData[]): Date | null {
    let latest: Date | null = null;
    for (const row of rows) {
        const sampleTimestamp = row.sample_timestamp;
        if (sampleTimestamp && Number.isFinite(sampleTimestamp.getTime())
            && (!latest || sampleTimestamp.getTime() > latest.getTime())) {
            latest = sampleTimestamp;
        }
    }
    return latest;
}

/** Reconstruct the interval energy from the 15-minute averages already in the live query. */
export function sumBucketedTodayRows(rows: EnergyData[], todayStart: Date): MobileTodayTotals {
    const energyRows = rows
        .filter((row) => row.timestamp >= todayStart)
        .map((row) => {
            const sampleCount = typeof row.sample_count === 'number' && row.sample_count > 0
                ? row.sample_count
                : 1;
            return {
                ...row,
                load_power: row.load_power * sampleCount,
                solar_power: row.solar_power * sampleCount,
                grid_power: row.grid_power * sampleCount,
                battery_power: row.battery_power * sampleCount,
            };
        });
    const totals = sumTodayRows(energyRows);
    return {
        homeKwh: totals.homeKwh,
        solarKwh: totals.solarKwh,
        gridNetKwh: totals.gridNetKwh,
        batteryNetKwh: totals.batteryNetKwh,
    };
}
