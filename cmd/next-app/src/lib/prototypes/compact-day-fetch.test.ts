import { describe, expect, it, vi } from 'vitest';
import type { SiteWithTariffs } from '../db';
import type { EnergyDataRow } from '../importer';
import { fetchDayForWrite } from './compact-day-fetch';

const site = { id: 'site', timezone: 'America/Chicago', tariffs: [] } as unknown as SiteWithTariffs;
const start = new Date('2026-11-01T05:00:00Z');
const end = new Date('2026-11-02T06:00:00Z');
const row = (timestamp: Date) => ({ site_id: 'site', timestamp, tariff_id: 1, tariff_schedule_id: 2,
    load_power: 1, solar_power: 0, grid_power: 1, battery_power: 0, battery_soc: 50 }) as EnergyDataRow;

describe('fetchDayForWrite', () => {
    it('fetches one whole past day with SOE required and keeps only its samples', async () => {
        const fetchRange = vi.fn().mockResolvedValue([row(new Date(+start - 300000)), row(start), row(new Date(+end - 300000)), row(end)]);
        const received = new Date('2026-11-05T00:00:00Z');
        const result = await fetchDayForWrite({ fetchRange }, site, start, new Date('2026-11-04T00:00:00Z'), () => received);
        // The fall-back day is 25 hours; end 1 s before midnight so Tesla stays inside it.
        expect(fetchRange).toHaveBeenCalledWith(site, start, new Date(+end - 1000), 'day', { requireSoe: true });
        expect(result).toEqual({ rows: [row(start), row(new Date(+end - 300000))], fetchedAt: received });
    });

    it('fetches today only up to now', async () => {
        const fetchRange = vi.fn().mockResolvedValue([]);
        const now = new Date(+start + 3 * 3600000);
        await fetchDayForWrite({ fetchRange }, site, start, now);
        expect(fetchRange).toHaveBeenCalledWith(site, start, now, 'day', { requireSoe: true });
    });

    it('stamps the fetch when it was requested, so a slower, older request can never win', async () => {
        const resolvers: Array<(rows: EnergyDataRow[]) => void> = [];
        const fetchRange = vi.fn().mockImplementation(() => new Promise<EnergyDataRow[]>(r => { resolvers.push(r); }));
        let clock = 1;
        const now = new Date('2026-11-04T00:00:00Z');
        const older = fetchDayForWrite({ fetchRange }, site, start, now, () => new Date(clock));
        clock = 2;
        const newer = fetchDayForWrite({ fetchRange }, site, start, now, () => new Date(clock));
        clock = 3;
        // The newer request completes first; the older one arrives last but keeps its earlier stamp.
        resolvers[1]([]); expect((await newer).fetchedAt).toEqual(new Date(2));
        clock = 4;
        resolvers[0]([]); expect((await older).fetchedAt).toEqual(new Date(1));
    });

    it('propagates an SOE failure so the stored day is left as it was', async () => {
        const fetchRange = vi.fn().mockRejectedValue(new Error('SOE unavailable'));
        await expect(fetchDayForWrite({ fetchRange }, site, start, new Date('2026-11-04T00:00:00Z'))).rejects.toThrow('SOE unavailable');
    });
});
