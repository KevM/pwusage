import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  connectMock: vi.fn(),
  queryMock: vi.fn(),
  invalidateCacheMock: vi.fn(),
  logEventMock: vi.fn(),
}));

vi.mock('./db', () => ({
  pool: {
    connect: mocks.connectMock,
    query: mocks.queryMock,
  },
}));

vi.mock('./site-repo', () => ({
  SiteRepo: class {
    invalidateCache = mocks.invalidateCacheMock;
  },
}));

vi.mock('./observability', () => ({
  accountFingerprint: (id: string) => `fp_${id}`,
  logEvent: mocks.logEventMock,
}));

import { TariffRepo } from './tariff-repo';
import { recomputeIsCurrentTariff, TariffTimelineRepo } from './tariff-timeline-repo';
import { TariffValidationError } from './tariff-timeline';
import type { PoolClient } from 'pg';

describe('TariffTimelineRepo & recomputeIsCurrentTariff (unit)', () => {
  const clientQueries: Array<{ sql: string; params?: unknown[] }> = [];
  let clientQueryHandler: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number }>;

  const fakeClient = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      clientQueries.push({ sql, params });
      return clientQueryHandler(sql, params);
    }),
    release: vi.fn(),
  } as unknown as PoolClient;

  beforeEach(() => {
    vi.clearAllMocks();
    clientQueries.length = 0;
    mocks.connectMock.mockResolvedValue(fakeClient);
    clientQueryHandler = async () => ({ rows: [], rowCount: 0 });
  });

  it('recomputeIsCurrentTariff demotes old is_current rows before promoting the new target', async () => {
    clientQueryHandler = async (sql: string) => {
      if (sql.includes('FROM "TariffEffectivePeriod"') && sql.includes('effective_from <=')) {
        return { rows: [{ tariff_id: 42 }] };
      }
      return { rows: [] };
    };

    const result = await recomputeIsCurrentTariff(fakeClient, 's1', '2026-11-11');
    expect(result).toBe(42);
    const demoteIdx = clientQueries.findIndex(q => q.sql.includes('SET is_current = FALSE'));
    const promoteIdx = clientQueries.findIndex(q => q.sql.includes('SET is_current = TRUE'));
    expect(demoteIdx).toBeGreaterThan(-1);
    expect(promoteIdx).toBeGreaterThan(demoteIdx);
  });

  it('createManualPeriod validates, enforces span cap, demotes before promote, invalidates cache, and logs accountFingerprint', async () => {
    clientQueryHandler = async (sql: string) => {
      if (sql.includes('FROM "Site" WHERE id = $1 FOR UPDATE')) {
        return { rows: [{ timezone: 'America/Chicago' }] };
      }
      if (sql.includes('COALESCE(MAX(version), 0) + 1')) return { rows: [{ next: 2 }] };
      if (sql.includes('INSERT INTO "Tariff"(')) return { rows: [{ id: 101 }] };
      if (sql.includes('INSERT INTO "TariffSeason"(')) return { rows: [{ id: 201 }] };
      if (sql.includes('FROM "TariffEffectivePeriod"') && sql.includes('ORDER BY effective_from ASC')) {
        return {
          rows: [{
            id: 10,
            tariff_id: 50,
            source: 'tesla',
            effective_from: '2024-01-01',
            effective_to: null,
            updated_by_user_id: null,
          }],
        };
      }
      if (sql.includes('INSERT INTO "TariffEffectivePeriod"')) return { rows: [{ id: 11 }] };
      if (sql.includes('FROM "TariffEffectivePeriod"') && sql.includes('effective_from <= $2::date')) {
        return { rows: [{ tariff_id: 101 }] };
      }
      return { rows: [] };
    };

    mocks.queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM "Site"')) {
        return { rows: [{ id: 's1', timezone: 'America/Chicago', currency: 'USD' }] };
      }
      if (sql.includes('FROM "TariffEffectivePeriod" p')) {
        return {
          rows: [{
            period_id: 11,
            tariff_id: 101,
            effective_from: '2026-01-01',
            effective_to: null,
            source: 'manual',
            updated_by_user_id: 'user-9',
            updated_by_email: 'owner@example.com',
            name: 'Exact 2026',
            version: 2,
            content_hash: 'h2',
          }],
        };
      }
      if (sql.includes('FROM "TariffSeason"')) {
        return {
          rows: [{ id: 201, tariff_id: 101, name: 'All Year', from_month: 1, from_day: 1, to_month: 12, to_day: 31, buy_rate: 0.10279, sell_rate: 0.03289 }],
        };
      }
      if (sql.includes('FROM "TariffSchedule"')) {
        return {
          rows: [{ id: 301, season_id: 201, name: 'OFF_PEAK', buy_rate: 0.10279, sell_rate: 0.03289, from_day_of_week: 0, to_day_of_week: 6, from_hour: 0, from_minute: 0, to_hour: 24, to_minute: 0 }],
        };
      }
      return { rows: [] };
    });

    const repo = new TariffTimelineRepo();
    const timeline = await repo.createManualPeriod('s1', 'user-9', {
      name: 'Exact 2026',
      effectiveFrom: '2026-01-01',
      effectiveTo: null,
      seasons: [{
        name: 'All Year',
        fromMonth: 1,
        toMonth: 12,
        weekdayPeriods: [{ touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.10279, sellRate: 0.03289 }],
        weekendPeriods: [{ touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.10279, sellRate: 0.03289 }],
      }],
    });

    expect(timeline.version).toBe(2);
    expect(timeline.periods[0].updatedBy).toEqual({ email: 'owner@example.com', isCurrentUser: true });
    expect(mocks.invalidateCacheMock).toHaveBeenCalledWith('s1');
    expect(mocks.logEventMock).toHaveBeenCalledWith('info', 'tariff.period.created', expect.objectContaining({
      accountId: 'fp_user-9',
      source: 'manual',
    }));
  });

  it('rejects edits exceeding MAX_EFFECTIVE_PERIODS_PER_SITE', async () => {
    const fiftySpans = Array.from({ length: 50 }, (_, idx) => ({
      id: idx + 1,
      tariff_id: 50,
      source: 'tesla',
      effective_from: `2024-${String(Math.floor(idx / 28) + 1).padStart(2, '0')}-${String((idx % 28) + 1).padStart(2, '0')}`,
      effective_to: idx === 49 ? null : `2024-${String(Math.floor(idx / 28) + 1).padStart(2, '0')}-${String((idx % 28) + 1).padStart(2, '0')}`,
      updated_by_user_id: null,
    }));
    // Make span 50 span 2026 so splitting it creates 52 rows (> 50)
    fiftySpans[49].effective_from = '2025-01-01';
    fiftySpans[49].effective_to = null;

    clientQueryHandler = async (sql: string) => {
      if (sql.includes('FROM "Site" WHERE id = $1 FOR UPDATE')) return { rows: [{ timezone: 'America/Chicago' }] };
      if (sql.includes('COALESCE(MAX(version), 0) + 1')) return { rows: [{ next: 2 }] };
      if (sql.includes('INSERT INTO "Tariff"(')) return { rows: [{ id: 101 }] };
      if (sql.includes('INSERT INTO "TariffSeason"(')) return { rows: [{ id: 201 }] };
      if (sql.includes('FROM "TariffEffectivePeriod"') && sql.includes('ORDER BY effective_from ASC')) return { rows: fiftySpans };
      return { rows: [] };
    };

    await expect(new TariffTimelineRepo().createManualPeriod('s1', 'u1', {
      name: 'Split Over Limit',
      effectiveFrom: '2026-01-01',
      effectiveTo: '2026-06-01',
      seasons: [{
        name: 'All Year',
        fromMonth: 1,
        toMonth: 12,
        weekdayPeriods: [{ touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.1, sellRate: 0.03 }],
        weekendPeriods: [{ touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.1, sellRate: 0.03 }],
      }],
    })).rejects.toThrow(TariffValidationError);
  });

  it('TariffRepo.addTariffVersion keeps active manual period intact and records divergence', async () => {
    clientQueryHandler = async (sql: string) => {
      if (sql.includes('source = \'tesla\'')) return { rows: [{ id: 10, content_hash: 'old_tesla_hash' }] };
      if (sql.includes('COALESCE(MAX(version), 0) + 1')) return { rows: [{ next: 3 }] };
      if (sql.includes('INSERT INTO "Tariff"(')) return { rows: [{ id: 12 }] };
      if (sql.includes('INSERT INTO "TariffSeason"(')) return { rows: [{ id: 22 }] };
      if (sql.includes('SELECT timezone FROM "Site"')) return { rows: [{ timezone: 'America/Chicago' }] };
      if (sql.includes('FROM "TariffEffectivePeriod"')) {
        return {
          rows: [{
            id: 5,
            tariff_id: 11,
            source: 'manual',
            effective_from: '2025-01-01',
            effective_to: null,
            updated_by_user_id: 'u1',
          }],
        };
      }
      return { rows: [] };
    };

    await new TariffRepo().addTariffVersion('s1', {
      name: 'Utility Updated',
      seasons: [{
        name: 'All Year', from_month: 1, from_day: 1, to_month: 12, to_day: 31, buy_rate: 0.12, sell_rate: 0.03,
        schedules: [{ name: 'OFF_PEAK', buy_rate: 0.12, sell_rate: 0.03, from_day_of_week: 0, to_day_of_week: 6, from_hour: 0, from_minute: 0, to_hour: 24, to_minute: 0 }],
      }],
    });

    expect(clientQueries.some(q => q.sql.includes('INSERT INTO "TariffEffectivePeriod"'))).toBe(false);
    expect(clientQueries.some(q => q.sql.includes('SET is_current = FALSE'))).toBe(false);
    expect(mocks.invalidateCacheMock).toHaveBeenCalledWith('s1');
    expect(mocks.logEventMock).toHaveBeenCalledWith('info', 'tariff.tesla_sync.divergence_detected', expect.objectContaining({
      latestTariffId: 12,
      activeManualTariffId: 11,
      contentHashChanged: true,
    }));
  });
});
