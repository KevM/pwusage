import { describe, it, expect } from 'vitest';
import { aggregateHourly } from './hourly-profile';
import type { EnergyData } from '../db';

function row(over: Partial<EnergyData>): EnergyData {
    return {
        id: 1, timestamp: new Date('2026-01-07T11:00:00Z'), site_id: 's1', tariff_id: 1,
        load_power: 0, solar_power: 0, grid_power: 0, battery_power: 0,
        battery_soc: 50, tariff_schedule_id: 10,
        battery_charge_from_solar: null, battery_charge_from_grid: null,
        ...over,
    } as EnergyData;
}

describe('aggregateHourly', () => {
    it('buckets samples by local date and hour and sums flows', () => {
        // Two samples in the same LA hour (03:00 & 03:30 local = 11:00 & 11:30 UTC), one in the next hour.
        const rows = [
            row({ timestamp: new Date('2026-01-07T11:00:00Z'), load_power: 3000, solar_power: 1000 }),
            row({ timestamp: new Date('2026-01-07T11:30:00Z'), load_power: 1000, solar_power: 3000 }),
            row({ timestamp: new Date('2026-01-07T12:00:00Z'), load_power: 2000, solar_power: 0 }),
        ];
        const buckets = aggregateHourly(rows, 'America/Los_Angeles');
        const h3 = buckets.find(b => b.hour === 3)!;
        const h4 = buckets.find(b => b.hour === 4)!;
        expect(h3.localDate).toBe('2026-01-07');
        // hour 3 (LA): two samples — first imports 2000, second exports 2000
        expect(h3.solarOnlyImportWh).toBeCloseTo(2000, 6);
        expect(h3.solarOnlyExportWh).toBeCloseTo(2000, 6);
        expect(h4.solarOnlyImportWh).toBeCloseTo(2000, 6);
    });

    it('returns an empty array for no rows', () => {
        expect(aggregateHourly([], 'UTC')).toEqual([]);
    });
});
