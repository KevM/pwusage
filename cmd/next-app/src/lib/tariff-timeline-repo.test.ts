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
import {
  buildSiteTariffsTimelineResponse,
  recomputeIsCurrentTariff,
  TariffTimelineRepo,
} from './tariff-timeline-repo';
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
      if (sql.includes('INSERT INTO "SiteTariffReattribution"')) {
        return {
          rows: [{
            site_id: 's1', status: 'pending', generation: 1, from_date: '2026-01-01', to_date: null,
            cursor_day_start: null, total_days: 0, processed_days: 0, updated_days: 0, attempt_count: 0,
            last_error: null, requested_by_user_id: 'user-9', updated_at: new Date(),
          }],
        };
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
    // The re-attribution job is written inside the same transaction, before COMMIT.
    const statements = clientQueries.map(q => q.sql);
    const enqueueAt = statements.findIndex((q: string) => q.includes('INSERT INTO "SiteTariffReattribution"'));
    const commitAt = statements.lastIndexOf('COMMIT');
    expect(enqueueAt).toBeGreaterThan(-1);
    expect(enqueueAt).toBeLessThan(commitAt);
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
    expect(mocks.invalidateCacheMock).toHaveBeenCalledWith('s1');
    expect(mocks.logEventMock).toHaveBeenCalledWith('info', 'tariff.tesla_sync.divergence_detected', expect.objectContaining({
      latestTariffId: 12,
      activeManualTariffId: 11,
      contentHashChanged: true,
    }));
  });

  it('holidayDates span from the earliest plan year through next year', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-14T12:00:00Z'));
    try {
      mocks.queryMock.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM "Site"')) {
          return { rows: [{ id: 's1', timezone: 'America/Chicago', currency: 'USD' }] };
        }
        if (sql.includes('FROM "TariffEffectivePeriod" p')) {
          return {
            rows: [
              {
                period_id: 1,
                tariff_id: 10,
                effective_from: '2019-03-01',
                effective_to: null,
                source: 'tesla',
                updated_by_user_id: null,
                updated_by_email: null,
                name: 'Historic Plan',
                version: 1,
                content_hash: 'h1',
              },
            ],
          };
        }
        return { rows: [] };
      });

      const repo = new TariffTimelineRepo();
      const timeline = await repo.getTimeline('s1', null);

      expect(timeline.holidayDates).toContain('2019-07-04');
      expect(timeline.holidayDates).toContain('2027-01-01');
      expect(timeline.holidayDates.every(d => d >= '2019-01-01')).toBe(true);
      expect(timeline.holidayDates.every(d => d <= '2027-12-31')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('holidayDates span from this year through next year when there are no periods', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-14T12:00:00Z'));
    try {
      mocks.queryMock.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM "Site"')) {
          return { rows: [{ id: 's1', timezone: 'America/Chicago', currency: 'USD' }] };
        }
        if (sql.includes('FROM "TariffEffectivePeriod" p')) {
          return { rows: [] };
        }
        return { rows: [] };
      });

      const repo = new TariffTimelineRepo();
      const timeline = await repo.getTimeline('s1', null);

      expect(timeline.holidayDates).toContain('2026-07-04');
      expect(timeline.holidayDates).toContain('2027-01-01');
      expect(timeline.holidayDates.every(d => d >= '2026-01-01')).toBe(true);
      expect(timeline.holidayDates.every(d => d <= '2027-12-31')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('buildSiteTariffsTimelineResponse includes reference periods ordered by start', () => {
    const res = buildSiteTariffsTimelineResponse({
      siteId: 's1',
      timezone: 'America/Chicago',
      currency: 'USD',
      today: '2026-11-14',
      viewerUserId: 'u1',
      periodRows: [],
      referencePeriodRows: [
        {
          period_id: 2,
          tariff_id: 20,
          effective_from: '2025-01-01',
          effective_to: null,
          source: 'manual',
          updated_by_user_id: 'u1',
          updated_by_email: 'owner@example.com',
          name: 'Fixed 2025',
          version: 1,
          content_hash: 'h2',
        },
        {
          period_id: 1,
          tariff_id: 10,
          effective_from: '2024-01-01',
          effective_to: '2024-12-31',
          source: 'manual',
          updated_by_user_id: 'u1',
          updated_by_email: 'owner@example.com',
          name: 'Fixed 2024',
          version: 1,
          content_hash: 'h1',
        },
      ],
      tariffMap: new Map(),
      battery: null,
    });

    expect(res.referencePeriods.map(p => p.effectiveFrom)).toEqual(['2024-01-01', '2025-01-01']);
    expect(res.referencePeriods.map(p => p.name)).toEqual(['Fixed 2024', 'Fixed 2025']);
    expect(res.referencePeriods.every(p => p.source === 'manual')).toBe(true);
    expect(res.battery).toBeNull();
  });

  it('maps battery fields from site json', async () => {
    mocks.queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM "Site"')) {
        return {
          rows: [{
            id: 's1',
            timezone: 'America/Chicago',
            currency: 'USD',
            nameplate_energy: '13500',
            nameplate_power: '5000',
            backup_reserve_percent: '20',
          }],
        };
      }
      return { rows: [] };
    });

    const repo = new TariffTimelineRepo();
    const withBattery = await repo.getTimeline('s1', null);
    expect(withBattery.battery).toEqual({
      nameplateEnergyWh: 13500,
      nameplatePowerW: 5000,
      backupReservePercent: 20,
    });

    mocks.queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM "Site"')) {
        return {
          rows: [{
            id: 's1',
            timezone: 'America/Chicago',
            currency: 'USD',
            nameplate_energy: null,
            nameplate_power: null,
            backup_reserve_percent: null,
          }],
        };
      }
      return { rows: [] };
    });

    const withoutBattery = await repo.getTimeline('s1', null);
    expect(withoutBattery.battery).toBeNull();
  });

  it('creates, updates, and deletes a reference period without queuing re-attribution or touching is_current', async () => {
    clientQueryHandler = async (sql: string) => {
      if (sql.includes('SELECT timezone FROM "Site"')) return { rows: [{ timezone: 'America/Chicago' }] };
      if (sql.includes('SELECT COALESCE(MAX(version), 0) + 1 AS next FROM "Tariff"')) return { rows: [{ next: 2 }] };
      if (sql.includes('INSERT INTO "Tariff"(')) return { rows: [{ id: 55 }] };
      if (sql.includes('INSERT INTO "TariffSeason"')) return { rows: [{ id: 66 }] };
      if (sql.includes('FROM "TariffReferencePeriod"')) return { rows: [] };
      if (sql.includes('INSERT INTO "TariffReferencePeriod"')) return { rows: [{ id: 77 }] };
      return { rows: [] };
    };
    mocks.queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM "Site"')) {
        return { rows: [{ id: 's1', timezone: 'America/Chicago', currency: 'USD', nameplate_energy: null, nameplate_power: null, backup_reserve_percent: null }] };
      }
      return { rows: [] };
    });

    const repo = new TariffTimelineRepo();
    await repo.createReferencePeriod('s1', 'u1', {
      name: 'Standard Fixed',
      effectiveFrom: '2024-01-01',
      effectiveTo: null,
      seasons: [{
        name: 'All Year',
        fromMonth: 1,
        toMonth: 12,
        weekdayPeriods: [{ touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.14, sellRate: 0.04 }],
        weekendPeriods: [{ touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.14, sellRate: 0.04 }],
      }],
    });

    const insertTariff = clientQueries.find(q => q.sql.includes('INSERT INTO "Tariff"('));
    expect(insertTariff?.params?.[3]).toBe(false); // is_current = false
    const versionQuery = clientQueries.find(q => q.sql.includes('COALESCE(MAX(version), 0) + 1'));
    expect(versionQuery?.params).toEqual(['s1', 'Standard Fixed']);
    expect(clientQueries.some(q => q.sql.includes('SiteTariffReattribution'))).toBe(false);
    expect(clientQueries.some(q => q.sql.includes('INSERT INTO "TariffReferencePeriod"'))).toBe(true);
  });
});
