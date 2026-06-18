import { beforeEach, describe, expect, it, vi } from 'vitest';

const { connectMock, clientQueryMock, releaseMock } = vi.hoisted(() => ({
    connectMock: vi.fn(),
    clientQueryMock: vi.fn(),
    releaseMock: vi.fn(),
}));

vi.mock('./db', () => ({
    pool: {
        connect: connectMock,
        query: vi.fn(),
    },
}));

import { TariffRepo } from './tariff-repo';
import type { ParsedTariff } from './importer/tariff-parser';

const parsed: ParsedTariff = {
    name: 'PG&E',
    seasons: [{
        name: 'All Year', from_month: 1, from_day: 1, to_month: 12, to_day: 31,
        buy_rate: 0, sell_rate: 0,
        schedules: [{ name: 'OFF_PEAK', buy_rate: 0.3, sell_rate: 0.1, from_day_of_week: 0, to_day_of_week: 6, from_hour: 0, from_minute: 0, to_hour: 24, to_minute: 0 }],
    }],
};

function sqlOf(call: unknown[]): string {
    return String(call[0]);
}

describe('TariffRepo.addTariffVersion', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        connectMock.mockResolvedValue({ query: clientQueryMock, release: releaseMock });
    });

    it('appends a new version and demotes the current one, without deleting', async () => {
        clientQueryMock.mockImplementation(async (sql: string) => {
            if (sql.includes('SELECT content_hash')) return { rows: [{ content_hash: 'STALE' }] };
            if (sql.includes('MAX(version)')) return { rows: [{ next: 2 }] };
            if (sql.includes('INSERT INTO "Tariff"')) return { rows: [{ id: 8 }] };
            if (sql.includes('INSERT INTO "TariffSeason"')) return { rows: [{ id: 80 }] };
            return { rows: [] };
        });

        await new TariffRepo().addTariffVersion('site-1', parsed, '2026-06-18', '2020-01-15');

        const sqls = clientQueryMock.mock.calls.map(sqlOf);
        expect(sqls.some((s) => s.includes('DELETE FROM'))).toBe(false);
        expect(sqls.some((s) => s.includes('UPDATE "Tariff" SET is_current = false'))).toBe(true);
        expect(sqls.some((s) => s.includes('INSERT INTO "Tariff"') && s.includes('is_current'))).toBe(true);
        expect(sqls.some((s) => s.includes('COMMIT'))).toBe(true);
    });

    it('is a no-op when the current version already has the same content_hash', async () => {
        const { tariffContentHash } = await import('./importer/tariff-parser');
        const matching = tariffContentHash(parsed);
        clientQueryMock.mockImplementation(async (sql: string) => {
            if (sql.includes('SELECT content_hash')) return { rows: [{ content_hash: matching }] };
            return { rows: [] };
        });

        await new TariffRepo().addTariffVersion('site-1', parsed, '2026-06-18', '2020-01-15');

        const sqls = clientQueryMock.mock.calls.map(sqlOf);
        expect(sqls.some((s) => s.includes('INSERT INTO "Tariff"'))).toBe(false);
        expect(sqls.some((s) => s.includes('UPDATE "Tariff" SET is_current = false'))).toBe(false);
    });
});

describe('TariffRepo.listMeteredVersions', () => {
    beforeEach(() => { vi.clearAllMocks(); });

    it('selects all non-reporting versions (no is_current filter), newest effective_from first', async () => {
        const poolQuery = (await import('./db')).pool.query as ReturnType<typeof vi.fn>;
        poolQuery.mockResolvedValue({ rows: [
            { tariff_id: 2, tariff_name: 'PG&E', tariff_updated: '2026-01-01', tariff_site_id: 'site-1',
              tariff_reporting_only: false, tariff_effective_from: '2026-01-01',
              season_id: 20, season_name: 'All Year', from_month: 1, from_day: 1, to_month: 12, to_day: 31,
              season_buy_rate: 0.2, season_sell_rate: 0.05, schedule_id: 200, schedule_name: 'W',
              schedule_buy_rate: 0.2, schedule_sell_rate: 0.05,
              from_day_of_week: 0, from_hour: 0, from_minute: 0, to_day_of_week: 6, to_hour: 24, to_minute: 0 },
            { tariff_id: 1, tariff_name: 'PG&E', tariff_updated: '2024-01-01', tariff_site_id: 'site-1',
              tariff_reporting_only: false, tariff_effective_from: null,
              season_id: 10, season_name: 'All Year', from_month: 1, from_day: 1, to_month: 12, to_day: 31,
              season_buy_rate: 0.1, season_sell_rate: 0.05, schedule_id: 100, schedule_name: 'W',
              schedule_buy_rate: 0.1, schedule_sell_rate: 0.05,
              from_day_of_week: 0, from_hour: 0, from_minute: 0, to_day_of_week: 6, to_hour: 24, to_minute: 0 },
        ] });

        const versions = await new TariffRepo().listMeteredVersions('site-1');

        const sql = String(poolQuery.mock.calls[0][0]);
        expect(sql).toMatch(/NOT t\.reporting_only/);
        expect(sql).not.toMatch(/is_current/);
        expect(sql).toMatch(/effective_from DESC NULLS LAST/);
        expect(poolQuery.mock.calls[0][1]).toEqual(['site-1']);
        expect(versions).toHaveLength(2);
        expect(versions[0].effective_from).toBe('2026-01-01');
        expect(versions[0].seasons?.[0].schedules?.[0].buy_rate).toBe(0.2);
        expect(versions[1].effective_from).toBeNull();
    });
});

describe('TariffRepo.addTariffVersion — effective_from stamping', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        connectMock.mockResolvedValue({ query: clientQueryMock, release: releaseMock });
    });

    function mockSeq(nextVersion: number) {
        clientQueryMock.mockImplementation(async (sql: string) => {
            if (sql.includes('SELECT content_hash')) return { rows: [{ content_hash: 'STALE' }] };
            if (sql.includes('MAX(version)')) return { rows: [{ next: nextVersion }] };
            if (sql.includes('INSERT INTO "Tariff"')) return { rows: [{ id: 8 }] };
            if (sql.includes('INSERT INTO "TariffSeason"')) return { rows: [{ id: 80 }] };
            return { rows: [] };
        });
    }
    function tariffInsertCall() {
        return clientQueryMock.mock.calls.find(c => String(c[0]).includes('INSERT INTO "Tariff"'))!;
    }

    it('stamps the install date on the first version (carries backward as the floor)', async () => {
        mockSeq(1);
        await new TariffRepo().addTariffVersion('site-1', parsed, '2026-06-18', '2020-01-15');
        const call = tariffInsertCall();
        expect(String(call[0])).toMatch(/effective_from/);
        expect(call[1]).toContain('2020-01-15');
        expect(call[1]).not.toContain('2026-06-18');
    });

    it('stamps the detection date on a non-first version', async () => {
        mockSeq(3);
        await new TariffRepo().addTariffVersion('site-1', parsed, '2026-06-18', '2020-01-15');
        const call = tariffInsertCall();
        expect(call[1]).toContain('2026-06-18');
        expect(call[1]).not.toContain('2020-01-15');
    });
});

describe('TariffRepo.setMeteredEffectiveFrom', () => {
    beforeEach(() => { vi.clearAllMocks(); });
    it('updates one metered version effective_from, guarded to non-reporting', async () => {
        const poolQuery = (await import('./db')).pool.query as ReturnType<typeof vi.fn>;
        poolQuery.mockResolvedValue({ rowCount: 1 });
        await new TariffRepo().setMeteredEffectiveFrom('site-1', 3, '2025-09-01');
        const sql = String(poolQuery.mock.calls[0][0]);
        expect(sql).toMatch(/UPDATE "Tariff" SET effective_from/);
        expect(sql).toMatch(/NOT reporting_only/);
        expect(poolQuery.mock.calls[0][1]).toEqual(['site-1', 3, '2025-09-01']);
    });
    it('accepts null to clear a date', async () => {
        const poolQuery = (await import('./db')).pool.query as ReturnType<typeof vi.fn>;
        poolQuery.mockResolvedValue({ rowCount: 1 });
        await new TariffRepo().setMeteredEffectiveFrom('site-1', 1, null);
        expect(poolQuery.mock.calls[0][1]).toEqual(['site-1', 1, null]);
    });
});
describe('TariffRepo.getSiteInstalledDate', () => {
    beforeEach(() => { vi.clearAllMocks(); });
    it('returns the site install date as YYYY-MM-DD', async () => {
        const poolQuery = (await import('./db')).pool.query as ReturnType<typeof vi.fn>;
        poolQuery.mockResolvedValue({ rows: [{ installed: '2020-01-15' }] });
        const d = await new TariffRepo().getSiteInstalledDate('site-1');
        const sql = String(poolQuery.mock.calls[0][0]);
        expect(sql).toMatch(/installed::date/);
        expect(poolQuery.mock.calls[0][1]).toEqual(['site-1']);
        expect(d).toBe('2020-01-15');
    });
});

describe('TariffRepo.addHistoricMeteredVersion — insert at install + bump previous oldest', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        connectMock.mockResolvedValue({ query: clientQueryMock, release: releaseMock });
    });

    it('inserts a non-current metered version dated to install and bumps the previous oldest to the switch date', async () => {
        clientQueryMock.mockImplementation(async (sql: string) => {
            if (sql.includes('installed::date')) return { rows: [{ installed: '2020-01-15' }] };
            if (sql.includes('SELECT name')) return { rows: [{ name: 'PG&E' }] };
            // previous-oldest lookup: the version currently at the minimum effective_from
            if (sql.includes('ORDER BY effective_from ASC')) return { rows: [{ version: 1 }] };
            if (sql.includes('MAX(version)')) return { rows: [{ next: 4 }] };
            if (sql.includes('INSERT INTO "Tariff"')) return { rows: [{ id: 9 }] };
            if (sql.includes('INSERT INTO "TariffSeason"')) return { rows: [{ id: 90 }] };
            return { rows: [] };
        });

        await new TariffRepo().addHistoricMeteredVersion('site-1', parsed, '2025-09-01');

        const calls = clientQueryMock.mock.calls;
        const sqls = calls.map(sqlOf);
        // new version inserted at the install anchor, not current, not reporting-only
        const insert = calls.find(c => String(c[0]).includes('INSERT INTO "Tariff"'))!;
        expect(String(insert[0])).toMatch(/reporting_only/);
        expect(String(insert[0])).toMatch(/false,\s*false/);
        expect(insert[1]).toEqual(expect.arrayContaining(['site-1', 'PG&E', 4, '2020-01-15']));
        // previous oldest (version 1) bumped to the switch date
        const bump = calls.find(c => String(c[0]).includes('UPDATE "Tariff" SET effective_from'))!;
        expect(bump[1]).toEqual(['site-1', 1, '2025-09-01']);
        expect(sqls.some(s => s.includes('COMMIT'))).toBe(true);
        // never demotes the Tesla current version
        expect(sqls.some(s => s.includes('is_current = false'))).toBe(false);
    });
});

describe('TariffRepo.getMeteredVersionStructure', () => {
    beforeEach(() => { vi.clearAllMocks(); });
    it('returns the version name + parsed seasons (no ids)', async () => {
        const poolQuery = (await import('./db')).pool.query as ReturnType<typeof vi.fn>;
        poolQuery.mockResolvedValue({ rows: [
            { tariff_name: 'PG&E', season_id: 90, season_name: 'All Year',
              from_month: 1, from_day: 1, to_month: 12, to_day: 31,
              season_buy_rate: 0.2, season_sell_rate: 0.05, schedule_id: 900, schedule_name: 'W',
              schedule_buy_rate: 0.2, schedule_sell_rate: 0.05,
              from_day_of_week: 0, from_hour: 0, from_minute: 0, to_day_of_week: 6, to_hour: 24, to_minute: 0 },
        ] });
        const out = await new TariffRepo().getMeteredVersionStructure('site-1', 2);
        const sql = String(poolQuery.mock.calls[0][0]);
        expect(sql).toMatch(/NOT t\.reporting_only/);
        expect(poolQuery.mock.calls[0][1]).toEqual(['site-1', 2]);
        expect(out).not.toBeNull();
        expect(out!.name).toBe('PG&E');
        expect(out!.seasons[0].schedules[0].buy_rate).toBe(0.2);
        expect('id' in out!.seasons[0]).toBe(false);
    });
});

describe('TariffRepo.replaceMeteredVersion', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        connectMock.mockResolvedValue({ query: clientQueryMock, release: releaseMock });
    });
    it('rejects replacing the Tesla current version (rates are read-only)', async () => {
        clientQueryMock.mockImplementation(async (sql: string) => {
            if (sql.includes('SELECT id, is_current')) return { rows: [{ id: 7, is_current: true }] };
            return { rows: [] };
        });
        await expect(new TariffRepo().replaceMeteredVersion('site-1', 2, parsed, '2025-09-01'))
            .rejects.toThrow(/current/i);
        const sqls = clientQueryMock.mock.calls.map(sqlOf);
        expect(sqls.some(s => s.includes('ROLLBACK'))).toBe(true);
    });
    it('replaces a historic version: deletes old seasons, reinserts, updates date', async () => {
        clientQueryMock.mockImplementation(async (sql: string) => {
            if (sql.includes('SELECT id, is_current')) return { rows: [{ id: 9, is_current: false }] };
            if (sql.includes('INSERT INTO "TariffSeason"')) return { rows: [{ id: 91 }] };
            return { rows: [] };
        });
        await new TariffRepo().replaceMeteredVersion('site-1', 4, parsed, '2025-09-01');
        const sqls = clientQueryMock.mock.calls.map(sqlOf);
        expect(sqls.some(s => s.includes('DELETE FROM "TariffSeason"'))).toBe(true);
        expect(sqls.some(s => s.includes('INSERT INTO "TariffSeason"'))).toBe(true);
        expect(sqls.some(s => s.includes('UPDATE "Tariff" SET name'))).toBe(true);
        expect(sqls.some(s => s.includes('COMMIT'))).toBe(true);
    });
});
