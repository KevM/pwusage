import { beforeEach, describe, expect, it, vi } from 'vitest';

const { connectMock, clientQueryMock, releaseMock, poolQueryMock } = vi.hoisted(() => ({
    connectMock: vi.fn(), clientQueryMock: vi.fn(), releaseMock: vi.fn(), poolQueryMock: vi.fn(),
}));

vi.mock('../db', () => ({ pool: { connect: connectMock, query: poolQueryMock } }));

import { ComparisonTariffRepo } from './comparison-tariff-repo';

function sqlOf(call: unknown[]): string { return String(call[0]); }



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

describe('ComparisonTariffRepo.getPlanStructure', () => {
    beforeEach(() => { poolQueryMock.mockReset(); });

    it('assembles seasons + windows for (site, name, version) without a reporting_only guard', async () => {
        poolQueryMock.mockResolvedValue({ rows: [
            { tariff_name: 'EV', season_id: 1, season_name: 'All Year', from_month: 1, from_day: 1, to_month: 12, to_day: 31,
              season_buy_rate: 0, season_sell_rate: 0, schedule_id: 10, schedule_name: 'Peak',
              schedule_buy_rate: 0.45, schedule_sell_rate: 0.06, from_day_of_week: 0, to_day_of_week: 4,
              from_hour: 16, from_minute: 0, to_hour: 21, to_minute: 0 },
            { tariff_name: 'EV', season_id: 1, season_name: 'All Year', from_month: 1, from_day: 1, to_month: 12, to_day: 31,
              season_buy_rate: 0, season_sell_rate: 0, schedule_id: 11, schedule_name: 'Off',
              schedule_buy_rate: 0.18, schedule_sell_rate: 0.06, from_day_of_week: 0, to_day_of_week: 6,
              from_hour: 0, from_minute: 0, to_hour: 24, to_minute: 0 },
        ] });
        const out = await new ComparisonTariffRepo().getPlanStructure('site-1', 'EV', 2);
        const sql = sqlOf(poolQueryMock.mock.calls[0]);
        expect(sql).not.toMatch(/reporting_only/);  // reads span metered + comparison
        expect(sql).toMatch(/version = \$3/);
        expect(out?.name).toBe('EV');
        expect(out?.seasons.length).toBe(1);
        expect(out?.seasons[0].schedules.length).toBe(2);
        expect(out?.seasons[0].schedules[0].buy_rate).toBe(0.45);
    });

    it('returns null when nothing matches', async () => {
        poolQueryMock.mockResolvedValue({ rows: [] });
        const out = await new ComparisonTariffRepo().getPlanStructure('site-1', 'Nope', 1);
        expect(out).toBeNull();
    });
});

describe('ComparisonTariffRepo.saveComparisonStructure', () => {
    const seasons = [{
        name: 'All Year', from_month: 1, from_day: 1, to_month: 12, to_day: 31, buy_rate: 0, sell_rate: 0,
        schedules: [
            { name: 'Peak', buy_rate: 0.45, sell_rate: 0.06, from_day_of_week: 0, to_day_of_week: 4, from_hour: 16, from_minute: 0, to_hour: 21, to_minute: 0 },
            { name: 'Off', buy_rate: 0.18, sell_rate: 0.06, from_day_of_week: 0, to_day_of_week: 6, from_hour: 0, from_minute: 0, to_hour: 24, to_minute: 0 },
        ],
    }];

    beforeEach(() => {
        clientQueryMock.mockReset();
        connectMock.mockResolvedValue({ query: clientQueryMock, release: releaseMock });
        clientQueryMock.mockResolvedValue({ rows: [{ next: 3, id: 42 }], rowCount: 1 });
    });

    it('create: demotes current, inserts a reporting-only Tariff + season + each window', async () => {
        await new ComparisonTariffRepo().saveComparisonStructure('site-1', 'EV', '2025-01-01', seasons, 'create');
        const sqls = clientQueryMock.mock.calls.map(sqlOf);
        expect(sqls.find(s => s.includes('SET is_current = false'))).toMatch(/reporting_only/);
        expect(sqls.find(s => s.includes('INSERT INTO "Tariff"'))).toMatch(/reporting_only/);
        expect(sqls.some(s => s.includes('INSERT INTO "TariffSeason"'))).toBe(true);
        const insertScheduleCalls = sqls.filter(s => s.includes('INSERT INTO "TariffSchedule"'));
        expect(insertScheduleCalls.length).toBe(2); // two windows
        expect(sqls).toContain('COMMIT');
    });

    it('replace: deletes the version\'s existing seasons (guarded reporting_only) then re-inserts', async () => {
        await new ComparisonTariffRepo().saveComparisonStructure('site-1', 'EV', '2025-01-01', seasons, 'replace', 2);
        const sqls = clientQueryMock.mock.calls.map(sqlOf);
        const del = sqls.find(s => s.includes('DELETE FROM "TariffSeason"'));
        expect(del).toMatch(/reporting_only/);
        expect(del).toMatch(/version = \$3/);
        expect(sqls.some(s => s.includes('INSERT INTO "TariffSeason"'))).toBe(true);
        expect(sqls).toContain('COMMIT');
    });

    it('canonicalizes an all-same-rate season to a single window before persisting', async () => {
        const flatish = [{
            name: 'All Year', from_month: 1, from_day: 1, to_month: 12, to_day: 31, buy_rate: 0, sell_rate: 0,
            schedules: [
                { name: 'A', buy_rate: 0.2, sell_rate: 0.05, from_day_of_week: 0, to_day_of_week: 6, from_hour: 0, from_minute: 0, to_hour: 16, to_minute: 0 },
                { name: 'B', buy_rate: 0.2, sell_rate: 0.05, from_day_of_week: 0, to_day_of_week: 6, from_hour: 16, from_minute: 0, to_hour: 24, to_minute: 0 },
            ],
        }];
        await new ComparisonTariffRepo().saveComparisonStructure('site-1', 'Flat', null, flatish, 'create');
        const sqls = clientQueryMock.mock.calls.map(sqlOf);
        expect(sqls.filter(s => s.includes('INSERT INTO "TariffSchedule"')).length).toBe(1); // collapsed
    });
});

describe('ComparisonTariffRepo.renameComparisonPlan', () => {
    beforeEach(() => { poolQueryMock.mockReset(); });
    it('renames all reporting-only versions of the name, guarded reporting_only', async () => {
        poolQueryMock.mockResolvedValue({ rows: [], rowCount: 2 });
        await new ComparisonTariffRepo().renameComparisonPlan('site-1', 'Old', 'New');
        const sql = sqlOf(poolQueryMock.mock.calls[0]);
        expect(sql).toMatch(/UPDATE "Tariff" SET name = \$3/);
        expect(sql).toMatch(/reporting_only/);
        expect(poolQueryMock.mock.calls[0][1]).toEqual(['site-1', 'Old', 'New']);
    });
});

describe('ComparisonTariffRepo.listFixedComparisons kind', () => {
    beforeEach(() => { poolQueryMock.mockReset(); });
    it('marks a version TOU when its windows have differing buy rates, else fixed', async () => {
        poolQueryMock.mockResolvedValue({ rows: [
            { name: 'EV', version: 2, is_current: true, effective_from: '2025-01-01', buy_rate: 0, sell_rate: 0, distinct_buy_rates: 2 },
            { name: 'Flat', version: 1, is_current: true, effective_from: null, buy_rate: 0.2, sell_rate: 0.05, distinct_buy_rates: 1 },
        ] });
        const plans = await new ComparisonTariffRepo().listFixedComparisons('site-1');
        const ev = plans.find(p => p.name === 'EV')!;
        const flat = plans.find(p => p.name === 'Flat')!;
        expect(ev.versions[0].kind).toBe('tou');
        expect(flat.versions[0].kind).toBe('fixed');
    });
});






