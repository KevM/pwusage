import { beforeEach, describe, expect, it, vi } from 'vitest';

const { connectMock, clientQueryMock, releaseMock, queryMock, invalidateCacheMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  connectMock: vi.fn(),
  clientQueryMock: vi.fn(),
  releaseMock: vi.fn(),
  invalidateCacheMock: vi.fn(),
}));

vi.mock('./db', () => ({
  pool: {
    connect: connectMock,
    query: queryMock,
  },
}));

vi.mock('./site-repo', () => ({
  SiteRepo: class {
    invalidateCache = invalidateCacheMock;
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

  it('appends a new version and updates is_current via effective periods without deleting', async () => {
    clientQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes(`source = 'tesla'`)) return { rows: [{ id: 1, content_hash: 'STALE' }] };
      if (sql.includes('MAX(version)')) return { rows: [{ next: 2 }] };
      if (sql.includes('INSERT INTO "Tariff"(')) return { rows: [{ id: 8 }] };
      if (sql.includes('INSERT INTO "TariffSeason"(')) return { rows: [{ id: 80 }] };
      if (sql.includes('SELECT timezone FROM "Site"')) return { rows: [{ timezone: 'America/Los_Angeles' }] };
      if (sql.includes('FROM "TariffEffectivePeriod"') && sql.includes('ORDER BY effective_from ASC')) return { rows: [] };
      if (sql.includes('INSERT INTO "TariffEffectivePeriod"')) return { rows: [{ id: 12 }] };
      if (sql.includes('INSERT INTO "SiteTariffReattribution"')) {
        return { rows: [{ status: 'pending', from_date: '2026-11-12', to_date: null, total_days: 0, processed_days: 0, updated_days: 0, last_error: null, updated_at: new Date() }] };
      }
      if (sql.includes('FROM "TariffEffectivePeriod"') && sql.includes('effective_from <=')) return { rows: [{ tariff_id: 8 }] };
      return { rows: [] };
    });

    await new TariffRepo().addTariffVersion('site-1', parsed);

    const sqls = clientQueryMock.mock.calls.map(sqlOf);
    expect(sqls.some((s) => s.includes('DELETE FROM "Tariff"'))).toBe(false);
    expect(sqls.some((s) => s.includes('UPDATE "Tariff" SET is_current = FALSE'))).toBe(true);
    expect(sqls.some((s) => s.includes('UPDATE "Tariff" SET is_current = TRUE'))).toBe(true);
    expect(sqls.some((s) => s.includes('INSERT INTO "Tariff"(') && s.includes('is_current'))).toBe(true);
    expect(sqls.some((s) => s.includes('COMMIT'))).toBe(true);
    // The re-attribution job is queued in the same transaction, before it commits.
    const enqueueAt = sqls.findIndex((s) => s.includes('INSERT INTO "SiteTariffReattribution"'));
    expect(enqueueAt).toBeGreaterThan(-1);
    expect(enqueueAt).toBeLessThan(sqls.findIndex((s) => s.includes('COMMIT')));
    expect(invalidateCacheMock).toHaveBeenCalledWith('site-1');
  });

  it('is a no-op when the latest tesla version already has the same content_hash', async () => {
    const { tariffContentHash } = await import('./importer/tariff-parser');
    const matching = tariffContentHash(parsed);
    clientQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes(`source = 'tesla'`)) return { rows: [{ id: 1, content_hash: matching }] };
      return { rows: [] };
    });

    await new TariffRepo().addTariffVersion('site-1', parsed);

    const sqls = clientQueryMock.mock.calls.map(sqlOf);
    expect(sqls.some((s) => s.includes('INSERT INTO "Tariff"('))).toBe(false);
    expect(sqls.some((s) => s.includes('SET is_current = FALSE'))).toBe(false);
    expect(invalidateCacheMock).not.toHaveBeenCalled();
  });

  it('does not overwrite an active owner-selected public plan (source: estimated, choice_kind: owner)', async () => {
    clientQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes(`source = 'tesla'`)) return { rows: [{ id: 1, content_hash: 'OLD_TESLA' }] };
      if (sql.includes('MAX(version)')) return { rows: [{ next: 2 }] };
      if (sql.includes('INSERT INTO "Tariff"(')) return { rows: [{ id: 9 }] };
      if (sql.includes('INSERT INTO "TariffSeason"(')) return { rows: [{ id: 90 }] };
      if (sql.includes('SELECT timezone FROM "Site"')) return { rows: [{ timezone: 'America/Chicago' }] };
      if (sql.includes('FROM "TariffEffectivePeriod"')) {
        return {
          rows: [{
            id: 21,
            tariff_id: 15,
            source: 'estimated',
            effective_from: '2025-01-01',
            effective_to: null,
            updated_by_user_id: 'u1',
            selection_id: 55,
            choice_kind: 'owner',
          }],
        };
      }
      return { rows: [] };
    });

    const changed = await new TariffRepo().addTariffVersion('site-1', parsed);

    expect(changed).toBe(true);
    const sqls = clientQueryMock.mock.calls.map(sqlOf);
    expect(sqls.some((s) => s.includes('INSERT INTO "TariffEffectivePeriod"'))).toBe(false);
    expect(sqls.some((s) => s.includes('DELETE FROM "TariffEffectivePeriod"'))).toBe(false);
  });

  it('does not overwrite an active restored saved Tesla plan (source: tesla, choice_kind: owner)', async () => {
    clientQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes(`source = 'tesla'`)) return { rows: [{ id: 1, content_hash: 'OLD_TESLA' }] };
      if (sql.includes('MAX(version)')) return { rows: [{ next: 3 }] };
      if (sql.includes('INSERT INTO "Tariff"(')) return { rows: [{ id: 10 }] };
      if (sql.includes('INSERT INTO "TariffSeason"(')) return { rows: [{ id: 91 }] };
      if (sql.includes('SELECT timezone FROM "Site"')) return { rows: [{ timezone: 'America/Chicago' }] };
      if (sql.includes('FROM "TariffEffectivePeriod"')) {
        return {
          rows: [{
            id: 22,
            tariff_id: 1,
            source: 'tesla',
            effective_from: '2025-01-01',
            effective_to: null,
            updated_by_user_id: 'u1',
            selection_id: 56,
            choice_kind: 'owner',
          }],
        };
      }
      return { rows: [] };
    });

    const changed = await new TariffRepo().addTariffVersion('site-1', parsed);

    expect(changed).toBe(true);
    const sqls = clientQueryMock.mock.calls.map(sqlOf);
    expect(sqls.some((s) => s.includes('INSERT INTO "TariffEffectivePeriod"'))).toBe(false);
    expect(sqls.some((s) => s.includes('DELETE FROM "TariffEffectivePeriod"'))).toBe(false);
  });

  it('caps a new automatic Tesla span before a future owner-selected public plan', async () => {
    clientQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes(`source = 'tesla'`)) return { rows: [{ id: 1, content_hash: 'OLD_TESLA' }] };
      if (sql.includes('MAX(version)')) return { rows: [{ next: 2 }] };
      if (sql.includes('INSERT INTO "Tariff"(')) return { rows: [{ id: 12 }] };
      if (sql.includes('INSERT INTO "TariffSeason"(')) return { rows: [{ id: 92 }] };
      if (sql.includes('SELECT timezone FROM "Site"')) return { rows: [{ timezone: 'UTC' }] };
      if (sql.includes('FROM "TariffEffectivePeriod"') && sql.includes('ORDER BY effective_from ASC')) {
        return {
          rows: [{
            id: 30,
            tariff_id: 18,
            source: 'estimated',
            effective_from: '2099-06-01',
            effective_to: null,
            updated_by_user_id: 'u1',
            selection_id: 77,
            choice_kind: 'owner',
          }],
        };
      }
      if (sql.includes('INSERT INTO "TariffSelection"')) return { rows: [{ id: 99 }] };
      if (sql.includes('INSERT INTO "TariffEffectivePeriod"')) return { rows: [{ id: 31 }] };
      if (sql.includes('INSERT INTO "SiteTariffReattribution"')) {
        return { rows: [{ status: 'pending', from_date: '2026-11-17', to_date: '2099-05-31', total_days: 0, processed_days: 0, updated_days: 0, last_error: null, updated_at: new Date() }] };
      }
      return { rows: [] };
    });

    await new TariffRepo().addTariffVersion('site-1', parsed);

    const periodInsert = clientQueryMock.mock.calls.find(c => sqlOf(c).includes('INSERT INTO "TariffEffectivePeriod"'));
    expect(periodInsert).toBeDefined();
    expect(periodInsert?.[1]?.[3]).toBe('2099-05-31');
    expect(periodInsert?.[1]?.[6]).toBe(99);
  });
});

it('resolves inherited rates in historical schedules without filtering out old tariff versions', async () => {
  queryMock.mockResolvedValueOnce({ rows: [] });
  await new TariffRepo().getSchedulesForSite('site');
  const sql = String(queryMock.mock.calls.at(-1)?.[0]);
  expect(sql).toContain('COALESCE(ts.buy_rate, s.buy_rate) AS buy_rate');
  expect(sql).toContain('COALESCE(ts.sell_rate, s.sell_rate) AS sell_rate');
  expect(sql).not.toContain('is_current');
});
