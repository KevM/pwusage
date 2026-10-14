import { sumTodayRows } from './energy-repo';
import type { EnergyData } from './db-types';
import { getSiteMidnight, formatSiteDate } from './date-utils';

interface TodayEnergyReader {
    getRawEnergyData(siteId: string, start: Date, end: Date): Promise<EnergyData[]>;
    getUsageByTOU(siteId: string, start: Date, end: Date): Promise<{ cost?: number; buyRate?: number; sellRate?: number }[]>;
}

export async function mobileTodayEnergy(repo: TodayEnergyReader, siteId: string, timezone: string, currency: string, now: Date) {
    const start = getSiteMidnight(now, timezone);
    const [rows, usage] = await Promise.all([
        repo.getRawEnergyData(siteId, start, now),
        repo.getUsageByTOU(siteId, start, now),
    ]);
    const totals = sumTodayRows(rows);
    const latest = rows.reduce<Date | null>((last, row) =>
        !last || row.timestamp > last ? row.timestamp : last, null);
    const priced = rows.length > 0 && usage.length > 0
        && usage.every(item => typeof item.cost === 'number' && Number.isFinite(item.cost)
            && typeof item.buyRate === 'number' && Number.isFinite(item.buyRate)
            && typeof item.sellRate === 'number' && Number.isFinite(item.sellRate));
    return {
        localDate: formatSiteDate(now, timezone),
        homeKwh: totals.homeKwh, importKwh: totals.importKwh, exportKwh: totals.exportKwh,
        estimatedCost: priced ? usage.reduce((sum, item) => sum + item.cost!, 0) : null,
        currency, energyDataThrough: latest?.toISOString() ?? null,
    };
}
