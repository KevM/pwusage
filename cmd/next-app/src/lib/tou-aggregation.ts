import { SiteWithTariffs, EnergyData, Tariff, TariffSchedule } from './db';
import { CycleAggregateRow } from './energy-repo';
import { Schedule } from './schedule';
import { priceBillUsage } from './bill-pricing';

export interface TouAggregationResult {
    tariffGroups: {
        tariffId: number;
        tariffName: string;
        periods: {
            touName: string;
            label: string;
            home: number;
            grid: number;
            solar: number;
            battery: number;
            cost: number;
        }[];
    }[];
    totalBillCost: number;
    seriesData: EnergyData[];
    latestSeriesSoc: { value: number; timestamp: Date } | null;
}

function getTouLabel(name: string): string {
    return (name || 'Standard')
        .replace(/_/g, ' ')
        .toLowerCase()
        .replace(/\b\w/g, c => c.toUpperCase())
        .replace(/ /g, '-');
}


export function aggregateUsage(
    site: SiteWithTariffs,
    priorAggregates: CycleAggregateRow[],
    todayRaw: EnergyData[],
    schedule: Schedule,
    // Tariff/schedule rows from ALL versions (including is_current = false).
    // EnergyData rows keep the ids they were imported under, so without these
    // a mid-cycle tariff version bump makes pre-change days resolve to
    // 'Unknown' at $0. Mirrors EnergyRepo.getUsageByTOU.
    historicalTariffs: Tariff[] = [],
    historicalSchedules: TariffSchedule[] = []
): TouAggregationResult {
    // A site with no tariffs (e.g. tariff parse failed at onboarding) cannot
    // be priced, but its raw series must still reach the charts.
    if (site.tariffs.length === 0) {
        const seriesData: EnergyData[] = [];
        let latestSeriesSoc: { value: number; timestamp: Date } | null = null;
        for (const row of todayRaw) {
            seriesData.push(row);
            if (typeof row.battery_soc === 'number') {
                latestSeriesSoc = { value: row.battery_soc, timestamp: row.timestamp };
            }
        }
        return { tariffGroups: [], totalBillCost: 0, seriesData, latestSeriesSoc };
    }

    const tariffMap = new Map<number, Tariff>();
    const scheduleMap = new Map<number, TariffSchedule>();

    // Seed historical versions first so current versions win on id collisions.
    historicalTariffs.forEach(t => tariffMap.set(t.id, t));
    historicalSchedules.forEach(s => scheduleMap.set(s.id, s));

    site.tariffs.forEach(t => {
        tariffMap.set(t.id, t);
        if (t.seasons) {
            t.seasons.forEach(season => {
                if (season.schedules) {
                    season.schedules.forEach(s => scheduleMap.set(s.id, s));
                }
            });
        }
    });

    const aggregation = new Map<string, {
        tariff: Tariff;
        tariffName: string;
        touName: string;
        label: string;
        homeUsage: number;
        gridUsage: number;
        solarProduction: number;
        batteryChange: number;
        cost: number;
        buyRate: number;
        sellRate: number;
    }>();

    const scheduleKeyCache = new WeakMap<object, string>();
    const fallbackKeyCache = new Map<number, string>();

    const seriesData: EnergyData[] = [];
    let latestSeriesSoc: { value: number; timestamp: Date } | null = null;

    // Pass 1: Prior day aggregates
    for (const row of priorAggregates) {
        let touName = 'Unknown';
        let tariffName = 'Unknown';
        let buyRate = 0;
        let sellRate = 0;
        let currentTariff = site.tariffs[0];

        if (row.tariff_schedule_id != null) {
            // Look up the schedule by its ID
            const sched = scheduleMap.get(row.tariff_schedule_id);
            if (sched) {
                touName = sched.name || 'Standard';
                const season = tariffMap.get(row.tariff_id)?.seasons?.find(s => s.id === sched.season_id);
                buyRate = sched.buy_rate ?? season?.buy_rate ?? 0;
                sellRate = sched.sell_rate ?? season?.sell_rate ?? 0;
            }
        } else {
            // Fallback: tariff_schedule_id is null.
            // Recalculate using the midpoint of the aggregated day.
            const midpoint = new Date(row.day.getTime() + 12 * 60 * 60 * 1000);
            const tp = schedule.getTariffPeriod(midpoint);
            if (tp) {
                touName = tp.schedule.name || 'Standard';
                buyRate = tp.schedule.buy_rate ?? tp.season.buy_rate ?? 0;
                sellRate = tp.schedule.sell_rate ?? tp.season.sell_rate ?? 0;
            }
        }
        const t = tariffMap.get(row.tariff_id);
        if (t) {
            tariffName = t.name || 'Unknown';
            currentTariff = t;
        }

        const key = `${currentTariff.id}|${touName}|${buyRate}|${sellRate}`;
        let data = aggregation.get(key);
        if (!data) {
            data = {
                tariff: currentTariff,
                tariffName: tariffName,
                touName: touName,
                label: getTouLabel(touName),
                homeUsage: 0,
                gridUsage: 0,
                solarProduction: 0,
                batteryChange: 0,
                cost: 0,
                buyRate,
                sellRate
            };
            aggregation.set(key, data);
        }

        data.homeUsage += row.load_power;
        data.gridUsage += row.grid_power;
        data.solarProduction += row.solar_power;
        data.batteryChange += row.battery_power;
    }

    // Pass 2: Today's raw rows
    for (const row of todayRaw) {
        const ts = row.timestamp;
        const tp = schedule.getTariffPeriod(ts);

        seriesData.push(row);
        if (typeof row.battery_soc === 'number') {
            latestSeriesSoc = { value: row.battery_soc, timestamp: ts };
        }

        let touName = 'Unknown';
        let tariffName = 'Unknown';
        let buyRate = 0;
        let sellRate = 0;
        let currentTariff = site.tariffs[0];
        let key = '';

        if (tp) {
            touName = tp.schedule.name || 'Standard';
            tariffName = tp.tariff.name || 'Unknown';
            buyRate = tp.schedule.buy_rate ?? tp.season.buy_rate ?? 0;
            sellRate = tp.schedule.sell_rate ?? tp.season.sell_rate ?? 0;
            currentTariff = tp.tariff;
            const scheduleObj = tp.schedule as unknown as object;
            const cachedKey = scheduleKeyCache.get(scheduleObj);
            if (cachedKey) {
                key = cachedKey;
            } else {
                key = `${currentTariff.id}|${touName}|${buyRate}|${sellRate}`;
                scheduleKeyCache.set(scheduleObj, key);
            }
        } else {
            const t = tariffMap.get(row.tariff_id);
            if (t) {
                tariffName = t.name || 'Unknown';
                currentTariff = t;
            }
            const cachedFallbackKey = fallbackKeyCache.get(currentTariff.id);
            if (cachedFallbackKey) {
                key = cachedFallbackKey;
            } else {
                key = `${currentTariff.id}|${touName}|${buyRate}|${sellRate}`;
                fallbackKeyCache.set(currentTariff.id, key);
            }
        }

        let data = aggregation.get(key);
        if (!data) {
            data = {
                tariff: currentTariff,
                tariffName: tariffName,
                touName: touName,
                label: getTouLabel(touName),
                homeUsage: 0,
                gridUsage: 0,
                solarProduction: 0,
                batteryChange: 0,
                cost: 0,
                buyRate,
                sellRate
            };
            aggregation.set(key, data);
        }

        data.homeUsage += row.load_power;
        data.gridUsage += row.grid_power;
        data.solarProduction += row.solar_power;
        data.batteryChange += row.battery_power;
    }

    // Share cycle-wide netting with web/mobile while retaining rate buckets.
    priceBillUsage(Array.from(aggregation.values()));

    // Group periods by tariff
    const tariffGroupsMap = new Map<string, {
        tariffId: number;
        tariffName: string;
        periods: {
            touName: string;
            label: string;
            home: number;
            grid: number;
            solar: number;
            battery: number;
            cost: number;
        }[];
    }>();

    for (const data of aggregation.values()) {
        let group = tariffGroupsMap.get(data.tariffName);
        if (!group) {
            group = { tariffId: data.tariff.id, tariffName: data.tariffName, periods: [] };
            tariffGroupsMap.set(data.tariffName, group);
        }

        let period = group.periods.find(p => p.touName === data.touName);
        if (!period) {
            period = {
                touName: data.touName,
                label: data.label,
                home: 0,
                grid: 0,
                solar: 0,
                battery: 0,
                cost: 0
            };
            group.periods.push(period);
        }

        period.home += data.homeUsage;
        period.grid += data.gridUsage;
        period.solar += data.solarProduction;
        period.battery += data.batteryChange;
        period.cost += data.cost;
    }

    // Calculate total cost for the summary
    let totalBillCost = 0;
    for (const data of aggregation.values()) {
        totalBillCost += data.cost;
    }

    return {
        tariffGroups: Array.from(tariffGroupsMap.values()),
        totalBillCost,
        seriesData,
        latestSeriesSoc
    };
}
