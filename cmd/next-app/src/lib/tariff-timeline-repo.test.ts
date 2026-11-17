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
  applyTariffSelectionOnClient,
  buildSiteTariffsTimelineResponse,
  loadRestorationTargets,
  loadScopeSelectionSpans,
  recomputeIsCurrentTariff,
  TariffTimelineRepo,
} from './tariff-timeline-repo';
import { TariffValidationError } from './tariff-timeline';
import { buildTariffSelectionPreview } from './tariff-selection';
import type { TariffSeasonInput } from './tariff-contract';
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
        return { rows: [{ id: 's1', timezone: 'America/Chicago', installed: '2023-11-14T08:00:00Z', currency: 'USD' }] };
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
          return { rows: [{ id: 's1', timezone: 'America/Chicago', installed: '2023-11-14T08:00:00Z', currency: 'USD' }] };
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
          return { rows: [{ id: 's1', timezone: 'America/Chicago', installed: '2023-11-14T08:00:00Z', currency: 'USD' }] };
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
      siteInstalled: '2023-11-14',
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
            installed: '2023-11-14T08:00:00Z',
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
            installed: '2023-11-14T08:00:00Z',
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
        return { rows: [{ id: 's1', timezone: 'America/Chicago', installed: '2023-11-14T08:00:00Z', currency: 'USD', nameplate_energy: null, nameplate_power: null, backup_reserve_percent: null }] };
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
    expect(clientQueries.some(q => q.sql.includes('UPDATE "Tariff" SET is_current'))).toBe(false);
    expect(clientQueries.some(q => q.sql.includes('"TariffEffectivePeriod"'))).toBe(false);
    expect(clientQueries.some(q => q.sql.includes('SiteTariffReattribution'))).toBe(false);
    expect(clientQueries.some(q => q.sql.includes('INSERT INTO "TariffReferencePeriod"'))).toBe(true);
  });

  it('includes system costs and the site install date', async () => {
    mocks.queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM "Site"')) {
        return { rows: [{ id: 's1', timezone: 'America/Los_Angeles', installed: '2023-11-14T08:00:00Z', currency: 'USD', nameplate_energy: null, nameplate_power: null, backup_reserve_percent: null }] };
      }
      if (sql.includes('FROM "SiteSystemCost"')) {
        return { rows: [{ component: 'solar', install_date: '2023-11-14', price: '24000.00', tax_credit_percent: '30.00', incentives: '0.00' }] };
      }
      return { rows: [] };
    });

    const res = await new TariffTimelineRepo().getTimeline('s1', null);
    expect(res.systemCosts).toEqual({
      siteInstalled: '2023-11-14',
      solar: { installDate: '2023-11-14', price: 24000, taxCreditPercent: 30, incentives: 0 },
      powerwall: null,
    });
  });

  it('system costs default to null components', async () => {
    mocks.queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM "Site"')) {
        return { rows: [{ id: 's1', timezone: 'America/Chicago', installed: '2023-11-14T08:00:00Z', currency: 'USD', nameplate_energy: null, nameplate_power: null, backup_reserve_percent: null }] };
      }
      return { rows: [] };
    });

    const res = await new TariffTimelineRepo().getTimeline('s1', null);
    expect(res.systemCosts.solar).toBeNull();
    expect(res.systemCosts.powerwall).toBeNull();
  });

  it('saves system costs, upserting present components and deleting null ones in one transaction', async () => {
    clientQueryHandler = async (sql: string) => {
      if (sql.includes('FROM "Site" WHERE id = $1 FOR UPDATE')) return { rows: [{ id: 's1' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    };
    mocks.queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM "Site"')) {
        return { rows: [{ id: 's1', timezone: 'America/Chicago', installed: '2023-11-14T08:00:00Z', currency: 'USD', nameplate_energy: null, nameplate_power: null, backup_reserve_percent: null }] };
      }
      return { rows: [] };
    });

    await new TariffTimelineRepo().saveSystemCosts('s1', 'u1', {
      solar: { installDate: '2023-11-14', price: 24000, taxCreditPercent: 30, incentives: 0 },
      powerwall: null,
    });

    const upsert = clientQueries.find(q => q.sql.includes('INSERT INTO "SiteSystemCost"'));
    expect(upsert?.params).toEqual(['s1', 'solar', '2023-11-14', 24000, 30, 0, 'u1']);
    const deletes = clientQueries.filter(q => q.sql.includes('DELETE FROM "SiteSystemCost"'));
    expect(deletes.map(q => q.params)).toEqual([['s1', 'powerwall']]);
    expect(clientQueries.some(q => q.sql === 'COMMIT')).toBe(true);
    expect(clientQueries.some(q => q.sql.includes('SiteTariffReattribution'))).toBe(false);
  });

  it('buildSiteTariffsTimelineResponse retains choiceKind and displays verification only when exact hash and range match', () => {
    const res = buildSiteTariffsTimelineResponse({
      siteId: 's1',
      timezone: 'America/Chicago',
      siteInstalled: '2023-11-14',
      currency: 'USD',
      today: '2026-11-17',
      viewerUserId: 'u2',
      periodRows: [
        {
          period_id: 1,
          tariff_id: 10,
          effective_from: '2025-01-01',
          effective_to: '2025-05-31',
          source: 'estimated',
          updated_by_user_id: 'u1',
          updated_by_email: 'owner@example.com',
          name: 'Public Split Fragment',
          version: 1,
          content_hash: 'hash-a',
          selection_id: 50,
          choice_kind: 'owner',
          urdb_label: 'urdb-a',
          verified_at: '2025-02-01T00:00:00Z',
          verified_by_user_id: 'u1',
          verified_by_email: 'owner@example.com',
          verified_tariff_id: 10,
          verified_content_hash: 'hash-a',
          verified_effective_from: '2025-01-01',
          verified_effective_to: '2025-12-31',
        } as never,
        {
          period_id: 2,
          tariff_id: 11,
          effective_from: '2025-06-01',
          effective_to: null,
          source: 'manual',
          updated_by_user_id: 'u1',
          updated_by_email: 'owner@example.com',
          name: 'Exact Verified Plan',
          version: 1,
          content_hash: 'hash-b',
          selection_id: 51,
          choice_kind: 'owner',
          verified_at: '2025-06-02T00:00:00Z',
          verified_by_user_id: 'u1',
          verified_by_email: 'owner@example.com',
          verified_tariff_id: 11,
          verified_content_hash: 'hash-b',
          verified_effective_from: '2025-06-01',
          verified_effective_to: null,
        } as never,
      ],
      tariffMap: new Map(),
    });

    const split = res.periods[0] as unknown as Record<string, unknown>;
    expect(split.choiceKind).toBe('owner');
    expect(split.selectionId).toBe(50);
    expect(split.verification).toBeNull();

    const exact = res.periods[1] as unknown as Record<string, unknown>;
    expect(exact.choiceKind).toBe('owner');
    expect(exact.selectionId).toBe(51);
    expect(exact.verification).toEqual({
      verifiedAt: '2025-06-02T00:00:00.000Z',
      verifiedByEmail: 'owner@example.com',
      verifiedByCurrentUser: false,
    });

    const contentChanged = buildSiteTariffsTimelineResponse({
      siteId: 's1',
      timezone: 'America/Chicago',
      siteInstalled: '2023-11-14',
      currency: 'USD',
      today: '2026-11-17',
      viewerUserId: 'u1',
      periodRows: [
        {
          period_id: 3,
          tariff_id: 12,
          effective_from: '2025-06-01',
          effective_to: null,
          source: 'estimated',
          updated_by_user_id: 'u1',
          updated_by_email: 'owner@example.com',
          name: 'Changed Content Plan',
          version: 2,
          content_hash: 'hash-new',
          selection_id: 52,
          choice_kind: 'owner',
          verified_at: '2025-06-02T00:00:00Z',
          verified_by_user_id: 'u1',
          verified_by_email: 'owner@example.com',
          verified_tariff_id: 12,
          verified_content_hash: 'hash-old',
          verified_effective_from: '2025-06-01',
          verified_effective_to: null,
        } as never,
      ],
      tariffMap: new Map(),
    });
    expect(contentChanged.periods[0].verification).toBeNull();
  });

  const sampleSeasons: TariffSeasonInput[] = [
    {
      name: 'All Year',
      fromMonth: 1,
      fromDay: 1,
      toMonth: 12,
      toDay: 31,
      weekdayPeriods: [{ touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.12, sellRate: 0.04 }],
      weekendPeriods: [{ touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.12, sellRate: 0.04 }],
    },
  ];

  it('applyTariffSelectionOnClient avoids manufacturing duplicate Tariff versions on unchanged saves', async () => {
    clientQueryHandler = async (sql: string) => {
      if (sql.includes('FROM "TariffEffectivePeriod"') && sql.includes('ORDER BY effective_from ASC')) {
        return {
          rows: [{
            id: 10,
            tariff_id: 88,
            source: 'estimated',
            effective_from: '2025-01-01',
            effective_to: null,
            updated_by_user_id: 'u1',
            selection_id: 500,
            choice_kind: 'owner',
          }],
        };
      }
      if (sql.includes('LEFT JOIN "TariffUrdbSource" u ON u.tariff_id = t.id')) {
        return { rows: [{ id: 88, has_urdb: true }] };
      }
      if (sql.includes('FROM "TariffSelection" WHERE id = $1')) {
        return {
          rows: [{
            urdb_label: 'urdb-tou-1',
            utility_name: 'Demo Utility',
            revision_start: '2025-01-01',
            export_rate_provenance: 'published',
            holidays_use_weekend: true,
          }],
        };
      }
      if (sql.includes('FROM "TariffSelectionVerification"')) {
        return { rows: [{ verified_by_user_id: 'u1' }] };
      }
      return { rows: [] };
    };

    const result = await applyTariffSelectionOnClient(fakeClient, 's1', '2026-11-17', {
      scope: 'actual',
      effectiveFrom: '2025-01-01',
      effectiveTo: null,
      userId: 'u1',
      verifiedAgainstBill: true,
      candidate: {
        kind: 'public',
        name: 'Public TOU',
        seasons: sampleSeasons,
        urdbLabel: 'urdb-tou-1',
        utilityName: 'Demo Utility',
        revisionStart: '2025-01-01',
        exportRateProvenance: 'published',
        holidaysUseWeekendSchedule: true,
      },
    });

    expect(result).toEqual({
      selectionIds: [500],
      tariffIds: [88],
      createdNewTariffVersion: false,
      unchanged: true,
      reattributionRange: null,
    });
    expect(clientQueries.some(q => q.sql.includes('INSERT INTO "Tariff"('))).toBe(false);
    expect(clientQueries.some(q => q.sql.includes('INSERT INTO "TariffSelection"'))).toBe(false);
  });

  it('applyTariffSelectionOnClient verifies an identical span in place without duplicating the Tariff version', async () => {
    clientQueryHandler = async (sql: string) => {
      if (sql.includes('FROM "TariffEffectivePeriod"') && sql.includes('ORDER BY effective_from ASC')) {
        return {
          rows: [{
            id: 10,
            tariff_id: 88,
            source: 'estimated',
            effective_from: '2025-01-01',
            effective_to: null,
            updated_by_user_id: 'u1',
            selection_id: 500,
            choice_kind: 'owner',
          }],
        };
      }
      if (sql.includes('LEFT JOIN "TariffUrdbSource" u ON u.tariff_id = t.id')) {
        return { rows: [{ id: 88, has_urdb: true }] };
      }
      if (sql.includes('FROM "TariffSelection" WHERE id = $1')) {
        return {
          rows: [{
            urdb_label: 'urdb-tou-1',
            utility_name: 'Demo Utility',
            revision_start: '2025-01-01',
            export_rate_provenance: 'published',
            holidays_use_weekend: true,
          }],
        };
      }
      if (sql.includes('FROM "TariffSelectionVerification"')) {
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO "TariffSelection"')) {
        return { rows: [{ id: 501 }] };
      }
      return { rows: [] };
    };

    const result = await applyTariffSelectionOnClient(fakeClient, 's1', '2026-11-17', {
      scope: 'actual',
      effectiveFrom: '2025-01-01',
      effectiveTo: null,
      userId: 'u1',
      verifiedAgainstBill: true,
      candidate: {
        kind: 'public',
        name: 'Public TOU',
        seasons: sampleSeasons,
        urdbLabel: 'urdb-tou-1',
        utilityName: 'Demo Utility',
        revisionStart: '2025-01-01',
        exportRateProvenance: 'published',
        holidaysUseWeekendSchedule: true,
      },
    });

    expect(result.createdNewTariffVersion).toBe(false);
    expect(result.unchanged).toBe(false);
    expect(result.selectionIds).toEqual([501]);
    expect(clientQueries.some(q => q.sql.includes('INSERT INTO "Tariff"('))).toBe(false);
    expect(clientQueries.some(q => q.sql.includes('INSERT INTO "TariffSelectionVerification"'))).toBe(true);
    expect(clientQueries.some(q => q.sql.includes('UPDATE "TariffEffectivePeriod" SET selection_id = $3'))).toBe(true);
  });

  it('applyTariffSelectionOnClient rejects restore_tesla when no saved original exists', async () => {
    await expect(
      applyTariffSelectionOnClient(fakeClient, 's1', '2026-11-17', {
        scope: 'actual',
        effectiveFrom: '2025-01-01',
        effectiveTo: '2025-06-30',
        userId: 'u1',
        verifiedAgainstBill: false,
        candidate: {
          kind: 'restore_tesla',
          originalSelectionId: 999,
        },
      })
    ).rejects.toThrow(TariffValidationError);
  });

  it('loadScopeSelectionSpans attaches preservedTeslaOriginal clipped to the active span', async () => {
    clientQueryHandler = async (sql: string) => {
      if (sql.includes('FROM "TariffEffectivePeriod" p')) {
        return {
          rows: [{
            period_id: 21,
            tariff_id: 88,
            effective_from: '2025-03-01',
            effective_to: '2025-06-30',
            source: 'estimated',
            updated_by_user_id: 'u1',
            updated_by_email: 'owner@example.com',
            name: 'Public TOU',
            version: 1,
            content_hash: 'hash-pub',
            selection_id: 600,
            choice_kind: 'owner',
            urdb_label: 'urdb-tou-1',
          }],
        };
      }
      if (sql.includes('FROM "Tariff"') && sql.includes('id = ANY')) {
        return { rows: [{ id: 88, site_id: 's1', version: 1, name: 'Public TOU', currency: 'USD', is_current: true, updated: new Date(), content_hash: 'hash-pub', source: 'estimated' }] };
      }
      if (sql.includes('FROM "TariffSelectionOriginal"')) {
        return {
          rows: [{
            selection_id: 600,
            effective_from: '2025-01-01',
            effective_to: '2025-12-31',
            original_tariff_id: 42,
            original_selection_id: 300,
            name: 'Original Tesla TOU',
            version: 2,
            content_hash: 'hash-tesla-2',
          }],
        };
      }
      return { rows: [] };
    };

    const spans = await loadScopeSelectionSpans(fakeClient, 's1', 'actual', 'u1');
    expect(spans).toHaveLength(1);
    expect(spans[0].preservedTeslaOriginal).toEqual({
      originalSelectionId: 600,
      tariffId: 42,
      name: 'Original Tesla TOU',
      version: 2,
      contentHash: 'hash-tesla-2',
      effectiveFrom: '2025-03-01',
      effectiveTo: '2025-06-30',
    });
  });

  it('loadScopeSelectionSpans partitions multi-interval and partial-gap TariffSelectionOriginal rows without stretching or hiding originals', async () => {
    clientQueryHandler = async (sql: string) => {
      if (sql.includes('FROM "TariffEffectivePeriod" p')) {
        return {
          rows: [{
            period_id: 21,
            tariff_id: 88,
            effective_from: '2025-01-01',
            effective_to: null,
            source: 'estimated',
            updated_by_user_id: 'u1',
            updated_by_email: 'owner@example.com',
            name: 'Public Full Year',
            version: 1,
            content_hash: 'hash-pub',
            selection_id: 600,
            choice_kind: 'owner',
            urdb_label: 'urdb-tou-1',
          }],
        };
      }
      if (sql.includes('FROM "Tariff"') && sql.includes('id = ANY')) {
        return { rows: [{ id: 88, site_id: 's1', version: 1, name: 'Public Full Year', currency: 'USD', is_current: true, updated: new Date(), content_hash: 'hash-pub', source: 'estimated' }] };
      }
      if (sql.includes('FROM "TariffSelectionOriginal"')) {
        return {
          rows: [
            {
              selection_id: 600,
              effective_from: '2025-03-01',
              effective_to: '2025-06-30',
              original_tariff_id: 42,
              original_selection_id: 301,
              name: 'Tesla Spring TOU',
              version: 1,
              content_hash: 'hash-tesla-1',
            },
            {
              selection_id: 600,
              effective_from: '2025-09-01',
              effective_to: null,
              original_tariff_id: 43,
              original_selection_id: 302,
              name: 'Tesla Fall TOU',
              version: 2,
              content_hash: 'hash-tesla-2',
            },
          ],
        };
      }
      return { rows: [] };
    };

    const spans = await loadScopeSelectionSpans(fakeClient, 's1', 'actual', 'u1');
    expect(
      spans.map(s => ({
        from: s.effectiveFrom,
        to: s.effectiveTo,
        orig: s.preservedTeslaOriginal ?? null,
      }))
    ).toEqual([
      { from: '2025-01-01', to: '2025-02-28', orig: null },
      {
        from: '2025-03-01',
        to: '2025-06-30',
        orig: {
          originalSelectionId: 600,
          tariffId: 42,
          name: 'Tesla Spring TOU',
          version: 1,
          contentHash: 'hash-tesla-1',
          effectiveFrom: '2025-03-01',
          effectiveTo: '2025-06-30',
        },
      },
      { from: '2025-07-01', to: '2025-08-31', orig: null },
      {
        from: '2025-09-01',
        to: null,
        orig: {
          originalSelectionId: 600,
          tariffId: 43,
          name: 'Tesla Fall TOU',
          version: 2,
          contentHash: 'hash-tesla-2',
          effectiveFrom: '2025-09-01',
          effectiveTo: null,
        },
      },
    ]);

    const preview = buildTariffSelectionPreview({
      siteId: 's1',
      timezone: 'America/Chicago',
      currency: 'USD',
      todaySiteLocal: '2026-11-17',
      request: {
        scope: 'actual',
        effectiveFrom: '2025-01-01',
        effectiveTo: '2025-12-31',
        candidate: { kind: 'manual', name: 'New Manual Plan', seasons: sampleSeasons },
      },
      existingSpans: spans,
      candidatePlan: {
        ...spans[0].plan,
        name: 'New Manual Plan',
        source: 'manual',
      },
    });
    expect(preview.restoration.preservedOriginals).toEqual([
      {
        originalSelectionId: 600,
        tariffId: 42,
        name: 'Tesla Spring TOU',
        version: 1,
        contentHash: 'hash-tesla-1',
        effectiveFrom: '2025-03-01',
        effectiveTo: '2025-06-30',
      },
      {
        originalSelectionId: 600,
        tariffId: 43,
        name: 'Tesla Fall TOU',
        version: 2,
        contentHash: 'hash-tesla-2',
        effectiveFrom: '2025-09-01',
        effectiveTo: '2025-12-31',
      },
    ]);
  });

  it('applyTariffSelectionOnClient and applySelection return unchanged: true and skip cache invalidation when repeating identical restore_tesla', async () => {
    clientQueryHandler = async (sql: string) => {
      if (sql.includes('FROM "Site" WHERE id = $1 FOR UPDATE')) {
        return { rows: [{ timezone: 'America/Chicago' }] };
      }
      if (sql.includes('FROM "TariffEffectivePeriod"') && sql.includes('ORDER BY effective_from ASC')) {
        return {
          rows: [{
            id: 31,
            tariff_id: 42,
            source: 'tesla',
            effective_from: '2025-01-01',
            effective_to: null,
            updated_by_user_id: 'u1',
            selection_id: 710,
            choice_kind: 'owner',
          }],
        };
      }
      if (sql.includes('FROM "TariffSelectionOriginal"') && sql.includes('WHERE site_id = $1 AND scope = $2 AND selection_id = $3')) {
        return {
          rows: [{
            selection_id: 600,
            effective_from: '2025-01-01',
            effective_to: null,
            original_tariff_id: 42,
            original_selection_id: 300,
          }],
        };
      }
      if (sql.includes('FROM "Tariff"') && sql.includes('id = ANY')) {
        return { rows: [{ id: 42, site_id: 's1', version: 1, name: 'Saved Tesla', currency: 'USD', is_current: true, updated: new Date(), content_hash: 'hash-tesla-42', source: 'tesla' }] };
      }
      if (sql.includes('FROM "TariffSelectionVerification"')) {
        return { rows: [] };
      }
      return { rows: [] };
    };
    mocks.queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM "Site"')) {
        return { rows: [{ id: 's1', timezone: 'America/Chicago', installed: '2023-11-14T08:00:00Z', currency: 'USD' }] };
      }
      return { rows: [] };
    });

    const repo = new TariffTimelineRepo();
    const res = await repo.applySelection('s1', {
      scope: 'actual',
      effectiveFrom: '2025-01-01',
      effectiveTo: null,
      userId: 'u1',
      verifiedAgainstBill: false,
      candidate: { kind: 'restore_tesla', originalSelectionId: 600 },
    });

    expect(res.unchanged).toBe(true);
    expect(res.createdNewTariffVersion).toBe(false);
    expect(res.selectionIds).toEqual([710]);
    expect(res.reattributionRange).toBeNull();
    expect(mocks.invalidateCacheMock).not.toHaveBeenCalled();
    expect(clientQueries.some(q => q.sql.includes('INSERT INTO "TariffSelection"'))).toBe(false);
    expect(clientQueries.some(q => q.sql.includes('INSERT INTO "SiteTariffReattribution"'))).toBe(false);
  });

  it('loadRestorationTargets coalesces duplicate intervals carried across chained overrides', async () => {
    clientQueryHandler = async (sql: string) => {
      if (sql.includes('WHERE site_id = $1 AND scope = $2 AND original_selection_id = $3')) {
        return {
          rows: [
            {
              selection_id: 20,
              effective_from: '2025-01-01',
              effective_to: '2025-06-30',
              original_tariff_id: 42,
              original_selection_id: 300,
            },
            {
              selection_id: 30,
              effective_from: '2025-01-01',
              effective_to: '2025-06-30',
              original_tariff_id: 42,
              original_selection_id: 300,
            },
          ],
        };
      }
      if (sql.includes('FROM "Tariff"') && sql.includes('id = ANY')) {
        return { rows: [{ id: 42, site_id: 's1', version: 1, name: 'Saved Tesla v1', currency: 'USD', is_current: false, updated: new Date(), content_hash: 'hash-t1', source: 'tesla' }] };
      }
      return { rows: [] };
    };

    const targets = await loadRestorationTargets(fakeClient, 's1', 'actual', 300, '2025-02-01', '2025-05-31');
    expect(targets).toHaveLength(1);
    expect(targets[0].effectiveFrom).toBe('2025-02-01');
    expect(targets[0].effectiveTo).toBe('2025-05-31');
    expect(targets[0].original.tariffId).toBe(42);
  });

  it('refuses legacy reference-scope POST/PATCH/DELETE mutations that overwrite or delete protected owner selections', async () => {
    const repo = new TariffTimelineRepo();
    let refSpans: Array<{
      id: number;
      tariff_id: number;
      source: 'estimated' | 'manual';
      effective_from: string;
      effective_to: string | null;
      updated_by_user_id: string | null;
      selection_id: number | null;
      choice_kind: 'automatic' | 'owner' | null;
    }> = [
      {
        id: 81,
        tariff_id: 91,
        source: 'estimated',
        effective_from: '2025-01-01',
        effective_to: null,
        updated_by_user_id: 'u1',
        selection_id: 401,
        choice_kind: 'owner',
      },
    ];

    clientQueryHandler = async (sql: string) => {
      if (sql.includes('FROM "Site" WHERE id = $1 FOR UPDATE')) {
        return { rows: [{ timezone: 'America/Chicago' }] };
      }
      if (sql.includes('COALESCE(MAX(version), 0) + 1')) return { rows: [{ next: 2 }] };
      if (sql.includes('INSERT INTO "Tariff"(')) return { rows: [{ id: 102 }] };
      if (sql.includes('INSERT INTO "TariffSeason"(')) return { rows: [{ id: 202 }] };
      if (sql.includes('FROM "TariffReferencePeriod" p') && sql.includes('ORDER BY effective_from ASC')) {
        return { rows: refSpans };
      }
      return { rows: [] };
    };

    const season = [{
      name: 'All Year',
      fromMonth: 1,
      toMonth: 12,
      weekdayPeriods: [{ touName: 'OFF_PEAK' as const, fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.14, sellRate: 0.03 }],
      weekendPeriods: [{ touName: 'OFF_PEAK' as const, fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.14, sellRate: 0.03 }],
    }];

    await expect(
      repo.createReferencePeriod('s1', 'u1', {
        name: 'Override Ref',
        effectiveFrom: '2025-06-01',
        effectiveTo: '2025-12-31',
        seasons: season,
      })
    ).rejects.toThrow(TariffValidationError);

    await expect(
      repo.updateReferencePeriod('s1', 'u1', 81, { name: 'Rename Public Ref' })
    ).rejects.toThrow(TariffValidationError);

    await expect(
      repo.deleteReferencePeriod('s1', 81, 'u1')
    ).rejects.toThrow(TariffValidationError);

    refSpans = [
      {
        id: 80,
        tariff_id: 90,
        source: 'manual',
        effective_from: '2024-01-01',
        effective_to: '2024-12-31',
        updated_by_user_id: 'u1',
        selection_id: 400,
        choice_kind: 'owner',
      },
      refSpans[0],
    ];
    await expect(
      repo.updateReferencePeriod('s1', 'u1', 80, { effectiveTo: '2025-03-01' })
    ).rejects.toThrow(TariffValidationError);
  });

  it('updateReferencePeriod dates-only edit on an owner-selected public plan preserves source=estimated and public TariffSelection metadata', async () => {
    const repo = new TariffTimelineRepo();
    const insertedSelections: Array<{ sql: string; params?: unknown[] }> = [];
    const insertedPeriods: Array<{ sql: string; params?: unknown[] }> = [];

    clientQueryHandler = async (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM "Site" WHERE id = $1 FOR UPDATE')) {
        return { rows: [{ timezone: 'America/Chicago' }] };
      }
      if (sql.includes('FROM "TariffReferencePeriod" p') && sql.includes('ORDER BY effective_from ASC')) {
        return {
          rows: [{
            id: 81,
            tariff_id: 91,
            source: 'estimated',
            effective_from: '2025-01-01',
            effective_to: null,
            updated_by_user_id: 'u1',
            selection_id: 401,
            choice_kind: 'owner',
          }],
        };
      }
      if (sql.includes('SELECT content_hash FROM "Tariff" WHERE id = $1')) {
        return { rows: [{ content_hash: 'hash-pub-ref' }] };
      }
      if (sql.includes('FROM "TariffSelection" WHERE id = $1')) {
        return {
          rows: [{
            urdb_label: 'urdb-ref-1',
            utility_name: 'Wisconsin Electric Power Co',
            revision_start: '2025-01-01',
            export_rate_provenance: 'net_metering',
            holidays_use_weekend: true,
            approximation_notes: [{ kind: 'tier_blended', message: 'Blended tiers' }],
          }],
        };
      }
      if (sql.includes('INSERT INTO "TariffSelection"')) {
        insertedSelections.push({ sql, params });
        return { rows: [{ id: 402 }] };
      }
      if (sql.includes('INSERT INTO "TariffReferencePeriod"')) {
        insertedPeriods.push({ sql, params });
        return { rows: [{ id: 82, tariff_id: 91 }] };
      }
      return { rows: [] };
    };

    mocks.queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM "Site"')) {
        return { rows: [{ id: 's1', timezone: 'America/Chicago', installed: '2024-01-01T00:00:00Z', currency: 'USD' }] };
      }
      if (sql.includes('FROM "TariffReferencePeriod" p')) {
        return {
          rows: [{
            period_id: 82,
            tariff_id: 91,
            effective_from: '2025-01-01',
            effective_to: '2025-08-31',
            source: 'estimated',
            updated_by_user_id: 'u1',
            updated_by_email: 'owner@example.com',
            name: 'WE Public Ref',
            version: 1,
            content_hash: 'hash-pub-ref',
            selection_id: 402,
            choice_kind: 'owner',
            candidate_kind: 'public',
            selected_by_user_id: 'u1',
            urdb_label: 'urdb-ref-1',
            utility_name: 'Wisconsin Electric Power Co',
            revision_start: '2025-01-01',
            export_rate_provenance: 'net_metering',
            holidays_use_weekend: true,
            approximation_notes: [{ kind: 'tier_blended', message: 'Blended tiers' }],
          }],
        };
      }
      return { rows: [] };
    });

    const timeline = await repo.updateReferencePeriod('s1', 'u1', 81, { effectiveTo: '2025-08-31' });

    expect(clientQueries.some(q => q.sql.includes('INSERT INTO "Tariff"('))).toBe(false);
    expect(clientQueries.some(q => q.sql.includes('SiteTariffReattribution'))).toBe(false);
    expect(insertedSelections).toHaveLength(1);
    expect(insertedSelections[0].params).toEqual(
      expect.arrayContaining([
        's1',
        'reference',
        91,
        '2025-01-01',
        '2025-08-31',
        'estimated',
        'owner',
        'public',
        'u1',
        'urdb-ref-1',
        'Wisconsin Electric Power Co',
        '2025-01-01',
        'net_metering',
        true,
        JSON.stringify([{ kind: 'tier_blended', message: 'Blended tiers' }]),
        'hash-pub-ref',
      ])
    );
    expect(insertedPeriods).toHaveLength(1);
    expect(insertedPeriods[0].params).toEqual(['s1', 91, '2025-01-01', '2025-08-31', 'u1', 'estimated', 402]);
    expect(timeline.referencePeriods?.[0]).toMatchObject({
      periodId: 82,
      source: 'estimated',
      choiceKind: 'owner',
      urdbLabel: 'urdb-ref-1',
      effectiveFrom: '2025-01-01',
      effectiveTo: '2025-08-31',
    });
  });
});
