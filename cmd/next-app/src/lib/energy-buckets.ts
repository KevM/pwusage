import type { EnergyData } from './db-types';

export const energyMeasurements = ['load_power', 'solar_power', 'grid_power', 'battery_power'] as const;

/** Bucket an ordered snapshot while retaining the time of each bucket's latest sample. */
export function bucketEnergyRows(rows: EnergyData[]): EnergyData[] {
    const buckets = new Map<string, EnergyData>();
    for (const row of rows) {
        const timestamp = Math.floor(+row.timestamp / 900000) * 900000;
        const key = JSON.stringify([timestamp, row.tariff_id, row.tariff_schedule_id]);
        let bucket = buckets.get(key);
        if (!bucket) {
            bucket = { timestamp: new Date(timestamp), sample_timestamp: row.timestamp, site_id: row.site_id,
                tariff_id: row.tariff_id, tariff_schedule_id: row.tariff_schedule_id, sample_count: 0,
                load_power: 0, solar_power: 0, grid_power: 0, battery_power: 0, battery_soc: null };
            buckets.set(key, bucket);
        }
        bucket.sample_count = (bucket.sample_count ?? 0) + 1;
        bucket.sample_timestamp = row.timestamp;
        for (const field of energyMeasurements) bucket[field] += row[field];
    }
    return [...buckets.values()].sort((a, b) => +a.timestamp - +b.timestamp).map((bucket, index) => {
        for (const field of energyMeasurements) bucket[field] /= bucket.sample_count ?? 1;
        return { ...bucket, id: index + 1 };
    });
}
