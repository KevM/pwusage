import { beforeEach, describe, expect, it, vi } from 'vitest';

const { poolQueryMock } = vi.hoisted(() => ({ poolQueryMock: vi.fn() }));
vi.mock('../db', () => ({ pool: { query: poolQueryMock } }));

import { HourlyRepo } from './hourly-repo';
import type { HourlyBucket } from './hourly-profile';

function bucket(over: Partial<HourlyBucket>): HourlyBucket {
    return {
        siteId: 's1', localDate: '2026-01-07', hour: 3,
        loadWh: 1, solarToHomeWh: 0, solarToBatteryWh: 0, solarToGridWh: 0,
        gridToHomeWh: 0, gridToBatteryWh: 0, batteryToHomeWh: 0, batteryToGridWh: 0,
        solarOnlyImportWh: 0, solarOnlyExportWh: 0, ...over,
    };
}

describe('HourlyRepo.upsertHourly', () => {
    beforeEach(() => poolQueryMock.mockReset());

    it('no-ops on empty input', async () => {
        await new HourlyRepo().upsertHourly([]);
        expect(poolQueryMock).not.toHaveBeenCalled();
    });

    it('inserts with ON CONFLICT upsert on the (site,date,hour) key', async () => {
        poolQueryMock.mockResolvedValue({ rows: [] });
        await new HourlyRepo().upsertHourly([bucket({ hour: 3 }), bucket({ hour: 4 })]);
        const sql = String(poolQueryMock.mock.calls[0][0]);
        expect(sql).toMatch(/INSERT INTO "EnergyHourly"/);
        expect(sql).toMatch(/ON CONFLICT\(site_id, local_date, hour\) DO UPDATE/);
        // 13 columns × 2 rows = 26 params
        expect(poolQueryMock.mock.calls[0][1]).toHaveLength(26);
    });
});

describe('HourlyRepo.getAllForSite', () => {
    beforeEach(() => poolQueryMock.mockReset());
    it('selects the site ordered by date then hour', async () => {
        poolQueryMock.mockResolvedValue({ rows: [] });
        await new HourlyRepo().getAllForSite('s1');
        const sql = String(poolQueryMock.mock.calls[0][0]);
        expect(sql).toMatch(/FROM "EnergyHourly" WHERE site_id = \$1/);
        expect(sql).toMatch(/ORDER BY local_date ASC, hour ASC/);
    });
});

describe('HourlyRepo.hasHourlyForDate', () => {
    beforeEach(() => poolQueryMock.mockReset());
    it('returns true when a row exists for the (site,date)', async () => {
        poolQueryMock.mockResolvedValue({ rows: [{ '1': 1 }] });
        const has = await new HourlyRepo().hasHourlyForDate('s1', '2026-01-07');
        expect(has).toBe(true);
        const sql = String(poolQueryMock.mock.calls[0][0]);
        expect(sql).toMatch(/FROM "EnergyHourly" WHERE site_id = \$1 AND local_date = \$2 LIMIT 1/);
        expect(poolQueryMock.mock.calls[0][1]).toEqual(['s1', '2026-01-07']);
    });
    it('returns false when no row exists', async () => {
        poolQueryMock.mockResolvedValue({ rows: [] });
        expect(await new HourlyRepo().hasHourlyForDate('s1', '2026-01-07')).toBe(false);
    });
});

