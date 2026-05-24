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

        await new TariffRepo().addTariffVersion('site-1', parsed);

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

        await new TariffRepo().addTariffVersion('site-1', parsed);

        const sqls = clientQueryMock.mock.calls.map(sqlOf);
        expect(sqls.some((s) => s.includes('INSERT INTO "Tariff"'))).toBe(false);
        expect(sqls.some((s) => s.includes('UPDATE "Tariff" SET is_current = false'))).toBe(false);
    });
});
