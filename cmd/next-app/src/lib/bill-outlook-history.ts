import { priceBillUsage } from './bill-pricing';

export interface BillOutlookBucket {
    tariffName: string;
    periodName: string;
    netGridKwh: number;
    buyRate: number;
    sellRate: number;
}
export interface BillOutlookDay {
    date: string;
    buckets: BillOutlookBucket[];
    complete: boolean;
}
export interface BillOutlookPoint extends BillOutlookDay {
    estimatedCost: number;
    periods: { tariffName: string; periodName: string; netGridKwh: number }[];
}
export interface BillOutlookHistory {
    points: BillOutlookPoint[];
    observedThrough: string;
    complete: boolean;
}

/** Preserve measured rate buckets; net each cumulative window independently. */
export function buildBillOutlookHistory(days: BillOutlookDay[]): BillOutlookPoint[] {
    const cumulative = new Map<string, BillOutlookBucket>();
    let complete = true;
    return days.map(day => {
        complete = complete && day.complete;
        for (const bucket of day.buckets) {
            const key = JSON.stringify([bucket.tariffName, bucket.periodName, bucket.buyRate, bucket.sellRate]);
            const previous = cumulative.get(key);
            cumulative.set(key, { ...bucket, netGridKwh: (previous?.netGridKwh ?? 0) + bucket.netGridKwh });
        }
        const buckets = [...cumulative.values()].map(bucket => ({ ...bucket }));
        const priced = buckets.map(bucket => ({ tariff: { name: bucket.tariffName }, touName: bucket.periodName,
            gridUsage: bucket.netGridKwh * 1000, buyRate: bucket.buyRate, sellRate: bucket.sellRate, cost: 0 }));
        priceBillUsage(priced);
        const periods = new Map<string, BillOutlookPoint['periods'][number]>();
        for (const bucket of buckets) {
            const key = JSON.stringify([bucket.tariffName, bucket.periodName]);
            const prior = periods.get(key);
            periods.set(key, { tariffName: bucket.tariffName, periodName: bucket.periodName,
                netGridKwh: (prior?.netGridKwh ?? 0) + bucket.netGridKwh });
        }
        return { date: day.date, complete, buckets, periods: [...periods.values()],
            estimatedCost: priced.reduce((sum, row) => sum + row.cost, 0) };
    });
}
