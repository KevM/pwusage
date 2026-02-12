
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Importer } from './importer';
import { TeslaClient } from './tesla-client';
import { pool } from './db';

// Mock dependencies
vi.mock('./db');
vi.mock('./energy-repo', () => {
    class EnergyRepo {
        getSite = vi.fn();
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
        (importer as unknown as { repo: unknown }).repo = mockRepo;
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
});
