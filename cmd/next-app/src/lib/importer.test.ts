vi.mock('./energy-repo-factory',()=>({createEnergyRepo:(_timezone:string,rawRepo:EnergyRepo)=>rawRepo}));

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Importer } from './importer';
import { EnergyHistoryEntry, TeslaClient } from './tesla-client';
import { EnergyRepo } from './energy-repo';
import type { DailyCoverageStat } from './energy-repo';
import type { ImportLockOptions, ImportLockResult } from './import-lock';

interface ImportLockTestRepo {
    acquireImportLock(params: {
        siteId: string;
        lockId: string;
        lockDurationMs?: number;
        force?: boolean;
        minIntervalMs?: number;
    }): Promise<boolean>;
    releaseImportLock(siteId: string, lockId: string): Promise<boolean>;
}

interface MockSiteRepo {
    getSite: ReturnType<typeof vi.fn>;
    acquireImportLock: ReturnType<typeof vi.fn>;
    releaseImportLock: ReturnType<typeof vi.fn>;
    getImportStatus: ReturnType<typeof vi.fn>;
}

const importLockMock = vi.hoisted(() => ({
    withImportLock: vi.fn(async <T>(
        siteRepo: ImportLockTestRepo,
        options: ImportLockOptions,
        callback: () => Promise<T>
    ): Promise<ImportLockResult<T>> => {
        const lockId = 'test-lock-id';
        const acquired = await siteRepo.acquireImportLock({
            siteId: options.siteId,
            lockId,
            lockDurationMs: options.lockDurationMs,
            force: options.force,
            minIntervalMs: options.minIntervalMs,
        });

        if (!acquired) {
            return { status: 'not-acquired' };
        }

        try {
            return { status: 'acquired', value: await callback() };
        } finally {
            await siteRepo.releaseImportLock(options.siteId, lockId);
        }
    }),
}));

// Mock dependencies
vi.mock('./db');
// `getSiteMidnight` is stubbed to floor UTC hours, so day windows in these tests
// are UTC days. `formatSiteDate` must agree with it, otherwise the coverage keys
// the planner looks up would never match the mocked coverage rows.
vi.mock('./date-utils', () => ({
    getSiteMidnight: vi.fn((d: Date) => {
        const date = new Date(d);
        date.setUTCHours(0, 0, 0, 0);
        return date;
    }),
    formatSiteDate: vi.fn((d: Date) => new Date(d).toISOString().slice(0, 10)),
}));
vi.mock('./energy-repo', () => {
    class EnergyRepo {
        getRawEnergyData = vi.fn();
        getLatestEnergyData = vi.fn();
        getDailyCoverage = vi.fn();
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
        acquireImportLock = vi.fn().mockResolvedValue(true);
        releaseImportLock = vi.fn().mockResolvedValue(true);
        getImportStatus = vi.fn().mockResolvedValue({ isImporting: false, lastImportAt: 0 });
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
const healedArchiveMock = vi.hoisted(() => ({ archiveHealedDays: vi.fn(async () => []) }));
vi.mock('./healed-day-archive', () => healedArchiveMock);
vi.mock('./import-lock', () => ({
    withImportLock: importLockMock.withImportLock,
}));

describe('Importer Sync Logic', () => {
    let importer: Importer;
    let mockClient: TeslaClient;
    let mockRepo: MockSiteRepo;

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
            }),
            acquireImportLock: vi.fn().mockResolvedValue(true),
            releaseImportLock: vi.fn().mockResolvedValue(true),
            getImportStatus: vi.fn().mockResolvedValue({ isImporting: false, lastImportAt: 0 })
        };
        (importer as unknown as { siteRepo: unknown }).siteRepo = mockRepo;
        
        // Mock EnergyRepo
        const energyRepoMock = {
            getSiteMidnight: EnergyRepo.getSiteMidnight,
            getLatestTimestamp: vi.fn(),
            getDailyCoverage: vi.fn(),
            insertEnergyDataBatch: vi.fn()
        };
        (importer as unknown as { repo: unknown }).repo = energyRepoMock;
    });

    it('should trigger import when data is missing', async () => {
        // Mock repo methods
        (importer as unknown as { repo: unknown }).repo = {
            getSiteMidnight: EnergyRepo.getSiteMidnight,
            getLatestTimestamp: vi.fn().mockResolvedValue(null),
            getDailyCoverage: vi.fn().mockResolvedValue([]),
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

    it('returns an empty result when the DB import lock is not acquired', async () => {
        mockRepo.acquireImportLock.mockResolvedValue(false);
        const importSpy = vi.spyOn(importer, 'importRange').mockResolvedValue([]);

        const start = new Date('2026-01-10T00:00:00Z');
        const end = new Date('2026-01-10T23:59:59Z');

        await expect(importer.ensureDataForRange('site-123', start, end)).resolves.toEqual({
            complete: false,
            rows: [],
            processedWindows: 0,
            totalWindows: 0,
        });
        expect(importSpy).not.toHaveBeenCalled();
    });

    it('releases the DB import lock when a planned window import throws', async () => {
        (importer as unknown as { repo: unknown }).repo = {
            getSiteMidnight: EnergyRepo.getSiteMidnight,
            getLatestTimestamp: vi.fn().mockResolvedValue(null),
            getDailyCoverage: vi.fn().mockResolvedValue([]),
            insertEnergyDataBatch: vi.fn()
        };
        vi.spyOn(importer, 'importRange').mockRejectedValue(new Error('Tesla API Offline'));

        const start = new Date('2026-01-10T00:00:00Z');
        const end = new Date('2026-01-10T23:59:59Z');

        await expect(importer.ensureDataForRange('site-123', start, end)).rejects.toThrow('Tesla API Offline');
        expect(mockRepo.releaseImportLock).toHaveBeenCalledWith('site-123', expect.any(String));
    });

    it('uses the shared import lock helper with 90s duration and releases after successful window import', async () => {
        (importer as unknown as { repo: unknown }).repo = {
            getSiteMidnight: EnergyRepo.getSiteMidnight,
            getLatestTimestamp: vi.fn().mockResolvedValue(null),
            getDailyCoverage: vi.fn().mockResolvedValue([]),
            insertEnergyDataBatch: vi.fn()
        };
        vi.spyOn(importer, 'importRange').mockResolvedValue([]);

        const start = new Date('2026-01-10T00:00:00Z');
        const end = new Date('2026-01-10T23:59:59Z');

        const result = await importer.ensureDataForRange('site-123', start, end);

        expect(result.complete).toBe(true);
        expect(importLockMock.withImportLock).toHaveBeenCalledWith(
            mockRepo,
            expect.objectContaining({
                siteId: 'site-123',
                lockDurationMs: 90000,
                force: false,
                logLabel: 'Importer',
            }),
            expect.any(Function)
        );
        expect(mockRepo.releaseImportLock).toHaveBeenCalledWith('site-123', expect.any(String));
    });

    it('should throw an error when all planned windows fail to import', async () => {
        (importer as unknown as { repo: unknown }).repo = {
            getSiteMidnight: EnergyRepo.getSiteMidnight,
            getLatestTimestamp: vi.fn().mockResolvedValue(null),
            getDailyCoverage: vi.fn().mockResolvedValue([]),
            insertEnergyDataBatch: vi.fn()
        };
        
        vi.spyOn(importer, 'importRange').mockRejectedValue(new Error('Tesla API Offline'));

        const start = new Date('2026-01-10T00:00:00Z');
        const end = new Date('2026-01-10T23:59:59Z');

        await expect(importer.ensureDataForRange('site-123', start, end))
            .rejects.toThrow('Tesla API Offline');
    });

    it('should NOT trigger import when data exists', async () => {
        // One fully covered site-local day, as `getDailyCoverage` summarizes it:
        // 5-minute rows from the first minute of the day to the last.
        const existingCoverage: DailyCoverageStat[] = [
            {
                localDayKey: '2026-01-10',
                count: 288,
                first: new Date('2026-01-10T00:00:00Z'),
                last: new Date('2026-01-10T23:55:00Z'),
                maxInteriorGapMs: 5 * 60 * 1000,
            },
        ];

        (importer as unknown as { repo: unknown }).repo = {
            getSiteMidnight: EnergyRepo.getSiteMidnight,
            getLatestTimestamp: vi.fn().mockResolvedValue(null),
            getDailyCoverage: vi.fn().mockResolvedValue(existingCoverage),
            insertEnergyDataBatch: vi.fn()
        };

        const importSpy = vi.spyOn(importer, 'importRange').mockResolvedValue([]);

        const s = new Date('2026-01-10T00:00:00Z');
        const e = new Date('2026-01-10T23:59:59Z');

        await importer.ensureDataForRange('site-123', s, e);

        expect(importSpy).not.toHaveBeenCalled();
    });


    it('does not multiply singleton history rows by 1000', async () => {
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
                soeHistory: []
            ) => Promise<Array<{ load_power: number; grid_power: number }>>;
        }).processHistory(site, singletonHistory, []);

        expect(rows).toHaveLength(1);
        expect(rows[0].load_power).toBe(64);
        expect(rows[0].grid_power).toBe(64);
    });

    it('audits coverage using site midnight when start is non-midnight', async () => {
        // Simulate the bug: caller passes autoBackfillLimit at 14:30, which has full-day data
        // Without the fix, the early part of the day is not covered by the audit range, falsely triggering re-import
        const start = new Date('2026-01-10T14:30:00Z'); // non-midnight start
        const end = new Date('2026-01-11T00:00:00Z');

        // Full-day coverage (00:00 to 23:30 in 30-min intervals) collapses to a
        // single per-day row: no interior gap exceeds the 30-minute threshold and
        // neither open edge of the day is more than 30 minutes away.
        const existingCoverage: DailyCoverageStat[] = [
            {
                localDayKey: '2026-01-10',
                count: 48,
                first: new Date('2026-01-10T00:00:00Z'),
                last: new Date('2026-01-10T23:30:00Z'),
                maxInteriorGapMs: 30 * 60 * 1000,
            },
        ];

        const getDailyCoverageMock = vi.fn().mockResolvedValue(existingCoverage);

        (importer as unknown as { repo: unknown }).repo = {
            getSiteMidnight: EnergyRepo.getSiteMidnight,
            getLatestTimestamp: vi.fn().mockResolvedValue(null),
            getDailyCoverage: getDailyCoverageMock,
            insertEnergyDataBatch: vi.fn()
        };

        const importSpy = vi.spyOn(importer, 'importRange').mockResolvedValue([]);

        await importer.ensureDataForRange('site-123', start, end);

        // Coverage is audited from site midnight (00:00), not the caller's
        // non-midnight start (14:30), and it is bucketed by the site's timezone
        expect(getDailyCoverageMock).toHaveBeenCalledWith(
            'site-123',
            new Date('2026-01-10T00:00:00Z'),
            new Date('2026-01-11T00:00:00Z'),
            'America/Chicago'
        );

        // Verify we don't import when full-day coverage exists
        expect(importSpy).not.toHaveBeenCalled();
    });

    it('stops importing and returns complete: false when maxTimeMs time budget is reached', async () => {
        (importer as unknown as { repo: unknown }).repo = {
            getSiteMidnight: EnergyRepo.getSiteMidnight,
            getLatestTimestamp: vi.fn().mockResolvedValue(null),
            getDailyCoverage: vi.fn().mockResolvedValue([]),
            insertEnergyDataBatch: vi.fn()
        };

        const start = new Date('2026-01-10T00:00:00Z');
        const end = new Date('2026-01-15T00:00:00Z');

        let currentTime = 10000;
        vi.spyOn(Date, 'now').mockImplementation(() => currentTime);

        const importSpy = vi.spyOn(importer, 'importRange').mockImplementation(async () => {
            currentTime += 50000; // Advance time by 50s on each imported window
            return [];
        });

        const result = await importer.ensureDataForRange('site-123', start, end, undefined, { maxTimeMs: 10000 });

        expect(result.complete).toBe(false);
        expect(result.processedWindows).toBe(1);
        expect(importSpy).toHaveBeenCalledTimes(1);

        vi.spyOn(Date, 'now').mockRestore();
    });

    it('imports only the newest maxWindows planned windows and reports incomplete', async () => {
        (importer as unknown as { repo: unknown }).repo = {
            getSiteMidnight: EnergyRepo.getSiteMidnight,
            getLatestTimestamp: vi.fn().mockResolvedValue(null),
            getDailyCoverage: vi.fn().mockResolvedValue([]),
            insertEnergyDataBatch: vi.fn()
        };
        const importSpy = vi.spyOn(importer, 'importRange').mockResolvedValue([]);

        const start = new Date('2026-01-10T00:00:00Z');
        const end = new Date('2026-01-15T00:00:00Z');

        const result = await importer.ensureDataForRange('site-123', start, end, undefined, { maxWindows: 2 });

        expect(importSpy.mock.calls.map(c => c[1].toISOString())).toEqual([
            '2026-01-14T00:00:00.000Z',
            '2026-01-13T00:00:00.000Z',
        ]);
        expect(result.totalWindows).toBe(5);
        expect(result.processedWindows).toBe(2);
        expect(result.complete).toBe(false);
    });

    it('hands successfully imported days to the healed-day archiver when asked', async () => {
        (importer as unknown as { repo: unknown }).repo = {
            getSiteMidnight: EnergyRepo.getSiteMidnight,
            getLatestTimestamp: vi.fn().mockResolvedValue(null),
            getDailyCoverage: vi.fn().mockResolvedValue([]),
            insertEnergyDataBatch: vi.fn()
        };
        vi.spyOn(importer, 'importRange')
            .mockResolvedValueOnce([])
            .mockRejectedValueOnce(new Error('Tesla flaked on this day'));

        await importer.ensureDataForRange('site-123', new Date('2026-01-10T00:00:00Z'), new Date('2026-01-12T00:00:00Z'),
            undefined, { archiveHealedDays: true });

        expect(healedArchiveMock.archiveHealedDays).toHaveBeenCalledTimes(1);
        expect(healedArchiveMock.archiveHealedDays).toHaveBeenCalledWith(
            { id: 'site-123', timezone: 'America/Chicago' },
            [{ start: new Date('2026-01-10T00:00:00Z'), end: new Date('2026-01-11T00:00:00Z') }],
            expect.any(Date));
    });

    it('leaves archiving to the caller by default and when nothing imported', async () => {
        (importer as unknown as { repo: unknown }).repo = {
            getSiteMidnight: EnergyRepo.getSiteMidnight,
            getLatestTimestamp: vi.fn().mockResolvedValue(null),
            getDailyCoverage: vi.fn().mockResolvedValue([]),
            insertEnergyDataBatch: vi.fn()
        };
        vi.spyOn(importer, 'importRange').mockResolvedValue([]);
        const start = new Date('2026-01-10T00:00:00Z'), end = new Date('2026-01-11T00:00:00Z');

        await importer.ensureDataForRange('site-123', start, end);
        await importer.ensureDataForRange('site-123', start, end, undefined, { archiveHealedDays: true, maxWindows: 0 });

        expect(healedArchiveMock.archiveHealedDays).not.toHaveBeenCalled();
    });

    it('returns complete: false when some planned windows fail and others succeed', async () => {
        (importer as unknown as { repo: unknown }).repo = {
            getSiteMidnight: EnergyRepo.getSiteMidnight,
            getLatestTimestamp: vi.fn().mockResolvedValue(null),
            getDailyCoverage: vi.fn().mockResolvedValue([]),
            insertEnergyDataBatch: vi.fn()
        };
        // First window imports, every later window fails.
        const importSpy = vi.spyOn(importer, 'importRange')
            .mockResolvedValueOnce([])
            .mockRejectedValue(new Error('Tesla flaked on this day'));

        // Two-day range with no existing data -> multiple planned windows.
        const start = new Date('2026-01-10T00:00:00Z');
        const end = new Date('2026-01-11T23:59:59Z');

        const result = await importer.ensureDataForRange('site-123', start, end);

        expect(importSpy.mock.calls.length).toBeGreaterThan(1);
        expect(result.totalWindows).toBe(importSpy.mock.calls.length);
        expect(result.processedWindows).toBe(1);
        expect(result.complete).toBe(false);
    });
});


describe('Importer.refetchDays', () => {
    let importer: Importer;
    let mockRepo: MockSiteRepo;
    const day = (iso: string) => ({ start: new Date(iso), end: new Date(+new Date(iso) + 86400000) });
    const days = [day('2026-05-03T05:00:00Z'), day('2026-07-03T05:00:00Z'), day('2026-08-20T05:00:00Z')];

    beforeEach(() => {
        vi.clearAllMocks();
        importer = new Importer(new TeslaClient({ accessToken: 'test' }));
        mockRepo = {
            getSite: vi.fn().mockResolvedValue({ id: 'site-123', timezone: 'America/Chicago', installed: new Date('2025-01-01T00:00:00Z'), tariffs: [] }),
            acquireImportLock: vi.fn().mockResolvedValue(true),
            releaseImportLock: vi.fn().mockResolvedValue(true),
            getImportStatus: vi.fn(),
        };
        (importer as unknown as { siteRepo: unknown }).siteRepo = mockRepo;
    });

    it('re-imports exactly the given days, even if coverage says they are complete, under the normal (non-forced) lock', async () => {
        const importSpy = vi.spyOn(importer, 'importRange').mockResolvedValue([]);

        const result = await importer.refetchDays('site-123', days, { maxTimeMs: 45000, maxWindows: 30 });

        expect(importSpy.mock.calls.map(c => [c[1], c[2]])).toEqual(days.map(d => [d.start, d.end]));
        expect(mockRepo.acquireImportLock).toHaveBeenCalledWith(expect.objectContaining({ siteId: 'site-123', force: false }));
        expect(result).toEqual({ complete: true, rows: [], processedWindows: 3, totalWindows: 3 });
    });

    it('returns 0/0 without importing when the import lock is busy', async () => {
        mockRepo.acquireImportLock.mockResolvedValue(false);
        const importSpy = vi.spyOn(importer, 'importRange').mockResolvedValue([]);

        await expect(importer.refetchDays('site-123', days, { maxTimeMs: 45000, maxWindows: 30 }))
            .resolves.toEqual({ complete: false, rows: [], processedWindows: 0, totalWindows: 0 });
        expect(importSpy).not.toHaveBeenCalled();
    });

    it('caps a call at maxWindows and reports incomplete', async () => {
        const importSpy = vi.spyOn(importer, 'importRange').mockResolvedValue([]);

        const result = await importer.refetchDays('site-123', days, { maxTimeMs: 45000, maxWindows: 2 });

        expect(importSpy).toHaveBeenCalledTimes(2);
        expect(result).toMatchObject({ complete: false, processedWindows: 2, totalWindows: 3 });
    });

    it('reports incomplete when some days fail, and throws when all fail', async () => {
        vi.spyOn(importer, 'importRange').mockResolvedValueOnce([]).mockRejectedValue(new Error('Tesla flaked'));
        await expect(importer.refetchDays('site-123', days, { maxTimeMs: 45000, maxWindows: 30 }))
            .resolves.toMatchObject({ complete: false, processedWindows: 1, totalWindows: 3 });

        vi.spyOn(importer, 'importRange').mockRejectedValue(new Error('Tesla down'));
        await expect(importer.refetchDays('site-123', days, { maxTimeMs: 45000, maxWindows: 30 })).rejects.toThrow('Tesla down');
    });
});

describe('Importer.getTodayData previous-day tail', () => {
    // getSiteMidnight is mocked to floor UTC, so "today" starts 2026-10-16T00:00Z.
    const NOW = new Date('2026-10-16T01:00:00Z');
    const TODAY = new Date('2026-10-16T00:00:00Z');
    const YESTERDAY = new Date('2026-10-15T00:00:00Z');

    let importer: Importer;
    let mockClient: TeslaClient;

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

    // Tesla returns the whole calendar day regardless of the requested start time.
    const yesterdayEntries = ['22:45', '22:50', '22:55', '23:55'].map(t => entry(`2026-10-15T${t}:00.000Z`));
    const todayEntries = ['00:00', '00:05', '00:55'].map(t => entry(`2026-10-16T${t}:00.000Z`));

    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(NOW);
        mockClient = new TeslaClient({ accessToken: 'test' });
        vi.mocked(mockClient.getEnergyHistory).mockImplementation(async (_id, start) =>
            start.getTime() < TODAY.getTime() ? yesterdayEntries : todayEntries);
        vi.mocked(mockClient.getSoeHistory).mockResolvedValue([]);
        importer = new Importer(mockClient);
        (importer as unknown as { siteRepo: unknown }).siteRepo = {
            getSite: vi.fn().mockResolvedValue({
                id: 'site-123',
                timezone: 'America/Chicago',
                installed: new Date('2025-01-01T00:00:00Z'),
                tariffs: [{ id: 1, site_id: 'site-123', updated: new Date('2025-01-01T00:00:00Z'), name: 'Default Tariff', seasons: [] }],
            }),
        };
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    const isos = (rows: Array<{ timestamp: Date }>) => rows.map(r => r.timestamp.toISOString());

    it('also fetches the rest of yesterday when the last stored row is before midnight', async () => {
        const rows = await importer.getTodayData('site-123', new Date('2026-10-15T22:50:00Z'));

        expect(mockClient.getEnergyHistory).toHaveBeenCalledTimes(2);
        const tailCall = vi.mocked(mockClient.getEnergyHistory).mock.calls.find(c => c[1].getTime() < TODAY.getTime())!;
        expect(tailCall[1].toISOString()).toBe('2026-10-15T22:50:00.000Z');
        expect(tailCall[2].getTime()).toBeLessThan(TODAY.getTime());
        expect(isos(rows)).toEqual([
            '2026-10-15T22:50:00.000Z',
            '2026-10-15T22:55:00.000Z',
            '2026-10-15T23:55:00.000Z',
            '2026-10-16T00:00:00.000Z',
            '2026-10-16T00:05:00.000Z',
            '2026-10-16T00:55:00.000Z',
        ]);
    });

    it('bounds the tail to yesterday when the last stored row is older', async () => {
        const rows = await importer.getTodayData('site-123', new Date('2026-10-13T12:00:00Z'));

        expect(mockClient.getEnergyHistory).toHaveBeenCalledTimes(2);
        const tailCall = vi.mocked(mockClient.getEnergyHistory).mock.calls.find(c => c[1].getTime() < TODAY.getTime())!;
        expect(tailCall[1].toISOString()).toBe(YESTERDAY.toISOString());
        expect(isos(rows)).toContain('2026-10-15T22:45:00.000Z');
    });

    it.each([
        ['yesterday is complete', new Date('2026-10-15T23:55:00Z')],
        ['the latest row is from today', new Date('2026-10-16T00:50:00Z')],
        ['there is no stored data', null],
        ['no latest timestamp is passed', undefined],
    ])('fetches only today when %s', async (_label, latest) => {
        const rows = await importer.getTodayData('site-123', latest);

        expect(mockClient.getEnergyHistory).toHaveBeenCalledTimes(1);
        expect(vi.mocked(mockClient.getEnergyHistory).mock.calls[0][1].toISOString()).toBe(TODAY.toISOString());
        expect(isos(rows)).toEqual(todayEntries.map(e => e.timestamp));
    });
});
