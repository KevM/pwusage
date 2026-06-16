import { beforeEach, describe, expect, it, vi } from 'vitest';

const { connectMock, clientQueryMock, releaseMock, poolQueryMock } = vi.hoisted(() => ({
    connectMock: vi.fn(), clientQueryMock: vi.fn(), releaseMock: vi.fn(), poolQueryMock: vi.fn(),
}));

vi.mock('../db', () => ({ pool: { connect: connectMock, query: poolQueryMock } }));

import { ComparisonTariffRepo } from './comparison-tariff-repo';

function sqlOf(call: unknown[]): string { return String(call[0]); }

describe('ComparisonTariffRepo.appendFixedComparison', () => {
    beforeEach(() => {
        clientQueryMock.mockReset();
        connectMock.mockResolvedValue({ query: clientQueryMock, release: releaseMock });
        clientQueryMock.mockResolvedValue({ rows: [{ next: 1, id: 42 }] });
    });

    it('demotes only the same-named current version, then inserts a reporting-only version with effective_from', async () => {
        await new ComparisonTariffRepo().appendFixedComparison('site-1', {
            name: 'PG&E flat', buyRate: 0.1658, sellRate: 0.08, effectiveFrom: '2024-01-01',
        });
        const sqls = clientQueryMock.mock.calls.map(sqlOf);
        const demote = sqls.find(s => s.includes('SET is_current = false'));
        expect(demote).toMatch(/name = \$2/);
        expect(demote).toMatch(/reporting_only/);
        const insert = sqls.find(s => s.includes('INSERT INTO "Tariff"'));
        expect(insert).toMatch(/reporting_only/);
        expect(insert).toMatch(/effective_from/);
    });
});

describe('ComparisonTariffRepo.nameInUseByMetered', () => {
    beforeEach(() => { poolQueryMock.mockReset(); });
    it('returns true when a current metered tariff already has the name', async () => {
        poolQueryMock.mockResolvedValue({ rows: [{ exists: true }] });
        const used = await new ComparisonTariffRepo().nameInUseByMetered('site-1', 'Standard');
        expect(used).toBe(true);
        const sql = sqlOf(poolQueryMock.mock.calls[0]);
        expect(sql).toMatch(/NOT reporting_only/);
        expect(sql).toMatch(/is_current/);
    });
});

describe('ComparisonTariffRepo.editComparisonVersion', () => {
    beforeEach(() => {
        clientQueryMock.mockReset();
        connectMock.mockResolvedValue({ query: clientQueryMock, release: releaseMock });
        // Tariff UPDATE returns the row id; subsequent UPDATEs return empty.
        clientQueryMock.mockResolvedValue({ rows: [{ id: 42 }], rowCount: 1 });
    });

    it('updates the Tariff effective_from and both season + schedule rates, guarded reporting_only', async () => {
        await new ComparisonTariffRepo().editComparisonVersion('site-1', 'EV Plan', 2, {
            buyRate: 0.31, sellRate: 0.06, effectiveFrom: '2025-06-01',
        });
        const sqls = clientQueryMock.mock.calls.map(sqlOf);
        const tariffUpd = sqls.find(s => s.includes('UPDATE "Tariff"'))!;
        expect(tariffUpd).toMatch(/effective_from/);
        expect(tariffUpd).toMatch(/reporting_only/);
        expect(tariffUpd).toMatch(/RETURNING id/);
        expect(sqls.some(s => s.includes('UPDATE "TariffSeason"'))).toBe(true);
        expect(sqls.some(s => s.includes('UPDATE "TariffSchedule"'))).toBe(true);
        expect(sqls).toContain('COMMIT');
    });

    it('rolls back without touching children when the version is not a reporting-only match', async () => {
        clientQueryMock.mockReset();
        connectMock.mockResolvedValue({ query: clientQueryMock, release: releaseMock });
        clientQueryMock.mockResolvedValue({ rows: [], rowCount: 0 }); // Tariff UPDATE matched nothing
        await new ComparisonTariffRepo().editComparisonVersion('site-1', 'Metered', 1, {
            buyRate: 0.5, sellRate: 0, effectiveFrom: null,
        });
        const sqls = clientQueryMock.mock.calls.map(sqlOf);
        expect(sqls.some(s => s.includes('UPDATE "TariffSeason"'))).toBe(false);
        expect(sqls).toContain('ROLLBACK');
    });
});

describe('ComparisonTariffRepo.deleteComparisonVersion', () => {
    function setup(deletedRow: { is_current: boolean } | null) {
        clientQueryMock.mockReset();
        connectMock.mockResolvedValue({ query: clientQueryMock, release: releaseMock });
        clientQueryMock.mockImplementation((sql: string) => {
            if (String(sql).includes('DELETE FROM "Tariff"')) {
                return Promise.resolve(deletedRow ? { rows: [deletedRow], rowCount: 1 } : { rows: [], rowCount: 0 });
            }
            return Promise.resolve({ rows: [], rowCount: 0 });
        });
    }

    it('deletes guarded by reporting_only and promotes the latest remaining when the current version was removed', async () => {
        setup({ is_current: true });
        await new ComparisonTariffRepo().deleteComparisonVersion('site-1', 'EV Plan', 2);
        const sqls = clientQueryMock.mock.calls.map(sqlOf);
        const del = sqls.find(s => s.includes('DELETE FROM "Tariff"'))!;
        expect(del).toMatch(/reporting_only/);
        expect(del).toMatch(/RETURNING is_current/);
        const promote = sqls.find(s => s.includes('SET is_current = true'))!;
        expect(promote).toMatch(/ORDER BY effective_from DESC NULLS LAST, version DESC/);
        expect(promote).toMatch(/reporting_only/);
        expect(sqls).toContain('COMMIT');
    });

    it('does not promote when the deleted version was not current', async () => {
        setup({ is_current: false });
        await new ComparisonTariffRepo().deleteComparisonVersion('site-1', 'EV Plan', 1);
        const sqls = clientQueryMock.mock.calls.map(sqlOf);
        expect(sqls.some(s => s.includes('SET is_current = true'))).toBe(false);
        expect(sqls).toContain('COMMIT');
    });

    it('rolls back when nothing matched (e.g. a metered version)', async () => {
        setup(null);
        await new ComparisonTariffRepo().deleteComparisonVersion('site-1', 'Metered', 1);
        const sqls = clientQueryMock.mock.calls.map(sqlOf);
        expect(sqls.some(s => s.includes('SET is_current = true'))).toBe(false);
        expect(sqls).toContain('ROLLBACK');
    });
});

describe('ComparisonTariffRepo.deleteComparisonPlan', () => {
    beforeEach(() => { poolQueryMock.mockReset(); });
    it('deletes all reporting-only versions for the name', async () => {
        poolQueryMock.mockResolvedValue({ rows: [], rowCount: 2 });
        await new ComparisonTariffRepo().deleteComparisonPlan('site-1', 'EV Plan');
        const sql = sqlOf(poolQueryMock.mock.calls[0]);
        expect(sql).toMatch(/DELETE FROM "Tariff"/);
        expect(sql).toMatch(/reporting_only/);
        expect(sql).not.toMatch(/version/); // whole plan, not a single version
        expect(poolQueryMock.mock.calls[0][1]).toEqual(['site-1', 'EV Plan']);
    });
});

describe('ComparisonTariffRepo.comparisonNameInUse', () => {
    beforeEach(() => { poolQueryMock.mockReset(); });
    it('returns true when a current comparison plan already has the name', async () => {
        poolQueryMock.mockResolvedValue({ rows: [{ exists: true }] });
        const used = await new ComparisonTariffRepo().comparisonNameInUse('site-1', 'EV Plan');
        expect(used).toBe(true);
        const sql = sqlOf(poolQueryMock.mock.calls[0]);
        expect(sql).toMatch(/reporting_only/);
        expect(sql).toMatch(/is_current/);
    });
});



