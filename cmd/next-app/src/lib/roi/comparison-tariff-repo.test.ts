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
