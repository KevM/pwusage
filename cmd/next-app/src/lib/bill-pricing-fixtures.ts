import { getCurrentCycleStart, getNextCycleStart } from './billing-cycle';
import type { BillOutlookHistory } from './bill-outlook-history';
import type { EnergyData, Tariff, TariffSchedule, TariffSeason, TariffSource } from './db-types';
import { buildBillOutlook, EnergyRepo, type UsageData } from './energy-repo';
import { buildMobileLoadTiming, summarizeBillUsage, type MobileLoadTimingWithTimeline } from './mobile-bill-summary';
import type { MobileBillPeriod } from './mobile-dashboard-contract';
import { priceBillUsage } from './bill-pricing';
import { Schedule } from './schedule';
import type { SiteTariffsTimelineResponse, TariffSeasonInput } from './tariff-contract';
import { compileSeasonsToParsedTariff, siteLocalDateString } from './tariff-timeline';
import {
    buildSiteTariffsTimelineResponse,
    pickActivePeriodForDate,
    type PeriodQueryRow,
} from './tariff-timeline-repo';

const MONTH_MAX_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const FIVE_MIN_MS = 5 * 60 * 1000;

export interface BillPricingFixtureTariffDef {
    periodId: number;
    tariffId: number;
    name: string;
    version?: number;
    source: TariffSource;
    effectiveFrom: string;
    effectiveTo: string | null;
    seasons: TariffSeasonInput[];
}

export interface BillPricingFixtureDayDef {
    /** Site-local YYYY-MM-DD. */
    day: string;
    /**
     * Produces `(solarWh, loadWh, gridWh)` for slot `slotIndex` (0-based from
     * site-local midnight). Returning `null` omits the sample (gap).
     */
    slotValue: (slotIndex: number, dayIndex: number) => { solarWh: number; loadWh: number; gridWh: number } | null;
}

export interface BillPricingFixtureCaseDef {
    name: string;
    siteId?: string;
    timezone?: string;
    currency?: string;
    billingDay?: number;
    now: string;
    tariffs: BillPricingFixtureTariffDef[];
    days: BillPricingFixtureDayDef[];
}

export interface BillPricingFixtureDay {
    day: string;
    dayStart: string;
    solarWh: (number | null)[];
    loadWh: (number | null)[];
    gridWh: (number | null)[];
}

export interface BillPricingFixture {
    name: string;
    now: string;
    billingDay: number;
    timeline: SiteTariffsTimelineResponse;
    days: BillPricingFixtureDay[];
    expected: {
        currentBill: {
            estimatedCost: number | null;
            cycleStart: string;
            cycleEnd: string;
            periods: MobileBillPeriod[];
        };
        outlook: BillOutlookHistory | null;
        loadTiming: MobileLoadTimingWithTimeline | null;
    };
}

function buildTariffRow(
    siteId: string,
    def: BillPricingFixtureTariffDef,
    nextIds: { seasonId: number; scheduleId: number }
): Tariff {
    const parsed = compileSeasonsToParsedTariff(def.name, def.seasons);
    const seasons: TariffSeason[] = parsed.seasons.map((season, seasonIdx) => {
        const seasonId = nextIds.seasonId++;
        const inputSeason = def.seasons[seasonIdx];
        const schedules: TariffSchedule[] = season.schedules.map(sch => ({
            id: nextIds.scheduleId++,
            season_id: seasonId,
            name: sch.name,
            buy_rate: sch.buy_rate,
            sell_rate: sch.sell_rate,
            from_day_of_week: sch.from_day_of_week,
            to_day_of_week: sch.to_day_of_week,
            from_hour: sch.from_hour,
            to_hour: sch.to_hour,
            from_minute: sch.from_minute,
            to_minute: sch.to_minute,
        }));
        return {
            id: seasonId,
            tariff_id: def.tariffId,
            name: season.name,
            from_month: season.from_month,
            from_day: inputSeason.fromDay ?? season.from_day,
            to_month: season.to_month,
            to_day: inputSeason.toDay ?? season.to_day ?? MONTH_MAX_DAYS[season.to_month - 1],
            buy_rate: season.buy_rate,
            sell_rate: season.sell_rate,
            schedules,
        };
    });

    return {
        id: def.tariffId,
        site_id: siteId,
        name: def.name,
        version: def.version ?? 1,
        is_current: true,
        source: def.source,
        updated: new Date('2026-01-01T00:00:00.000Z'),
        seasons,
    };
}

function mergeUsageBuckets(perDayUsage: UsageData[][]): UsageData[] {
    const merged = new Map<string, UsageData>();
    for (const dayRows of perDayUsage) {
        for (const item of dayRows) {
            const tariffName = item.tariff?.name || 'Unknown';
            const touName = item.touName || 'Unknown';
            const buyRate = item.buyRate ?? 0;
            const sellRate = item.sellRate ?? 0;
            const key = JSON.stringify([tariffName, touName, buyRate, sellRate]);
            let acc = merged.get(key);
            if (!acc) {
                acc = {
                    start: item.start,
                    homeUsage: 0,
                    gridUsage: 0,
                    solarProduction: 0,
                    batteryChange: 0,
                    tariff: item.tariff,
                    touName,
                    cost: 0,
                    buyRate,
                    sellRate,
                };
                merged.set(key, acc);
            }
            acc.homeUsage += item.homeUsage;
            acc.gridUsage += item.gridUsage;
            acc.solarProduction += item.solarProduction;
            acc.batteryChange += item.batteryChange;
        }
    }
    const result = Array.from(merged.values());
    priceBillUsage(result);
    return result;
}

/**
 * Pure fixture builder running the real server pricing, outlook, and load
 * timing engines on in-memory inputs.
 */
export function buildBillPricingFixture(def: BillPricingFixtureCaseDef): BillPricingFixture {
    const siteId = def.siteId ?? 'site-fixture';
    const timezone = def.timezone ?? 'America/Denver';
    const currency = def.currency ?? 'USD';
    const billingDay = def.billingDay ?? 1;
    const now = new Date(def.now);
    const today = siteLocalDateString(now, timezone);

    const nextIds = { seasonId: 1, scheduleId: 1 };
    const tariffMap = new Map<number, Tariff>();
    const scheduleMap = new Map<number, TariffSchedule>();
    const periodRows: PeriodQueryRow[] = [];

    for (const tDef of def.tariffs) {
        const tariff = buildTariffRow(siteId, tDef, nextIds);
        tariffMap.set(tariff.id, tariff);
        for (const season of tariff.seasons ?? []) {
            for (const sch of season.schedules ?? []) {
                scheduleMap.set(sch.id, sch);
            }
        }
        periodRows.push({
            period_id: tDef.periodId,
            tariff_id: tDef.tariffId,
            effective_from: tDef.effectiveFrom,
            effective_to: tDef.effectiveTo,
            source: tDef.source,
            updated_by_user_id: null,
            updated_by_email: null,
            name: tDef.name,
            version: tDef.version ?? 1,
            content_hash: null,
        });
    }

    // Order periods DESC by effectiveFrom, periodId just like TariffTimelineRepo.getTimeline.
    periodRows.sort((a, b) => b.effective_from.localeCompare(a.effective_from) || b.period_id - a.period_id);

    const timeline = buildSiteTariffsTimelineResponse({
        siteId,
        timezone,
        currency,
        today,
        viewerUserId: null,
        periodRows,
        tariffMap,
    });

    const cycleStart = getCurrentCycleStart(billingDay, now, timezone);
    const cycleEnd = getNextCycleStart(billingDay, cycleStart, timezone);

    const scheduleCache = new Map<string, Schedule>();
    const scheduleForLocalDate = (localDate: string): Schedule => {
        const cached = scheduleCache.get(localDate);
        if (cached) return cached;
        const period = pickActivePeriodForDate(timeline.periods, localDate);
        const tariff = period ? tariffMap.get(period.tariffId) : undefined;
        const sched = new Schedule(tariff ? [tariff] : [], timezone);
        scheduleCache.set(localDate, sched);
        return sched;
    };

    const days: BillPricingFixtureDay[] = [];
    const allRaw: EnergyData[] = [];
    const perDayUsage: UsageData[][] = [];

    def.days.forEach((dayDef, dayIndex) => {
        // Parse YYYY-MM-DD at noon UTC then snap to site-local midnight.
        const [y, m, d] = dayDef.day.split('-').map(Number);
        const dayStart = EnergyRepo.getSiteMidnight(new Date(Date.UTC(y, m - 1, d, 12, 0, 0)), timezone);
        const nextMidnight = EnergyRepo.getSiteMidnight(new Date(+dayStart + 36 * 3600_000), timezone);
        const dayCutoffMs = Math.min(+nextMidnight, +now, +cycleEnd);
        const slotCount = Math.max(0, Math.round((dayCutoffMs - +dayStart) / FIVE_MIN_MS));

        const solarWh: (number | null)[] = [];
        const loadWh: (number | null)[] = [];
        const gridWh: (number | null)[] = [];
        const dayRaw: EnergyData[] = [];

        for (let i = 0; i < slotCount; i++) {
            const val = dayDef.slotValue(i, dayIndex);
            if (val === null) {
                solarWh.push(null);
                loadWh.push(null);
                gridWh.push(null);
                continue;
            }
            solarWh.push(val.solarWh);
            loadWh.push(val.loadWh);
            gridWh.push(val.gridWh);
            const ts = new Date(+dayStart + i * FIVE_MIN_MS);
            dayRaw.push({
                timestamp: ts,
                site_id: siteId,
                tariff_id: 0,
                tariff_schedule_id: null,
                solar_power: val.solarWh,
                load_power: val.loadWh,
                grid_power: val.gridWh,
                battery_power: 0,
                battery_soc: null,
            });
        }

        days.push({
            day: dayDef.day,
            dayStart: dayStart.toISOString(),
            solarWh,
            loadWh,
            gridWh,
        });
        allRaw.push(...dayRaw);

        const daySchedule = scheduleForLocalDate(dayDef.day);
        perDayUsage.push(EnergyRepo.aggregateUsageByTOU({
            siteId,
            start: cycleStart,
            priorAggregates: [],
            todayRaw: dayRaw,
            schedule: daySchedule,
            tariffMap,
            scheduleMap,
        }));
    });

    const usage = mergeUsageBuckets(perDayUsage);
    const { estimatedCost, periods } = summarizeBillUsage(usage);

    const activeSchedule = scheduleForLocalDate(today);
    const lastTimestampMs = allRaw.length > 0 ? Math.max(...allRaw.map(r => +r.timestamp)) : -Infinity;
    const outlook = buildBillOutlook({
        siteId,
        start: cycleStart,
        end: cycleEnd,
        timezone,
        schedule: activeSchedule,
        tariffMap,
        scheduleMap,
        priorAggregates: [],
        todayRaw: allRaw,
        coverage: [],
        split: cycleStart,
        lastTimestampMs,
        scheduleForDay: (day) => scheduleForLocalDate(siteLocalDateString(day, timezone)),
    });

    const energyDataThrough = Number.isFinite(lastTimestampMs) ? new Date(lastTimestampMs) : null;
    const loadTiming = buildMobileLoadTiming({
        schedule: activeSchedule,
        usage,
        now,
        timezone,
        cycleEnd,
        energyDataThrough,
        hasTariffs: timeline.periods.length > 0,
    });

    return {
        name: def.name,
        now: now.toISOString(),
        billingDay,
        timeline,
        days,
        expected: {
            currentBill: {
                estimatedCost,
                cycleStart: cycleStart.toISOString(),
                cycleEnd: cycleEnd.toISOString(),
                periods,
            },
            outlook,
            loadTiming,
        },
    };
}
