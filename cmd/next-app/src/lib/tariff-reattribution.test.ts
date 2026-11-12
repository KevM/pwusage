import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import type { Tariff } from './db-types';

const mocks = vi.hoisted(() => ({
  connectMock: vi.fn(),
  queryMock: vi.fn(),
  resolveTariffForDateMock: vi.fn(),
  reattributeArchiveChunkMock: vi.fn(),
  logEventMock: vi.fn(),
  flushLogEventsMock: vi.fn(),
}));

vi.mock('./db', () => ({
  pool: {
    connect: mocks.connectMock,
    query: mocks.queryMock,
  },
}));

vi.mock('./tariff-timeline-repo', () => ({
  TariffTimelineRepo: class {
    resolveTariffForDate = mocks.resolveTariffForDateMock;
  },
}));

vi.mock('./prototypes/compact-history-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./prototypes/compact-history-store')>();
  return {
    ...actual,
    CompactHistoryStore: class extends actual.CompactHistoryStore {
      reattributeArchiveChunk = mocks.reattributeArchiveChunkMock;
    },
  };
});

vi.mock('./observability', () => ({
  accountFingerprint: (id: string) => `fp_${id}`,
  errorFields: (err: unknown) => (err instanceof Error ? { errorName: err.name, errorCode: (err as Error & { code?: string }).code } : { errorName: typeof err }),
  logEvent: mocks.logEventMock,
  flushLogEvents: mocks.flushLogEventsMock,
}));

import { tariffTimelineRevision } from './prototypes/day-attribution';
import {
  enqueueTariffReattribution,
  REATTRIBUTION_MAX_ATTEMPTS,
  runSiteReattribution,
} from './tariff-reattribution';

function makeTariff(id: number, scheduleId: number): Tariff {
  return {
    id,
    site_id: 's1',
    updated: new Date(0),
    name: `Plan ${id}`,
    seasons: [{
      id: id * 10,
      tariff_id: id,
      name: 'All Year',
      from_month: 1,
      from_day: 1,
      to_month: 12,
      to_day: 31,
      buy_rate: 0.1,
      sell_rate: 0.03,
      schedules: [{
        id: scheduleId,
        season_id: id * 10,
        name: 'OFF_PEAK',
        buy_rate: 0.1,
        sell_rate: 0.03,
        from_day_of_week: 0,
        to_day_of_week: 6,
        from_hour: 0,
        from_minute: 0,
        to_hour: 24,
        to_minute: 0,
      }],
    }],
  };
}

describe('tariff-reattribution engine', () => {
  let clientQueries: Array<{ sql: string; params?: unknown[] }> = [];
  let clientHandler: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number }>;

  const fakeClient = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      clientQueries.push({ sql, params });
      return clientHandler(sql, params);
    }),
    release: vi.fn(),
  } as unknown as PoolClient;

  beforeEach(() => {
    vi.clearAllMocks();
    clientQueries = [];
    mocks.connectMock.mockResolvedValue(fakeClient);
    clientHandler = async () => ({ rows: [], rowCount: 0 });
  });

  it('exports tariffTimelineRevision using effective-tariff prefix', () => {
    expect(tariffTimelineRevision(42)).toBe('effective-tariff:42');
  });

  it('fast-skips legacy current-tariff and matching effective-tariff rows without rewriting, while rewriting changed rows', async () => {
    const t2025 = makeTariff(10, 100);
    const t2026 = makeTariff(20, 200);
    mocks.resolveTariffForDateMock.mockImplementation(async (_c: unknown, _s: string, date: string) => {
      const tariff = date.startsWith('2026') ? t2026 : t2025;
      return { tariffs: [tariff], schedules: tariff.seasons![0].schedules! };
    });

    const scanRows = [
      // Legacy 'current-tariff:20' whose segments and attribution_complete ALREADY match t2026 -> fast-skip!
      {
        day_start: new Date('2026-07-15T05:00:00Z'),
        day_end: new Date('2026-07-16T05:00:00Z'),
        format_version: 2,
        metadata_version: 3,
        attribution_complete: true,
        attribution: { timelineRevision: 'current-tariff:20', segments: [{ offset: 0, tariffId: 20, scheduleId: 200 }] },
      },
      // Historical 2025 row currently pointing to old tariff 99 -> must rewrite to t2025 (10)!
      {
        day_start: new Date('2025-07-15T05:00:00Z'),
        day_end: new Date('2025-07-16T05:00:00Z'),
        format_version: 2,
        metadata_version: 3,
        attribution_complete: true,
        attribution: { timelineRevision: 'current-tariff:99', segments: [{ offset: 0, tariffId: 99, scheduleId: 999 }] },
      },
    ];

    let scanDone = false;
    mocks.queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('UPDATE "SiteTariffReattribution"')) {
        return {
          rows: [{
            site_id: 's1',
            status: 'running',
            generation: 3,
            from_date: '2025-01-01',
            to_date: null,
            cursor_day_start: null,
            total_days: 2,
            processed_days: 0,
            updated_days: 0,
            attempt_count: 0,
            last_error: null,
            requested_by_user_id: 'u1',
            updated_at: new Date(),
          }],
        };
      }
      if (sql.includes('SELECT timezone FROM "Site"')) {
        return { rows: [{ timezone: 'America/Chicago' }] };
      }
      if (sql.includes('FROM "EnergyDayArchive"') && !scanDone) {
        scanDone = true;
        return { rows: scanRows };
      }
      return { rows: [] };
    });

    mocks.reattributeArchiveChunkMock.mockImplementation(async (params: {
      candidates: Array<{ dayStart: Date; tariffs: Tariff[] }>;
      checkpoint: (client: PoolClient) => Promise<boolean>;
    }) => {
      const ok = await params.checkpoint(fakeClient);
      expect(ok).toBe(true);
      return { status: 'committed', rewrittenDays: params.candidates.length };
    });
    clientHandler = async (sql: string) => {
      if (sql.includes('UPDATE "SiteTariffReattribution"')) return { rows: [], rowCount: 1 };
      return { rows: [] };
    };

    const res = await runSiteReattribution({ siteId: 's1', trigger: 'cron', chunkDays: 15 });
    expect(res).toEqual({ outcome: 'idle', processedDays: 2, updatedDays: 1 });
    expect(mocks.reattributeArchiveChunkMock).toHaveBeenCalledTimes(1);
    const passedCandidates = mocks.reattributeArchiveChunkMock.mock.calls[0][0].candidates;
    expect(passedCandidates).toHaveLength(1);
    expect(passedCandidates[0].dayStart.toISOString()).toBe('2025-07-15T05:00:00.000Z');
    expect(passedCandidates[0].tariffs[0].id).toBe(10);
  });

  it('stops cleanly at maxTimeMs preserving cursor_day_start and sets status back to pending', async () => {
    const t2026 = makeTariff(20, 200);
    mocks.resolveTariffForDateMock.mockResolvedValue({ tariffs: [t2026], schedules: t2026.seasons![0].schedules! });

    let now = 1000;
    const clock = () => {
      now += 60;
      return now;
    };

    const chunk1 = [
      {
        day_start: new Date('2026-07-15T05:00:00Z'),
        day_end: new Date('2026-07-16T05:00:00Z'),
        format_version: 2,
        metadata_version: 3,
        attribution_complete: true,
        attribution: { timelineRevision: 'effective-tariff:20', segments: [{ offset: 0, tariffId: 20, scheduleId: 200 }] },
      },
      {
        day_start: new Date('2026-07-14T05:00:00Z'),
        day_end: new Date('2026-07-15T05:00:00Z'),
        format_version: 2,
        metadata_version: 3,
        attribution_complete: true,
        attribution: { timelineRevision: 'effective-tariff:20', segments: [{ offset: 0, tariffId: 20, scheduleId: 200 }] },
      },
    ];

    mocks.queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('UPDATE "SiteTariffReattribution"') && sql.includes("status = 'running'")) {
        return {
          rows: [{
            site_id: 's1', status: 'running', generation: 1, from_date: '2026-01-01', to_date: null,
            cursor_day_start: null, total_days: 5, processed_days: 0, updated_days: 0, attempt_count: 0,
            last_error: null, requested_by_user_id: null, updated_at: new Date(),
          }],
        };
      }
      if (sql.includes('SELECT timezone FROM "Site"')) return { rows: [{ timezone: 'America/Chicago' }] };
      if (sql.includes('FROM "EnergyDayArchive"')) return { rows: chunk1 };
      return { rows: [] };
    });
    clientHandler = async () => ({ rows: [], rowCount: 1 });

    const res = await runSiteReattribution({ siteId: 's1', trigger: 'after', maxTimeMs: 100, chunkDays: 2, clock });
    expect(res).toEqual({ outcome: 'partial', processedDays: 2, updatedDays: 0 });
    const checkpointUpdate = clientQueries.find(q => q.sql.includes('UPDATE "SiteTariffReattribution"'));
    expect(checkpointUpdate?.params?.[2]).toBe(2);
    expect(checkpointUpdate?.params?.[4]).toEqual(new Date('2026-07-14T05:00:00Z'));
    expect(checkpointUpdate?.params?.[5]).toBe('pending');
  });

  it('aborts cleanly when generation fence matches 0 rows (superseded by concurrent edit)', async () => {
    const t2026 = makeTariff(20, 200);
    mocks.resolveTariffForDateMock.mockResolvedValue({ tariffs: [t2026], schedules: t2026.seasons![0].schedules! });

    mocks.queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('UPDATE "SiteTariffReattribution"') && sql.includes("status = 'running'")) {
        return {
          rows: [{
            site_id: 's1', status: 'running', generation: 4, from_date: '2026-01-01', to_date: null,
            cursor_day_start: null, total_days: 1, processed_days: 0, updated_days: 0, attempt_count: 0,
            last_error: null, requested_by_user_id: null, updated_at: new Date(),
          }],
        };
      }
      if (sql.includes('SELECT timezone FROM "Site"')) return { rows: [{ timezone: 'America/Chicago' }] };
      if (sql.includes('FROM "EnergyDayArchive"')) {
        return {
          rows: [{
            day_start: new Date('2026-07-15T05:00:00Z'),
            day_end: new Date('2026-07-16T05:00:00Z'),
            format_version: 2,
            metadata_version: 3,
            attribution_complete: true,
            attribution: { timelineRevision: 'current-tariff:1', segments: [{ offset: 0, tariffId: 1, scheduleId: 10 }] },
          }],
        };
      }
      return { rows: [] };
    });

    mocks.reattributeArchiveChunkMock.mockImplementation(async (params: {
      checkpoint: (client: PoolClient) => Promise<boolean>;
    }) => {
      const ok = await params.checkpoint(fakeClient);
      expect(ok).toBe(false);
      return { status: 'superseded', rewrittenDays: 0 };
    });
    clientHandler = async (sql: string) => {
      if (sql.includes('UPDATE "SiteTariffReattribution"')) return { rows: [], rowCount: 0 };
      return { rows: [] };
    };

    const res = await runSiteReattribution({ siteId: 's1', trigger: 'cron', chunkDays: 15 });
    expect(res.outcome).toBe('partial');
    expect(mocks.logEventMock).toHaveBeenCalledWith('info', 'tariff.reattribution.superseded', expect.objectContaining({ generation: 4 }));
  });

  it('coalesces overlapping enqueue requests and increments generation', async () => {
    clientHandler = async (sql: string) => {
      if (sql.includes('SELECT timezone FROM "Site"')) return { rows: [{ timezone: 'America/Chicago' }] };
      if (sql.includes('SELECT * FROM "SiteTariffReattribution"')) {
        return {
          rows: [{
            site_id: 's1', status: 'running', generation: 2, from_date: '2026-03-01', to_date: '2026-06-01',
          }],
        };
      }
      if (sql.includes('SELECT COUNT(*)')) return { rows: [{ count: '120' }] };
      if (sql.includes('INSERT INTO "SiteTariffReattribution"')) {
        return {
          rows: [{
            site_id: 's1', status: 'pending', generation: 3, from_date: '2026-01-01', to_date: '2026-06-01',
            cursor_day_start: null, total_days: 120, processed_days: 0, updated_days: 0, attempt_count: 0,
            last_error: null, requested_by_user_id: 'u1', updated_at: new Date(),
          }],
        };
      }
      return { rows: [] };
    };

    const dto = await enqueueTariffReattribution({
      siteId: 's1',
      fromDate: '2026-01-01',
      toDate: '2026-04-01',
      requestedByUserId: 'u1',
      trigger: 'update',
    });
    expect(dto.status).toBe('pending');
    expect(dto.fromDate).toBe('2026-01-01');
    expect(dto.toDate).toBe('2026-06-01');
    expect(dto.totalDays).toBe(120);
    expect(mocks.logEventMock).toHaveBeenCalledWith('info', 'tariff.reattribution.enqueued', expect.objectContaining({
      coalesced: true,
      accountId: 'fp_u1',
    }));
  });

  it('keeps a failed job\'s unfinished range when a later edit replaces it', async () => {
    let countParams: unknown[] = [];
    clientHandler = async (sql: string, params?: unknown[]) => {
      if (sql.includes('SELECT timezone FROM "Site"')) return { rows: [{ timezone: 'America/Chicago' }] };
      if (sql.includes('SELECT * FROM "SiteTariffReattribution"')) {
        return { rows: [{ site_id: 's1', status: 'failed', generation: 2, from_date: '2026-01-01', to_date: '2026-02-01' }] };
      }
      if (sql.includes('SELECT COUNT(*)')) { countParams = params ?? []; return { rows: [{ count: '10' }] }; }
      if (sql.includes('INSERT INTO "SiteTariffReattribution"')) {
        return { rows: [{
          site_id: 's1', status: 'pending', generation: 3, from_date: '2026-01-01', to_date: '2026-06-01',
          cursor_day_start: null, total_days: 10, processed_days: 0, updated_days: 0, attempt_count: 0,
          last_error: null, requested_by_user_id: 'u1', updated_at: new Date(),
        }] };
      }
      return { rows: [] };
    };

    await enqueueTariffReattribution({
      siteId: 's1', fromDate: '2026-05-01', toDate: '2026-06-01', requestedByUserId: 'u1', trigger: 'update',
    });
    expect(countParams).toEqual(['s1', 'America/Chicago', '2026-01-01', '2026-06-01']);
  });

  it('carries the range through a fallback gap up to the next explicit period', async () => {
    let countParams: unknown[] = [];
    const run = async (nextFrom: string | null | 'none') => {
      clientHandler = async (sql: string, params?: unknown[]) => {
        if (sql.includes('SELECT timezone FROM "Site"')) return { rows: [{ timezone: 'America/Chicago' }] };
        if (sql.includes('SELECT * FROM "SiteTariffReattribution"')) return { rows: [] };
        if (sql.includes('AS next_from')) return { rows: nextFrom === 'none' ? [] : [{ next_from: nextFrom }] };
        if (sql.includes('SELECT COUNT(*)')) { countParams = params ?? []; return { rows: [{ count: '3' }] }; }
        if (sql.includes('INSERT INTO "SiteTariffReattribution"')) {
          return { rows: [{
            site_id: 's1', status: 'pending', generation: 1, from_date: '2026-01-01', to_date: '2026-02-28',
            cursor_day_start: null, total_days: 3, processed_days: 0, updated_days: 0, attempt_count: 0,
            last_error: null, requested_by_user_id: 'u1', updated_at: new Date(),
          }] };
        }
        return { rows: [] };
      };
      await enqueueTariffReattribution({
        siteId: 's1', fromDate: '2026-01-01', toDate: '2026-02-28', requestedByUserId: 'u1', trigger: 'update',
      });
    };

    await run('2026-04-01'); // Feb 28 plan, next plan starts Apr 1: March falls back to Feb's plan
    expect(countParams).toEqual(['s1', 'America/Chicago', '2026-01-01', '2026-03-31']);
    await run('2026-03-01'); // adjacent: nothing in between
    expect(countParams).toEqual(['s1', 'America/Chicago', '2026-01-01', '2026-02-28']);
    await run(null); // nothing follows: the plan is the fallback from here on
    expect(countParams).toEqual(['s1', 'America/Chicago', '2026-01-01', null]);
  });

  it('reaches back before the earliest plan, which prices the days that precede it', async () => {
    let countParams: unknown[] = [];
    const run = async (earliest: string) => {
      clientHandler = async (sql: string, params?: unknown[]) => {
        if (sql.includes('SELECT timezone FROM "Site"')) return { rows: [{ timezone: 'America/Chicago' }] };
        if (sql.includes('SELECT * FROM "SiteTariffReattribution"')) return { rows: [] };
        if (sql.includes('AS earliest_from')) return { rows: [{ earliest_from: earliest }] };
        if (sql.includes('SELECT COUNT(*)')) { countParams = params ?? []; return { rows: [{ count: '3' }] }; }
        if (sql.includes('INSERT INTO "SiteTariffReattribution"')) {
          return { rows: [{
            site_id: 's1', status: 'pending', generation: 1, from_date: '2015-01-01', to_date: null,
            cursor_day_start: null, total_days: 3, processed_days: 0, updated_days: 0, attempt_count: 0,
            last_error: null, requested_by_user_id: 'u1', updated_at: new Date(),
          }] };
        }
        return { rows: [] };
      };
      await enqueueTariffReattribution({
        siteId: 's1', fromDate: '2026-02-01', toDate: null, requestedByUserId: 'u1', trigger: 'update',
      });
    };

    await run('2026-02-01'); // the edited plan is the earliest: January falls back to it
    expect(countParams).toEqual(['s1', 'America/Chicago', '2015-01-01', null]);
    await run('2025-06-01'); // an earlier plan exists: nothing before February changes
    expect(countParams).toEqual(['s1', 'America/Chicago', '2026-02-01', null]);
  });

  it('marks job failed with sanitized error token once attempt_count reaches REATTRIBUTION_MAX_ATTEMPTS', async () => {
    mocks.queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('UPDATE "SiteTariffReattribution"') && sql.includes("status = 'running'")) {
        return {
          rows: [{
            site_id: 's1', status: 'running', generation: 1, from_date: '2026-01-01', to_date: null,
            cursor_day_start: null, total_days: 5, processed_days: 0, updated_days: 0,
            attempt_count: REATTRIBUTION_MAX_ATTEMPTS - 1,
            last_error: null, requested_by_user_id: null, updated_at: new Date(),
          }],
        };
      }
      if (sql.includes('SELECT timezone FROM "Site"')) {
        const err = new Error('sensitive db msg') as Error & { code?: string };
        err.code = '57014';
        throw err;
      }
      return { rows: [] };
    });

    const res = await runSiteReattribution({ siteId: 's1', trigger: 'cron' });
    expect(res.outcome).toBe('failed');
    expect(mocks.queryMock).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE "SiteTariffReattribution"'),
      ['s1', 1, REATTRIBUTION_MAX_ATTEMPTS, 'failed', 'Error:57014']
    );
    expect(mocks.logEventMock).toHaveBeenCalledWith('error', 'tariff.reattribution.site.failed', expect.objectContaining({
      attemptCount: REATTRIBUTION_MAX_ATTEMPTS,
      errorCode: '57014',
    }));
  });
});
