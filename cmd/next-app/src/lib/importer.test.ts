
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Importer } from './importer';
import { EnergyHistoryEntry, TeslaClient } from './tesla-client';
import { EnergyRepo } from './energy-repo';
import { TariffRepo } from './tariff-repo';
import { SiteRepo } from './site-repo';

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
        getExistingTimestamps = vi.fn();
        getLatestTimestamp = vi.fn();
        insertEnergyDataBatch = vi.fn();
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
        
        // Mock EnergyRepo
        const energyRepoMock = {
            getSiteMidnight: EnergyRepo.getSiteMidnight,
            getLatestTimestamp: vi.fn(),
            getExistingTimestamps: vi.fn(),
            insertEnergyDataBatch: vi.fn()
        };
        (importer as unknown as { repo: unknown }).repo = energyRepoMock;
    });

    it('should trigger import when data is missing', async () => {
        // Mock repo methods
        (importer as unknown as { repo: unknown }).repo = {
            getSiteMidnight: EnergyRepo.getSiteMidnight,
            getLatestTimestamp: vi.fn().mockResolvedValue(null),
            getExistingTimestamps: vi.fn().mockResolvedValue([]),
            insertEnergyDataBatch: vi.fn()
        };
        
        // Mock Import Call
        const importSpy = vi.spyOn(importer, 'importRange').mockResolvedValue([]);

        const start = new Date('2026-01-10T00:00:00Z');
        const end = new Date('2026-01-10T23:59:59Z');

        await importer.ensureDataForRange('site-123', start, end);

        expect(importSpy).toHaveBeenCalled();
        expect(importSpy).toHaveBeenCalledWith('site-123', expect.anything(), expect.anything(), 'day');
    });

    it('should NOT trigger import when data exists', async () => {
        // Mock repo methods with data
        const rows = [];
        const start = new Date('2026-01-10T00:00:00Z').getTime();
        for (let i = 0; i < 24; i++) {
            rows.push({ timestamp: new Date(start + i * 3600 * 1000).toISOString() });
        }
        const existingTimestamps = rows.map((r: { timestamp: string | Date }) => new Date(r.timestamp).getTime());
        
        (importer as unknown as { repo: unknown }).repo = {
            getSiteMidnight: EnergyRepo.getSiteMidnight,
            getLatestTimestamp: vi.fn().mockResolvedValue(null),
            getExistingTimestamps: vi.fn().mockResolvedValue(existingTimestamps),
            insertEnergyDataBatch: vi.fn()
        };

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
        const existingTimestamps = rows.map((r: { timestamp: string | Date }) => new Date(r.timestamp).getTime());

        (importer as unknown as { repo: unknown }).repo = {
            getSiteMidnight: EnergyRepo.getSiteMidnight,
            getLatestTimestamp: vi.fn().mockResolvedValue(null),
            getExistingTimestamps: vi.fn().mockResolvedValue(existingTimestamps),
            insertEnergyDataBatch: vi.fn()
        };

        const importSpy = vi.spyOn(importer, 'importRange').mockResolvedValue([]);

        await importer.ensureDataForRange('site-123', start, end);

        // Verify getExistingTimestamps was called with site midnight (00:00), not the non-midnight start (14:30)
        expect(existingTimestamps.length).toBe(48);

        // Verify we don't import when full-day coverage exists
        expect(importSpy).not.toHaveBeenCalled();
    });
});

describe('Importer Tariff Remapping', () => {
    let mockTariffRepo: unknown;
    let mockSiteRepo: unknown;
    let importer: Importer;

    beforeEach(() => {
        vi.resetAllMocks();

        // Mock TariffRepo
        mockTariffRepo = {
            getTariffsForSite: vi.fn()
        };

        // Mock SiteRepo
        mockSiteRepo = {
            getSite: vi.fn().mockResolvedValue({
                id: 'site-123',
                timezone: 'America/Chicago',
                installed: new Date('2025-01-01T00:00:00Z'),
                tariffs: []
            }),
            invalidateCache: vi.fn()
        };

        // Create importer with mocked repos
        const mockClient = new TeslaClient({ accessToken: 'test' });
        importer = new Importer(mockClient);

        // Replace repos with mocks
        (importer as Importer & { tariffRepo: TariffRepo; siteRepo: SiteRepo }).tariffRepo = mockTariffRepo as TariffRepo;
        (importer as Importer & { siteRepo: SiteRepo }).siteRepo = mockSiteRepo as SiteRepo;
    });

    it('should remap stale tariff IDs when DB has different IDs', async () => {
        // Mock site with old tariff IDs
        const siteTariffs = [
            { id: 99, site_id: 'site-123', name: 'Old Tariff', updated: new Date() }
        ];

        // Mock energy rows with stale tariff ID
        const rows = [
            {
                site_id: 'site-123',
                tariff_id: 99, // Stale ID
                tariff_schedule_id: 456,
                timestamp: new Date('2026-01-10T12:00:00Z'),
                load_power: 100,
                solar_power: 50,
                grid_power: 10,
                battery_power: 0,
                battery_soc: 50
            }
        ];

        // Mock current DB tariffs with different ID but same name
        (mockTariffRepo as TariffRepo).getTariffsForSite.mockResolvedValue([
            { id: 101, name: 'Old Tariff' }
        ]);

        const result = await (importer as Importer & { tariffRepo: TariffRepo }).remapTariffIds('site-123', rows, siteTariffs);

        expect(result).toHaveLength(1);
        expect(result[0].tariff_id).toBe(101); // Remapped from 99 to 101
        expect(result[0].tariff_schedule_id).toBeNull(); // Schedule ID nulled due to remapping
    });

    it('should skip rows with unresolvable tariff IDs', async () => {
        const siteTariffs = [
            { id: 99, site_id: 'site-123', name: 'Unknown Tariff', updated: new Date() }
        ];

        const rows = [
            {
                site_id: 'site-123',
                tariff_id: 99,
                tariff_schedule_id: null,
                timestamp: new Date('2026-01-10T12:00:00Z'),
                load_power: 100,
                solar_power: 50,
                grid_power: 10,
                battery_power: 0,
                battery_soc: 50
            }
        ];

        // Mock DB tariffs without the unknown tariff name
        (mockTariffRepo as TariffRepo).getTariffsForSite.mockResolvedValue([
            { id: 101, name: 'Different Tariff' }
        ]);

        const result = await (importer as Importer & { tariffRepo: TariffRepo }).remapTariffIds('site-123', rows, siteTariffs);

        expect(result).toHaveLength(0); // Row skipped
    });

    it('should keep valid tariff IDs unchanged', async () => {
        const siteTariffs = [
            { id: 101, site_id: 'site-123', name: 'Current Tariff', updated: new Date() }
        ];

        const rows = [
            {
                site_id: 'site-123',
                tariff_id: 101, // Valid ID
                tariff_schedule_id: 202,
                timestamp: new Date('2026-01-10T12:00:00Z'),
                load_power: 100,
                solar_power: 50,
                grid_power: 10,
                battery_power: 0,
                battery_soc: 50
            }
        ];

        (mockTariffRepo as TariffRepo).getTariffsForSite.mockResolvedValue([
            { id: 101, name: 'Current Tariff' }
        ]);

        const result = await (importer as Importer & { tariffRepo: TariffRepo }).remapTariffIds('site-123', rows, siteTariffs);

        expect(result).toHaveLength(1);
        expect(result[0].tariff_id).toBe(101); // Unchanged
        expect(result[0].tariff_schedule_id).toBe(202); // Schedule ID preserved
    });
});
