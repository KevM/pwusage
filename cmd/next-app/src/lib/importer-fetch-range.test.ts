import { describe, expect, it, vi } from 'vitest';

// Real date-utils (no UTC stub) so site-local days and DST behave as in production.
vi.mock('./db', () => ({ pool: { query: vi.fn(), connect: vi.fn() } }));

import { Importer } from './importer';
import type { EnergyHistoryEntry, TeslaClient } from './tesla-client';
import type { SiteWithTariffs } from './db';

function entry(timestamp: string): EnergyHistoryEntry {
    return {
        timestamp,
        solar_energy_exported: 0, generator_energy_exported: 0,
        grid_energy_imported: 10, grid_services_energy_imported: 0, grid_services_energy_exported: 0,
        grid_energy_exported_from_solar: 0, grid_energy_exported_from_generator: 0,
        grid_energy_exported_from_battery: 0, battery_energy_exported: 0,
        battery_energy_imported_from_grid: 0, battery_energy_imported_from_solar: 0,
        battery_energy_imported_from_generator: 0, consumer_energy_imported_from_grid: 10,
        consumer_energy_imported_from_solar: 0, consumer_energy_imported_from_battery: 0,
        consumer_energy_imported_from_generator: 0, total_home_usage: 10,
        total_solar_generation: 0, total_battery_charge: 0, total_battery_discharge: 0,
        total_grid_energy_exported: 0,
    };
}

describe('Importer.fetchRange', () => {
    const site = {
        id: 'site-1',
        timezone: 'America/Chicago',
        installed: new Date('2025-01-01T00:00:00Z'),
        tariffs: [{ id: 1, site_id: 'site-1', updated: new Date('2025-01-01T00:00:00Z'), name: 'Default', seasons: [] }],
    } as unknown as SiteWithTariffs;

    it('fetches the 25-hour DST fall-back day once, without duplicate rows', async () => {
        // 2026-11-01 in Chicago runs 05:00Z (CDT midnight) to 06:00Z next day (CST midnight).
        // Tesla returns the whole calendar day for any request inside it.
        const wholeDay = ['2026-11-01T05:00:00Z', '2026-11-01T17:00:00Z', '2026-11-02T05:55:00Z'].map(entry);
        const client = {
            getEnergyHistory: vi.fn().mockResolvedValue(wholeDay),
            getSoeHistory: vi.fn().mockResolvedValue([]),
        } as unknown as TeslaClient;

        const rows = await new Importer(client).fetchRange(
            site, new Date('2026-11-01T05:00:00Z'), new Date('2026-11-02T05:59:59Z'), 'day');

        expect(client.getEnergyHistory).toHaveBeenCalledTimes(1);
        const timestamps = rows.map(r => r.timestamp.toISOString());
        expect(new Set(timestamps).size).toBe(timestamps.length);
        expect(timestamps).toHaveLength(3);
    });

    it('still makes one request per site-local day across a multi-day range', async () => {
        const client = {
            getEnergyHistory: vi.fn().mockResolvedValue([]),
            getSoeHistory: vi.fn().mockResolvedValue([]),
        } as unknown as TeslaClient;

        await new Importer(client).fetchRange(
            site, new Date('2026-10-31T05:00:00Z'), new Date('2026-11-02T12:00:00Z'), 'day');

        const starts = vi.mocked(client.getEnergyHistory).mock.calls.map(c => c[1].toISOString());
        expect(starts).toEqual([
            '2026-10-31T05:00:00.000Z',
            '2026-11-01T05:00:00.000Z',
            '2026-11-02T06:00:00.000Z',
        ]);
    });

    it('tolerates an SOE failure by default, returning rows without SOC', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const client = {
            getEnergyHistory: vi.fn().mockResolvedValue([entry('2026-10-01T05:00:00Z')]),
            getSoeHistory: vi.fn().mockRejectedValue(new Error('SOE unavailable')),
        } as unknown as TeslaClient;
        const rows = await new Importer(client).fetchRange(site, new Date('2026-10-01T05:00:00Z'), new Date('2026-10-02T04:59:59Z'), 'day');
        expect(rows).toHaveLength(1);
        expect(rows[0].battery_soc).toBeNull();
    });

    it('fails the fetch on an SOE error when SOE is required, so callers never replace stored SOC with nulls', async () => {
        const client = {
            getEnergyHistory: vi.fn().mockResolvedValue([entry('2026-10-01T05:00:00Z')]),
            getSoeHistory: vi.fn().mockRejectedValue(new Error('SOE unavailable')),
        } as unknown as TeslaClient;
        await expect(new Importer(client).fetchRange(site, new Date('2026-10-01T05:00:00Z'), new Date('2026-10-02T04:59:59Z'), 'day', { requireSoe: true }))
            .rejects.toThrow('SOE unavailable');
    });
});
