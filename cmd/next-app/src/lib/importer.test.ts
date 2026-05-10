
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Importer } from './importer';
import { EnergyHistoryEntry, TeslaClient } from './tesla-client';
import { pool } from './db';

// Mock dependencies
vi.mock('./db');
vi.mock('./date-utils', () => ({
    getSiteMidnight: vi.fn((d: Date) => {
        const date = new Date(d);
        date.setUTCHours(0, 0, 0, 0);
        return date;
    }),
}));
vi.mock('./energy-repo', () => {
    class EnergyRepo {
        getRawEnergyData = vi.fn();
        getLatestEnergyData = vi.fn();
        static getSiteMidnight = vi.fn((d: Date) => {
            const date = new Date(d);
            date.setUTCHours(0, 0, 0, 0);
            return date;
        });
    }
    return { EnergyRepo };
});
vi.mock('./site-repo', () => {
    class SiteRepo {
        getSite = vi.fn();
        invalidateCache = vi.fn();
    }
    return { SiteRepo };
});
vi.mock('./user-repo', () => {
    class UserRepo {
        updateLastChecked = vi.fn();
        updateUserStatus = vi.fn();
    }
    return { UserRepo };
});
vi.mock('./tesla-client');

describe('Importer Sync Logic', () => {
    let importer: Importer;
    let mockClient: TeslaClient;
    let mockRepo: unknown;

    beforeEach(() => {
        vi.clearAllMocks();
        mockClient = new TeslaClient({ accessToken: 'test' });
        importer = new Importer(mockClient);

        // Mock Repo
        mockRepo = {
            getSite: vi.fn().mockResolvedValue({
                id: 'site-123',
                timezone: 'America/Chicago',
                installed: new Date('2025-01-01T00:00:00Z'),
                tariffs: []
            })
        };
        (importer as unknown as { siteRepo: unknown }).siteRepo = mockRepo;
    });

    it('should trigger import when data is missing', async () => {
        // Mock DB query to return NO rows (gap)
        const mockQuery = vi.fn().mockResolvedValue({ rows: [] });
        (pool.query as unknown) = mockQuery;

        // Mock Import Call
        const importSpy = vi.spyOn(importer, 'importRange').mockResolvedValue([]);

        const start = new Date('2026-01-10T00:00:00Z');
        const end = new Date('2026-01-10T23:59:59Z');

        await importer.ensureDataForRange('site-123', start, end);

        expect(importSpy).toHaveBeenCalled();
        expect(importSpy).toHaveBeenCalledWith('site-123', expect.anything(), expect.anything(), 'day');
    });

    it('should NOT trigger import when data exists', async () => {
        // Mock DB query to return full rows
        const rows = [];
        const start = new Date('2026-01-10T00:00:00Z').getTime();
        for (let i = 0; i < 24; i++) {
            rows.push({ timestamp: new Date(start + i * 3600 * 1000).toISOString() });
        }

        const mockQuery = vi.fn().mockResolvedValue({ rows });
        (pool.query as unknown) = mockQuery;

        vi.spyOn(importer, 'importRange').mockResolvedValue([]);

        const s = new Date('2026-01-10T00:00:00Z');
        const e = new Date('2026-01-10T23:59:59Z');

        await importer.ensureDataForRange('site-123', s, e);
    });

    it('should handle ensureRecentData with pre-fetched timestamp', async () => {
        const latestKnown = new Date(Date.now() - 5 * 60 * 1000); // 5 mins ago (Fresh)
        const result = await importer.ensureRecentData('site-123', undefined, latestKnown);

        expect(result.rows).toHaveLength(0);
        expect(result.latestTimestamp).toEqual(latestKnown);
    });

    it('should trigger surgical sync in ensureRecentData when stale', async () => {
        const latestKnown = new Date(Date.now() - 30 * 60 * 1000); // 30 mins ago (Stale)
        const mockRows = [{ timestamp: new Date(), site_id: '123', tariff_id: 1, load_power: 100, solar_power: 0, grid_power: 100, battery_power: 0, battery_soc: 50 }];
        const importSpy = vi.spyOn(importer, 'importRange').mockResolvedValue(mockRows);

        const result = await importer.ensureRecentData('site-123', undefined, latestKnown);

        expect(importSpy).toHaveBeenCalled();
        expect(result.rows).toHaveLength(1);
        expect(result.latestTimestamp).toEqual(latestKnown);
    });

    it('does not multiply partial-day singleton history rows by 1000', async () => {
        const singletonHistory: EnergyHistoryEntry[] = [
            {
                timestamp: '2026-04-27T05:05:00.000Z',
                solar_energy_exported: 0,
                generator_energy_exported: 0,
                grid_energy_imported: 64,
                grid_services_energy_imported: 0,
                grid_services_energy_exported: 0,
                grid_energy_exported_from_solar: 0,
                grid_energy_exported_from_generator: 0,
                grid_energy_exported_from_battery: 0,
                battery_energy_exported: 0,
                battery_energy_imported_from_grid: 0,
                battery_energy_imported_from_solar: 0,
                battery_energy_imported_from_generator: 0,
                consumer_energy_imported_from_grid: 64,
                consumer_energy_imported_from_solar: 0,
                consumer_energy_imported_from_battery: 0,
                consumer_energy_imported_from_generator: 0,
                total_home_usage: 64,
                total_solar_generation: 0,
                total_battery_charge: 0,
                total_battery_discharge: 0,
                total_grid_energy_exported: 0
            }
        ];

        const site = {
            id: 'site-123',
            timezone: 'America/Chicago',
            installed: new Date('2025-01-01T00:00:00Z'),
            tariffs: [
                {
                    id: 1,
                    site_id: 'site-123',
                    updated: new Date('2025-01-01T00:00:00Z'),
                    name: 'Default Tariff',
                    seasons: []
                }
            ]
        };

        const rows = await (importer as unknown as {
            processHistory: (
                siteArg: typeof site,
                history: EnergyHistoryEntry[],
                soeHistory: [],
                period: string,
                requestedDurationHours: number
            ) => Promise<Array<{ load_power: number; grid_power: number }>>;
        }).processHistory(site, singletonHistory, [], 'day', 7);

        expect(rows).toHaveLength(1);
        expect(rows[0].load_power).toBe(64);
        expect(rows[0].grid_power).toBe(64);
    });

    it('audits coverage using site midnight when start is non-midnight', async () => {
        // Simulate the bug: caller passes autoBackfillLimit at 14:30, which has full-day data
        // Without the fix, early-day rows are omitted from existingTimestamps, falsely triggering re-import
        const start = new Date('2026-01-10T14:30:00Z'); // non-midnight start
        const end = new Date('2026-01-11T00:00:00Z');

        // Mock data exists for the full day (00:00 to 23:30 in 30-min intervals)
        const rows = [];
        const dayStart = new Date('2026-01-10T00:00:00Z').getTime();
        for (let i = 0; i < 48; i++) { // 00:00 to 23:30 in 30-min intervals
            rows.push({ timestamp: new Date(dayStart + i * 30 * 60 * 1000).toISOString() });
        }

        const mockQuery = vi.fn().mockResolvedValue({ rows });
        (pool.query as unknown) = mockQuery;

        const importSpy = vi.spyOn(importer, 'importRange').mockResolvedValue([]);

        await importer.ensureDataForRange('site-123', start, end);

        // Verify the query was called with site midnight (00:00), not the non-midnight start (14:30)
        expect(mockQuery).toHaveBeenCalled();
        const queryCall = mockQuery.mock.calls[0];
        const queryStart = queryCall[1][1]; // The timestamp parameter
        expect(queryStart).toBe(new Date('2026-01-10T00:00:00Z').toISOString());

        // Verify we don't import when full-day coverage exists
        expect(importSpy).not.toHaveBeenCalled();
    });
});
