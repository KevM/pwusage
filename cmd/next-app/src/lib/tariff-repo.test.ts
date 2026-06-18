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

        await new TariffRepo().addTariffVersion('site-1', parsed, '2026-06-18');

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

        await new TariffRepo().addTariffVersion('site-1', parsed, '2026-06-18');

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

    it('stamps the detection date on a non-first version', async () => {
        mockSeq(3);
        await new TariffRepo().addTariffVersion('site-1', parsed, '2026-06-18');
        const call = tariffInsertCall();
        expect(String(call[0])).toMatch(/effective_from/);
        expect(call[1]).toContain('2026-06-18');
    });

    it('leaves the first version (version 1) undated so it carries backward', async () => {
        mockSeq(1);
        await new TariffRepo().addTariffVersion('site-1', parsed, '2026-06-18');
        const call = tariffInsertCall();
        expect(call[1]).toContain(null);
        expect(call[1]).not.toContain('2026-06-18');
    });
});
