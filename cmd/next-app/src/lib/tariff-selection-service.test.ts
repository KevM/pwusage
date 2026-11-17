import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';

const dbMocks = vi.hoisted(() => ({
  connectMock: vi.fn(),
  queryMock: vi.fn(),
  invalidateCacheMock: vi.fn(),
  logEventMock: vi.fn(),
  getCycleAggregatesMock: vi.fn(),
}));

vi.mock('./db', () => ({
  pool: {
    connect: dbMocks.connectMock,
    query: dbMocks.queryMock,
  },
}));

vi.mock('./site-repo', () => ({
  SiteRepo: class {
    invalidateCache = dbMocks.invalidateCacheMock;
  },
}));

vi.mock('./observability', () => ({
  accountFingerprint: (id: string) => `fp_${id}`,
  logEvent: dbMocks.logEventMock,
  errorFields: () => ({}),
}));

vi.mock('./energy-repo-factory', () => ({
  createEnergyRepo: () => ({
    getCycleAggregates: dbMocks.getCycleAggregatesMock,
  }),
}));

import {
  commitTariffSelection,
  listPublicUtilityPlansForSite,
  previewTariffSelection,
} from './tariff-selection-service';
import {
  TariffNotFoundError,
  TariffSelectionConflictError,
  TariffTimelineRepo,
  UtilityChangedError,
} from './tariff-timeline-repo';
import { compileSeasonsToParsedTariff, TariffValidationError } from './tariff-timeline';
import { tariffContentHash } from './importer/tariff-parser';
import type { TariffReviewPlanSnapshot, TariffSeasonInput } from './tariff-contract';
import type { UrdbRate } from './urdb/types';
import { UrdbUnavailableError } from './urdb/client';

const sampleSeasons: TariffSeasonInput[] = [
  {
    name: 'All Year',
    fromMonth: 1,
    toMonth: 12,
    weekdayPeriods: [
      { touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 16, toMinute: 0, buyRate: 0.12, sellRate: 0.04 },
      { touName: 'ON_PEAK', fromHour: 16, fromMinute: 0, toHour: 21, toMinute: 0, buyRate: 0.34, sellRate: 0.06 },
      { touName: 'OFF_PEAK', fromHour: 21, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.12, sellRate: 0.04 },
    ],
    weekendPeriods: [
      { touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.12, sellRate: 0.04 },
    ],
  },
];

const teslaSeasons: TariffSeasonInput[] = [
  {
    name: 'All Year',
    fromMonth: 1,
    toMonth: 12,
    weekdayPeriods: [
      { touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.15, sellRate: 0.05 },
    ],
    weekendPeriods: [
      { touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.15, sellRate: 0.05 },
    ],
  },
];

function makeTieredNonNetMeteringRate(overrides: Partial<UrdbRate> = {}): UrdbRate {
  const weekday = Array.from({ length: 12 }, () =>
    Array.from({ length: 24 }, (_, hour) => (hour >= 16 && hour < 21 ? 1 : 0))
  );
  const weekend = Array.from({ length: 12 }, () => Array<number>(24).fill(0));
  return {
    label: 'urdb-tiered-tou',
    name: 'Residential Tiered TOU',
    utility: 'Wisconsin Electric Power Co',
    startdate: 1_735_689_600, // 2025-01-01
    is_default: false,
    dgrules: 'Buy All Sell All',
    energyratestructure: [
      [
        { rate: 0.1, max: 300, unit: 'kWh' },
        { rate: 0.2, unit: 'kWh' },
      ],
      [{ rate: 0.35 }],
    ],
    energyweekdayschedule: weekday,
    energyweekendschedule: weekend,
    ...overrides,
  };
}

function makePublishedRate(overrides: Partial<UrdbRate> = {}): UrdbRate {
  const allZero = Array.from({ length: 12 }, () => Array<number>(24).fill(0));
  return {
    label: 'urdb-published-flat',
    name: 'Published Export Flat',
    utility: 'Wisconsin Electric Power Co',
    startdate: 1_735_689_600,
    is_default: true,
    dgrules: 'Net Metering',
    energyratestructure: [[{ rate: 0.19, sell: 0.08 }]],
    energyweekdayschedule: allZero,
    energyweekendschedule: allZero,
    ...overrides,
  };
}

function makeTeslaSnapshot(id: number, name: string, version: number, seasons: TariffSeasonInput[]): TariffReviewPlanSnapshot {
  const hash = tariffContentHash(compileSeasonsToParsedTariff(name, seasons));
  return {
    tariffId: id,
    version,
    periodId: id * 10,
    selectionId: id * 100,
    name,
    utilityName: null,
    source: 'tesla',
    choiceKind: 'automatic',
    urdbLabel: null,
    revisionStart: null,
    contentHash: hash,
    exportRateProvenance: 'tesla',
    holidaysUseWeekendSchedule: true,
    seasons,
    approximationNotes: [],
    verification: null,
  };
}

describe('tariff-selection-service', () => {
  const fixedNow = () => new Date('2026-11-17T18:00:00Z');
  let clientQueries: Array<{ sql: string; params?: unknown[] }>;
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
    clientQueries = [];
    dbMocks.connectMock.mockResolvedValue(fakeClient);
    dbMocks.getCycleAggregatesMock.mockResolvedValue([]);
    clientQueryHandler = async () => ({ rows: [], rowCount: 0 });
    dbMocks.queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  describe('listPublicUtilityPlansForSite', () => {
    it('supports chosen effectiveDate and exposes complete converted rates and approximation provenance', async () => {
      const rateTiered = makeTieredNonNetMeteringRate();
      const ratePublished = makePublishedRate();
      const unconvertible: UrdbRate = {
        label: 'bad-tier-unit',
        name: 'Unsupported MW Plan',
        utility: 'Wisconsin Electric Power Co',
        startdate: 1_735_689_600,
        energyratestructure: [[{ rate: 0.2, max: 5, unit: 'MW' }, { rate: 0.3 }]],
        energyweekdayschedule: Array.from({ length: 12 }, () => Array<number>(24).fill(0)),
        energyweekendschedule: Array.from({ length: 12 }, () => Array<number>(24).fill(0)),
      };

      const ratesEffectiveOn = vi.fn(async () => [rateTiered, ratePublished, unconvertible]);
      const repo = new TariffTimelineRepo();
      vi.spyOn(repo, 'getSiteUtilityContext').mockResolvedValue({
        name: 'We Energies',
        timezone: 'America/Chicago',
        currency: 'USD',
        choice: 'owner',
      });
      vi.spyOn(repo, 'loadSitePublicConversionContext').mockResolvedValue({
        fallbackSellRate: 0.05,
        hasTeslaSellFallback: true,
      });

      const res = await listPublicUtilityPlansForSite(
        'site-1',
        { effectiveDate: '2025-06-15', now: fixedNow() },
        {
          repo,
          urdb: { ratesEffectiveOn, rateByLabel: vi.fn() },
          monthlyUsage: async () => 600,
        }
      );

      expect(ratesEffectiveOn).toHaveBeenCalledWith('We Energies', '2025-06-15', 'America/Chicago');
      expect(res.effectiveDate).toBe('2025-06-15');
      expect(res.currency).toBe('USD');
      expect(res.unit).toBe('kWh');
      expect(res.plans.map(p => p.label)).toEqual(['urdb-published-flat', 'urdb-tiered-tou']);

      const tiered = res.plans.find(p => p.label === 'urdb-tiered-tou')!;
      expect(tiered.kind).toBe('time_of_use');
      expect(tiered.exportRateProvenance).toBe('inherited');
      expect(tiered.seasons[0].weekdayPeriods).toEqual([
        { touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 16, toMinute: 0, buyRate: 0.15, sellRate: 0.05 },
        { touName: 'ON_PEAK', fromHour: 16, fromMinute: 0, toHour: 21, toMinute: 0, buyRate: 0.35, sellRate: 0.05 },
        { touName: 'OFF_PEAK', fromHour: 21, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.15, sellRate: 0.05 },
      ]);
      expect(tiered.approximationNotes.map(n => n.kind)).toEqual([
        'tier_blended',
        'export_inherited_from_tesla',
      ]);

      const published = res.plans.find(p => p.label === 'urdb-published-flat')!;
      expect(published.exportRateProvenance).toBe('published');
      expect(published.approximationNotes).toEqual([]);
      expect(published.seasons[0].weekdayPeriods[0]).toMatchObject({ buyRate: 0.19, sellRate: 0.08 });
    });

    it('treats explicit sell: null in URDB energyratestructure as missing export pricing rather than published', async () => {
      const nullSellRate = JSON.parse(JSON.stringify(makePublishedRate({
        label: 'urdb-null-sell',
        name: 'Null Sell Plan',
        dgrules: 'Buy All Sell All',
        energyratestructure: [[{ rate: 0.21 }]],
      }))) as UrdbRate;
      (nullSellRate.energyratestructure![0]![0] as { rate: number; sell?: number | null }).sell = null as unknown as number;

      const repo = new TariffTimelineRepo();
      vi.spyOn(repo, 'getSiteUtilityContext').mockResolvedValue({
        name: 'We Energies',
        timezone: 'America/Chicago',
        currency: 'USD',
        choice: 'owner',
      });
      vi.spyOn(repo, 'loadSitePublicConversionContext').mockResolvedValue({
        fallbackSellRate: 0.05,
        hasTeslaSellFallback: true,
      });

      const res = await listPublicUtilityPlansForSite(
        'site-1',
        { effectiveDate: '2025-06-15', now: fixedNow() },
        {
          repo,
          urdb: { ratesEffectiveOn: async () => [nullSellRate], rateByLabel: vi.fn() },
          monthlyUsage: async () => 500,
        }
      );

      expect(res.plans).toHaveLength(1);
      expect(res.plans[0].exportRateProvenance).toBe('inherited');
      expect(res.plans[0].seasons[0].weekdayPeriods[0]).toMatchObject({ buyRate: 0.21, sellRate: 0.05 });
      expect(res.plans[0].approximationNotes.map(n => n.kind)).toEqual(['export_inherited_from_tesla']);
    });

    it('rejects currency-incompatible sites and invalid effectiveDate query values', async () => {
      const repo = new TariffTimelineRepo();
      vi.spyOn(repo, 'getSiteUtilityContext').mockResolvedValue({
        name: 'We Energies',
        timezone: 'America/Chicago',
        currency: 'EUR',
        choice: 'owner',
      });
      const ratesEffectiveOn = vi.fn();

      await expect(
        listPublicUtilityPlansForSite('site-1', { now: fixedNow() }, { repo, urdb: { ratesEffectiveOn, rateByLabel: vi.fn() } })
      ).rejects.toThrow(TariffValidationError);
      expect(ratesEffectiveOn).not.toHaveBeenCalled();

      vi.spyOn(repo, 'getSiteUtilityContext').mockResolvedValue({
        name: 'We Energies',
        timezone: 'America/Chicago',
        currency: 'USD',
        choice: 'owner',
      });
      await expect(
        listPublicUtilityPlansForSite(
          'site-1',
          { effectiveDate: '2025-02-29', now: fixedNow() },
          { repo, urdb: { ratesEffectiveOn, rateByLabel: vi.fn() } }
        )
      ).rejects.toThrow(TariffValidationError);
    });
  });

  describe('previewTariffSelection', () => {
    it('resolves a public plan outside any DB lock and preserves replaced Tesla originals', async () => {
      const tesla = makeTeslaSnapshot(10, 'Tesla Rg2', 1, teslaSeasons);
      const repo = new TariffTimelineRepo();
      vi.spyOn(repo, 'getSiteUtilityContext').mockResolvedValue({
        name: 'We Energies',
        timezone: 'America/Chicago',
        currency: 'USD',
        choice: 'owner',
      });
      vi.spyOn(repo, 'loadSelectionTimelineSnapshot').mockResolvedValue({
        fallbackSellRate: 0.05,
        hasTeslaSellFallback: true,
        existingSpans: [{ effectiveFrom: '2025-01-01', effectiveTo: null, plan: tesla }],
        restorationTargets: [],
        manualNameTaken: false,
      });

      const rate = makeTieredNonNetMeteringRate({
        dgrules: 'Net Metering',
        energyratestructure: [[{ rate: 0.1, max: 300, unit: 'kWh' }, { rate: 0.2, unit: 'kWh' }], [{ rate: 0.35 }]],
      });
      const rateByLabel = vi.fn(async () => rate);
      const ratesEffectiveOn = vi.fn(async () => [rate]);

      const preview = await previewTariffSelection(
        'site-1',
        'user-1',
        {
          scope: 'actual',
          candidate: { kind: 'public', label: 'urdb-tiered-tou' },
          effectiveFrom: '2025-03-01',
          effectiveTo: '2025-09-30',
        },
        {
          now: fixedNow,
          repo,
          urdb: { rateByLabel, ratesEffectiveOn },
          monthlyUsage: async () => 600,
        }
      );

      expect(dbMocks.connectMock).not.toHaveBeenCalled();
      expect(preview.reviewHash).toMatch(/^[a-f0-9]{64}$/);
      expect(preview.affectsPowerwallPlan).toBe(false);
      expect(preview.candidatePlan?.source).toBe('estimated');
      expect(preview.candidatePlan?.choiceKind).toBe('owner');
      expect(preview.candidatePlan?.exportRateProvenance).toBe('net_metering');
      expect(preview.approximationNotes.map(n => n.kind)).toEqual([
        'tier_blended',
        'export_net_metering_assumed',
      ]);
      expect(preview.affectedIntervals).toHaveLength(1);
      expect(preview.affectedIntervals[0].kind).toBe('replace');
      expect(preview.unchangedOutsidePeriods.map(p => [p.effectiveFrom, p.effectiveTo])).toEqual([
        ['2025-01-01', '2025-02-28'],
        ['2025-10-01', null],
      ]);
      expect(preview.restoration.preservedOriginals).toHaveLength(1);
      expect(preview.restoration.preservedOriginals[0]).toMatchObject({
        tariffId: 10,
        name: 'Tesla Rg2',
        effectiveFrom: '2025-03-01',
        effectiveTo: '2025-09-30',
      });
    });

    it('rejects missing dates, malformed candidates, currency incompatibility, and reference restoration', async () => {
      const repo = new TariffTimelineRepo();
      vi.spyOn(repo, 'getSiteUtilityContext').mockResolvedValue({
        name: 'We Energies',
        timezone: 'America/Chicago',
        currency: 'USD',
        choice: 'owner',
      });

      await expect(
        previewTariffSelection(
          'site-1',
          'user-1',
          { scope: 'actual', candidate: { kind: 'public', label: 'x' }, effectiveFrom: '' },
          { now: fixedNow, repo, urdb: { rateByLabel: vi.fn(), ratesEffectiveOn: vi.fn() } }
        )
      ).rejects.toThrow(TariffValidationError);

      await expect(
        previewTariffSelection(
          'site-1',
          'user-1',
          {
            scope: 'reference',
            candidate: { kind: 'restore_tesla', originalSelectionId: 10 },
            effectiveFrom: '2025-01-01',
            effectiveTo: null,
          },
          { now: fixedNow, repo, urdb: { rateByLabel: vi.fn(), ratesEffectiveOn: vi.fn() } }
        )
      ).rejects.toThrow(TariffValidationError);

      vi.spyOn(repo, 'getSiteUtilityContext').mockResolvedValueOnce({
        name: 'We Energies',
        timezone: 'America/Chicago',
        currency: 'CAD',
        choice: 'owner',
      });
      await expect(
        previewTariffSelection(
          'site-1',
          'user-1',
          {
            scope: 'actual',
            candidate: { kind: 'public', label: 'urdb-1' },
            effectiveFrom: '2025-01-01',
            effectiveTo: null,
          },
          { now: fixedNow, repo, urdb: { rateByLabel: vi.fn(), ratesEffectiveOn: vi.fn() } }
        )
      ).rejects.toThrow(TariffValidationError);

      // Unsupported candidate rate (e.g., too many periods / invalid schedule) must be rejected, not transformed.
      const badRate: UrdbRate = {
        label: 'bad-rate',
        name: 'Bad Rate',
        utility: 'We Energies',
        startdate: 1_735_689_600,
        energyratestructure: [],
        energyweekdayschedule: [],
        energyweekendschedule: [],
      };
      await expect(
        previewTariffSelection(
          'site-1',
          'user-1',
          {
            scope: 'actual',
            candidate: { kind: 'public', label: 'bad-rate' },
            effectiveFrom: '2025-01-01',
            effectiveTo: null,
          },
          {
            now: fixedNow,
            repo,
            urdb: { rateByLabel: async () => badRate, ratesEffectiveOn: vi.fn() },
            monthlyUsage: async () => null,
          }
        )
      ).rejects.toThrow(TariffValidationError);
    });
  });

  describe('commitTariffSelection', () => {
    it('resolves public rates before acquiring the site lock, validates reviewHash under lock, and rolls back on failure', async () => {
      const rate = makePublishedRate();
      const events: string[] = [];

      clientQueryHandler = async (sql: string) => {
        if (sql === 'BEGIN') {
          events.push('db:BEGIN');
          return { rows: [] };
        }
        if (sql.includes('FROM "Site" WHERE id = $1 FOR UPDATE')) {
          events.push('db:LOCK_SITE');
          return { rows: [{ id: 'site-1', timezone: 'America/Chicago', currency: 'USD' }] };
        }
        if (sql.includes('FROM "SiteUtility"') && sql.includes('updated_at >')) {
          return { rows: [] };
        }
        if (sql.includes('FROM "SiteUtility"')) {
          return { rows: [{ urdb_utility: 'Wisconsin Electric Power Co', choice: 'owner' }] };
        }
        if (sql.includes('COALESCE(MAX(version), 0) + 1')) {
          return { rows: [{ next: 1 }] };
        }
        if (sql.includes('FROM "TariffEffectivePeriod"') && sql.includes('ORDER BY effective_from ASC')) {
          return { rows: [] };
        }
        if (sql.includes('FROM "Tariff" WHERE site_id = $1 AND source = \'tesla\'')) {
          return { rows: [] };
        }
        if (sql.includes('INSERT INTO "Tariff"(')) {
          return { rows: [{ id: 77 }] };
        }
        if (sql.includes('INSERT INTO "TariffSeason"(')) {
          return { rows: [{ id: 177 }] };
        }
        if (sql.includes('INSERT INTO "TariffSelection"')) {
          return { rows: [{ id: 501 }] };
        }
        if (sql.includes('INSERT INTO "TariffEffectivePeriod"')) {
          return { rows: [{ id: 601 }] };
        }
        if (sql.includes('INSERT INTO "SiteTariffReattribution"')) {
          return {
            rows: [{
              site_id: 'site-1', status: 'pending', generation: 1, from_date: '2025-01-01', to_date: null,
              cursor_day_start: null, total_days: 10, processed_days: 0, updated_days: 0, attempt_count: 0,
              last_error: null, requested_by_user_id: 'user-1', updated_at: new Date(),
            }],
          };
        }
        if (sql === 'COMMIT') {
          events.push('db:COMMIT');
        }
        return { rows: [] };
      };

      dbMocks.queryMock.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM "Site" s') && sql.includes('WHERE s.id = $1')) {
          return { rows: [{ name: 'Wisconsin Electric Power Co', timezone: 'America/Chicago', currency: 'USD', choice: 'owner' }] };
        }
        if (sql.includes('FROM "Site"') && sql.includes('WHERE id = $1')) {
          return { rows: [{ id: 'site-1', timezone: 'America/Chicago', installed: '2024-01-01T06:00:00Z', currency: 'USD' }] };
        }
        if (sql.includes('FROM "SiteUtility"') && sql.includes('updated_at >')) {
          return { rows: [] };
        }
        if (sql.includes('FROM "SiteUtility"')) {
          return { rows: [{ urdb_utility: 'Wisconsin Electric Power Co', choice: 'owner' }] };
        }
        return { rows: [] };
      });

      const rateByLabel = vi.fn(async () => {
        events.push('urdb:rateByLabel');
        return rate;
      });

      const repo = new TariffTimelineRepo();
      const preview = await previewTariffSelection(
        'site-1',
        'user-1',
        {
          scope: 'actual',
          candidate: { kind: 'public', label: 'urdb-published-flat' },
          effectiveFrom: '2025-01-01',
          effectiveTo: null,
        },
        {
          now: fixedNow,
          repo,
          urdb: { rateByLabel, ratesEffectiveOn: vi.fn() },
          monthlyUsage: async () => null,
        }
      );
      events.length = 0;

      const committed = await commitTariffSelection(
        'site-1',
        'user-1',
        {
          scope: 'actual',
          candidate: { kind: 'public', label: 'urdb-published-flat' },
          effectiveFrom: '2025-01-01',
          effectiveTo: null,
          expectedReviewHash: preview.reviewHash,
          verifiedAgainstBill: true,
        },
        {
          now: fixedNow,
          repo,
          urdb: { rateByLabel, ratesEffectiveOn: vi.fn() },
          monthlyUsage: async () => null,
        }
      );

      // Remote network request MUST finish before BEGIN / FOR UPDATE site lock.
      const urdbIndex = events.indexOf('urdb:rateByLabel');
      const beginIndex = events.indexOf('db:BEGIN');
      expect(urdbIndex).toBeGreaterThan(-1);
      expect(beginIndex).toBeGreaterThan(urdbIndex);
      expect(committed.selectionIds).toEqual([501]);
      expect(committed.unchanged).toBe(false);
      const insertSelectionQuery = clientQueries.find(q => q.sql.includes('INSERT INTO "TariffSelection"'));
      expect(insertSelectionQuery?.params).toContain(preview.reviewHash);
      expect(dbMocks.invalidateCacheMock).toHaveBeenCalledWith('site-1');

      // Transaction rollback on DB failure inside commit:
      clientQueryHandler = async (sql: string) => {
        if (sql.includes('FROM "Site" WHERE id = $1 FOR UPDATE')) {
          return { rows: [{ id: 'site-1', timezone: 'America/Chicago', currency: 'USD' }] };
        }
        if (sql.includes('FROM "SiteUtility"') && sql.includes('updated_at >')) {
          return { rows: [] };
        }
        if (sql.includes('FROM "SiteUtility"')) {
          return { rows: [{ urdb_utility: 'Wisconsin Electric Power Co', choice: 'owner' }] };
        }
        if (sql.includes('COALESCE(MAX(version), 0) + 1')) {
          return { rows: [{ next: 1 }] };
        }
        if (sql.includes('INSERT INTO "Tariff"(')) {
          return { rows: [{ id: 78 }] };
        }
        if (sql.includes('INSERT INTO "TariffSeason"(')) {
          return { rows: [{ id: 178 }] };
        }
        if (sql.includes('INSERT INTO "TariffSelection"')) {
          throw new Error('simulated DB error');
        }
        return { rows: [] };
      };
      dbMocks.invalidateCacheMock.mockClear();
      await expect(
        commitTariffSelection(
          'site-1',
          'user-1',
          {
            scope: 'actual',
            candidate: { kind: 'public', label: 'urdb-published-flat' },
            effectiveFrom: '2025-01-01',
            effectiveTo: null,
            expectedReviewHash: preview.reviewHash,
            verifiedAgainstBill: true,
          },
          {
            now: fixedNow,
            repo,
            urdb: { rateByLabel, ratesEffectiveOn: vi.fn() },
            monthlyUsage: async () => null,
          }
        )
      ).rejects.toThrow('simulated DB error');
      expect(clientQueries.some(q => q.sql === 'ROLLBACK')).toBe(true);
      expect(dbMocks.invalidateCacheMock).not.toHaveBeenCalled();
    });

    it('returns TariffSelectionConflictError (409) when timeline or public rate changed between preview and commit', async () => {
      const rateV1 = makePublishedRate({ energyratestructure: [[{ rate: 0.19, sell: 0.08 }]] });
      const rateV2 = makePublishedRate({ energyratestructure: [[{ rate: 0.24, sell: 0.08 }]] });
      const tesla = makeTeslaSnapshot(10, 'Tesla Plan', 1, teslaSeasons);
      const repo = new TariffTimelineRepo();

      vi.spyOn(repo, 'getSiteUtilityContext').mockResolvedValue({
        name: 'Wisconsin Electric Power Co',
        timezone: 'America/Chicago',
        currency: 'USD',
        choice: 'owner',
      });
      vi.spyOn(repo, 'loadSelectionTimelineSnapshot').mockResolvedValue({
        fallbackSellRate: 0.05,
        hasTeslaSellFallback: true,
        existingSpans: [{ effectiveFrom: '2025-01-01', effectiveTo: null, plan: tesla }],
        restorationTargets: [],
        manualNameTaken: false,
      });

      const preview = await previewTariffSelection(
        'site-1',
        'user-1',
        {
          scope: 'actual',
          candidate: { kind: 'public', label: 'urdb-published-flat' },
          effectiveFrom: '2025-01-01',
          effectiveTo: null,
        },
        {
          now: fixedNow,
          repo,
          urdb: { rateByLabel: async () => rateV1, ratesEffectiveOn: vi.fn() },
          monthlyUsage: async () => null,
        }
      );

      clientQueryHandler = async (sql: string) => {
        if (sql.includes('FROM "Site" WHERE id = $1 FOR UPDATE')) {
          return { rows: [{ id: 'site-1', timezone: 'America/Chicago', currency: 'USD' }] };
        }
        if (sql.includes('FROM "SiteUtility"') && sql.includes('updated_at >')) {
          return { rows: [] };
        }
        if (sql.includes('FROM "SiteUtility"')) {
          return { rows: [{ urdb_utility: 'Wisconsin Electric Power Co', choice: 'owner' }] };
        }
        if (sql.includes('FROM "TariffEffectivePeriod" p') && sql.includes('LEFT JOIN "TariffSelection" sel')) {
          return {
            rows: [{
              period_id: 100,
              tariff_id: 10,
              effective_from: '2025-01-01',
              effective_to: null,
              source: 'tesla',
              updated_by_user_id: null,
              updated_by_email: null,
              name: 'Tesla Plan',
              version: 1,
              content_hash: tesla.contentHash,
              selection_id: 1000,
              choice_kind: 'automatic',
            }],
          };
        }
        if (sql.includes('FROM "Tariff"') && sql.includes('id = ANY')) {
          return {
            rows: [{
              id: 10, site_id: 'site-1', version: 1, name: 'Tesla Plan', is_current: true,
              updated: new Date(), content_hash: tesla.contentHash, source: 'tesla',
            }],
          };
        }
        if (sql.includes('FROM "TariffSeason"')) {
          return {
            rows: [{ id: 20, tariff_id: 10, name: 'All Year', from_month: 1, from_day: 1, to_month: 12, to_day: 31, buy_rate: 0.15, sell_rate: 0.05 }],
          };
        }
        if (sql.includes('FROM "TariffSchedule"')) {
          return {
            rows: [{ id: 30, season_id: 20, name: 'OFF_PEAK', buy_rate: 0.15, sell_rate: 0.05, from_day_of_week: 0, to_day_of_week: 6, from_hour: 0, from_minute: 0, to_hour: 24, to_minute: 0 }],
          };
        }
        return { rows: [] };
      };
      dbMocks.queryMock.mockResolvedValue({
        rows: [{ id: 'site-1', timezone: 'America/Chicago', currency: 'USD', urdb_utility: 'Wisconsin Electric Power Co', choice: 'owner' }],
      });

      // Public rate changed between preview (rateV1) and commit (rateV2):
      let caught: unknown;
      try {
        await commitTariffSelection(
          'site-1',
          'user-1',
          {
            scope: 'actual',
            candidate: { kind: 'public', label: 'urdb-published-flat' },
            effectiveFrom: '2025-01-01',
            effectiveTo: null,
            expectedReviewHash: preview.reviewHash,
            verifiedAgainstBill: false,
          },
          {
            now: fixedNow,
            repo,
            urdb: { rateByLabel: async () => rateV2, ratesEffectiveOn: vi.fn() },
            monthlyUsage: async () => null,
          }
        );
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(TariffSelectionConflictError);
      const conflict = caught as TariffSelectionConflictError;
      expect(conflict.status).toBe(409);
      expect(conflict.code).toBe('REVIEW_STALE');
      expect(conflict.refreshPath).toBe('/api/site/site-1/tariffs/selection/preview');
      expect(conflict.preview.reviewHash).not.toBe(preview.reviewHash);
      expect(conflict.preview.candidatePlan?.seasons[0].weekdayPeriods[0].buyRate).toBe(0.24);
      expect(clientQueries.some(q => q.sql.includes('INSERT INTO "TariffSelection"'))).toBe(false);
    });

    it('supports idempotent duplicate commit retries while rejecting old reviews replayed after timeline changes', async () => {
      const rate = makePublishedRate();
      const candidateHash = tariffContentHash(
        compileSeasonsToParsedTariff('Published Export Flat', [
          {
            name: 'Season 1',
            fromMonth: 1,
            toMonth: 12,
            weekdayPeriods: [{ touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.19, sellRate: 0.08 }],
            weekendPeriods: [{ touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.19, sellRate: 0.08 }],
          },
        ])
      );
      const tesla = makeTeslaSnapshot(10, 'Tesla Plan', 1, teslaSeasons);
      const repo = new TariffTimelineRepo();

      // Step 1: Preview against Tesla
      vi.spyOn(repo, 'getSiteUtilityContext').mockResolvedValue({
        name: 'Wisconsin Electric Power Co',
        timezone: 'America/Chicago',
        currency: 'USD',
        choice: 'owner',
      });
      vi.spyOn(repo, 'loadSelectionTimelineSnapshot').mockResolvedValue({
        fallbackSellRate: 0.05,
        hasTeslaSellFallback: true,
        existingSpans: [{ effectiveFrom: '2025-01-01', effectiveTo: null, plan: tesla }],
        restorationTargets: [],
        manualNameTaken: false,
      });

      const preview = await previewTariffSelection(
        'site-1',
        'user-1',
        {
          scope: 'actual',
          candidate: { kind: 'public', label: 'urdb-published-flat' },
          effectiveFrom: '2025-01-01',
          effectiveTo: null,
        },
        {
          now: fixedNow,
          repo,
          urdb: { rateByLabel: async () => rate, ratesEffectiveOn: vi.fn() },
          monthlyUsage: async () => null,
        }
      );

      // Step 2: Retry commit when selection 501 is STILL the latest active selection matching the commit
      const selectionCreatedAt = new Date('2026-11-17T18:00:01Z');
      let latestSelectionId = 501;
      let siteTimelineRevision = 1;
      let siteUtilityUpdatedAt = new Date('2026-11-17T17:00:00Z');
      clientQueryHandler = async (sql: string) => {
        if (sql.includes('FROM "Site" WHERE id = $1 FOR UPDATE')) {
          return { rows: [{ id: 'site-1', timezone: 'America/Chicago', currency: 'USD', timeline_revision: siteTimelineRevision }] };
        }
        if (sql.includes('SELECT timeline_revision FROM "Site" WHERE id = $1')) {
          return { rows: [{ timeline_revision: siteTimelineRevision }] };
        }
        if (sql.includes('FROM "SiteUtility"') && sql.includes('updated_at >')) {
          return { rows: siteUtilityUpdatedAt > selectionCreatedAt ? [{ site_id: 'site-1' }] : [] };
        }
        if (sql.includes('FROM "SiteUtility"')) {
          return { rows: [{ urdb_utility: 'Wisconsin Electric Power Co', choice: 'owner' }] };
        }
        if (sql.includes('FROM "TariffEffectivePeriod" p') && sql.includes('LEFT JOIN "TariffSelection" sel')) {
          return {
            rows: [{
              period_id: 601,
              tariff_id: 77,
              effective_from: '2025-01-01',
              effective_to: null,
              source: 'estimated',
              updated_by_user_id: 'user-1',
              updated_by_email: 'owner@example.com',
              name: 'Published Export Flat',
              version: 1,
              content_hash: candidateHash,
              selection_id: 501,
              choice_kind: 'owner',
              candidate_kind: 'public',
              selected_by_user_id: 'user-1',
              urdb_label: 'urdb-published-flat',
              utility_name: 'Wisconsin Electric Power Co',
              revision_start: '2025-01-01',
              export_rate_provenance: 'published',
              holidays_use_weekend: true,
              approximation_notes: [],
            }],
          };
        }
        if (sql.includes('FROM "TariffEffectivePeriod"') && sql.includes('ORDER BY effective_from ASC')) {
          return {
            rows: [{
              id: 601,
              tariff_id: 77,
              source: 'estimated',
              effective_from: '2025-01-01',
              effective_to: null,
              updated_by_user_id: 'user-1',
              selection_id: 501,
              choice_kind: 'owner',
            }],
          };
        }
        if (sql.includes('FROM "Tariff"') && sql.includes('id = ANY')) {
          return {
            rows: [{
              id: 77, site_id: 'site-1', version: 1, name: 'Published Export Flat', is_current: true,
              updated: selectionCreatedAt, content_hash: candidateHash, source: 'estimated',
            }],
          };
        }
        if (sql.includes('FROM "TariffSeason"')) {
          return {
            rows: [{ id: 177, tariff_id: 77, name: 'All Year', from_month: 1, from_day: 1, to_month: 12, to_day: 31, buy_rate: 0.19, sell_rate: 0.08 }],
          };
        }
        if (sql.includes('FROM "TariffSchedule"')) {
          return {
            rows: [{ id: 277, season_id: 177, name: 'OFF_PEAK', buy_rate: 0.19, sell_rate: 0.08, from_day_of_week: 0, to_day_of_week: 6, from_hour: 0, from_minute: 0, to_hour: 24, to_minute: 0 }],
          };
        }
        if (sql.includes('FROM "TariffSelection"') && sql.includes('WHERE site_id = $1 AND scope = $2') && sql.includes('id = ANY')) {
          return {
            rows: [{
              id: 501,
              site_id: 'site-1',
              scope: 'actual',
              tariff_id: 77,
              effective_from: '2025-01-01',
              effective_to: null,
              source: 'estimated',
              choice_kind: 'owner',
              candidate_kind: 'public',
              selected_by_user_id: 'user-1',
              urdb_label: 'urdb-published-flat',
              utility_name: 'Wisconsin Electric Power Co',
              revision_start: '2025-01-01',
              export_rate_provenance: 'published',
              holidays_use_weekend: true,
              approximation_notes: [],
              selected_content_hash: candidateHash,
              restored_from_selection_id: null,
              review_hash: preview.reviewHash,
              timeline_revision: 1,
              created_at: selectionCreatedAt,
            }],
          };
        }
        if (sql.includes('MAX(id)') && sql.includes('FROM "TariffSelection"')) {
          return { rows: [{ max_id: latestSelectionId }] };
        }
        if (sql.includes('FROM "TariffSelectionVerification"')) {
          return { rows: [] };
        }
        return { rows: [] };
      };
      dbMocks.queryMock.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM "Site" s') && sql.includes('WHERE s.id = $1')) {
          return { rows: [{ name: 'Wisconsin Electric Power Co', timezone: 'America/Chicago', currency: 'USD', choice: 'owner' }] };
        }
        if (sql.includes('FROM "Site"') && sql.includes('WHERE id = $1')) {
          return { rows: [{ id: 'site-1', timezone: 'America/Chicago', installed: '2024-01-01T06:00:00Z', currency: 'USD' }] };
        }
        return { rows: [] };
      });

      const retryResult = await commitTariffSelection(
        'site-1',
        'user-1',
        {
          scope: 'actual',
          candidate: { kind: 'public', label: 'urdb-published-flat' },
          effectiveFrom: '2025-01-01',
          effectiveTo: null,
          expectedReviewHash: preview.reviewHash,
          verifiedAgainstBill: false,
        },
        {
          now: fixedNow,
          repo,
          urdb: { rateByLabel: async () => rate, ratesEffectiveOn: vi.fn() },
          monthlyUsage: async () => null,
        }
      );

      expect(retryResult.unchanged).toBe(true);
      expect(retryResult.selectionIds).toEqual([501]);
      expect(clientQueries.some(q => q.sql.includes('INSERT INTO "TariffSelection"'))).toBe(false);
      expect(clientQueries.some(q => q.sql.includes('INSERT INTO "SiteTariffReattribution"'))).toBe(false);

      // Step 2b: Replaying with a mismatched/stale expectedReviewHash MUST conflict (409) instead of returning unchanged: true
      await expect(
        commitTariffSelection(
          'site-1',
          'user-1',
          {
            scope: 'actual',
            candidate: { kind: 'public', label: 'urdb-published-flat' },
            effectiveFrom: '2025-01-01',
            effectiveTo: null,
            expectedReviewHash: 'f'.repeat(64),
            verifiedAgainstBill: false,
          },
          {
            now: fixedNow,
            repo,
            urdb: { rateByLabel: async () => rate, ratesEffectiveOn: vi.fn() },
            monthlyUsage: async () => null,
          }
        )
      ).rejects.toThrow(TariffSelectionConflictError);

      // Step 2c: A non-inserting deletion (timeline_revision incremented without new selection/period rows) MUST conflict (409)
      siteTimelineRevision = 2;
      await expect(
        commitTariffSelection(
          'site-1',
          'user-1',
          {
            scope: 'actual',
            candidate: { kind: 'public', label: 'urdb-published-flat' },
            effectiveFrom: '2025-01-01',
            effectiveTo: null,
            expectedReviewHash: preview.reviewHash,
            verifiedAgainstBill: false,
          },
          {
            now: fixedNow,
            repo,
            urdb: { rateByLabel: async () => rate, ratesEffectiveOn: vi.fn() },
            monthlyUsage: async () => null,
          }
        )
      ).rejects.toThrow(TariffSelectionConflictError);
      siteTimelineRevision = 1;

      // Step 2d: A SiteUtility change after the selection MUST conflict (409)
      siteUtilityUpdatedAt = new Date('2026-11-17T18:00:05Z');
      await expect(
        commitTariffSelection(
          'site-1',
          'user-1',
          {
            scope: 'actual',
            candidate: { kind: 'public', label: 'urdb-published-flat' },
            effectiveFrom: '2025-01-01',
            effectiveTo: null,
            expectedReviewHash: preview.reviewHash,
            verifiedAgainstBill: false,
          },
          {
            now: fixedNow,
            repo,
            urdb: { rateByLabel: async () => rate, ratesEffectiveOn: vi.fn() },
            monthlyUsage: async () => null,
          }
        )
      ).rejects.toThrow(TariffSelectionConflictError);
      siteUtilityUpdatedAt = new Date('2026-11-17T17:00:00Z');

      // Step 3: If another selection (id = 502) happened afterwards, replaying old review MUST conflict (409)
      latestSelectionId = 502;
      await expect(
        commitTariffSelection(
          'site-1',
          'user-1',
          {
            scope: 'actual',
            candidate: { kind: 'public', label: 'urdb-published-flat' },
            effectiveFrom: '2025-01-01',
            effectiveTo: null,
            expectedReviewHash: preview.reviewHash,
            verifiedAgainstBill: false,
          },
          {
            now: fixedNow,
            repo,
            urdb: { rateByLabel: async () => rate, ratesEffectiveOn: vi.fn() },
            monthlyUsage: async () => null,
          }
        )
      ).rejects.toThrow(TariffSelectionConflictError);
    });

    it('supports idempotent duplicate commit retries when a selection is partitioned across multiple TariffSelectionOriginal sub-spans', async () => {
      const rate = makePublishedRate();
      const candidateHash = tariffContentHash(
        compileSeasonsToParsedTariff('Published Export Flat', [
          {
            name: 'Season 1',
            fromMonth: 1,
            toMonth: 12,
            weekdayPeriods: [{ touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.19, sellRate: 0.08 }],
            weekendPeriods: [{ touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.19, sellRate: 0.08 }],
          },
        ])
      );
      const teslaV1 = makeTeslaSnapshot(10, 'Tesla v1', 1, teslaSeasons);
      const teslaV2 = makeTeslaSnapshot(11, 'Tesla v2', 2, sampleSeasons);
      const repo = new TariffTimelineRepo();

      vi.spyOn(repo, 'getSiteUtilityContext').mockResolvedValue({
        name: 'Wisconsin Electric Power Co',
        timezone: 'America/Chicago',
        currency: 'USD',
        choice: 'owner',
      });
      vi.spyOn(repo, 'loadSelectionTimelineSnapshot').mockResolvedValueOnce({
        fallbackSellRate: 0.05,
        hasTeslaSellFallback: true,
        existingSpans: [
          { effectiveFrom: '2025-01-01', effectiveTo: '2025-06-30', plan: teslaV1 },
          { effectiveFrom: '2025-07-01', effectiveTo: '2025-12-31', plan: teslaV2 },
        ],
        restorationTargets: [],
        manualNameTaken: false,
      });

      const preview = await previewTariffSelection(
        'site-1',
        'user-1',
        {
          scope: 'actual',
          candidate: { kind: 'public', label: 'urdb-published-flat' },
          effectiveFrom: '2025-01-01',
          effectiveTo: '2025-12-31',
        },
        {
          now: fixedNow,
          repo,
          urdb: { rateByLabel: async () => rate, ratesEffectiveOn: vi.fn() },
          monthlyUsage: async () => null,
        }
      );

      // Partitioned across two TariffSelectionOriginal sub-spans AND represented as two contiguous period segments sharing selection_id = 501.
      const selectionCreatedAt = new Date('2026-11-17T18:00:01Z');
      const partitionedRows = [
        {
          id: 601,
          period_id: 601,
          tariff_id: 77,
          effective_from: '2025-01-01',
          effective_to: '2025-06-30',
          source: 'estimated',
          updated_by_user_id: 'user-1',
          updated_by_email: 'owner@example.com',
          name: 'Published Export Flat',
          version: 1,
          content_hash: candidateHash,
          selection_id: 501,
          choice_kind: 'owner',
          candidate_kind: 'public',
          selected_by_user_id: 'user-1',
          urdb_label: 'urdb-published-flat',
          utility_name: 'Wisconsin Electric Power Co',
          revision_start: '2025-01-01',
          export_rate_provenance: 'published',
          holidays_use_weekend: true,
          approximation_notes: [],
        },
        {
          id: 602,
          period_id: 602,
          tariff_id: 77,
          effective_from: '2025-07-01',
          effective_to: '2025-12-31',
          source: 'estimated',
          updated_by_user_id: 'user-1',
          updated_by_email: 'owner@example.com',
          name: 'Published Export Flat',
          version: 1,
          content_hash: candidateHash,
          selection_id: 501,
          choice_kind: 'owner',
          candidate_kind: 'public',
          selected_by_user_id: 'user-1',
          urdb_label: 'urdb-published-flat',
          utility_name: 'Wisconsin Electric Power Co',
          revision_start: '2025-01-01',
          export_rate_provenance: 'published',
          holidays_use_weekend: true,
          approximation_notes: [],
        },
      ];

      clientQueryHandler = async (sql: string) => {
        if (sql.includes('FROM "Site" WHERE id = $1 FOR UPDATE')) {
          return { rows: [{ id: 'site-1', timezone: 'America/Chicago', currency: 'USD' }] };
        }
        if (sql.includes('FROM "SiteUtility"') && sql.includes('updated_at >')) {
          return { rows: [] };
        }
        if (sql.includes('FROM "SiteUtility"')) {
          return { rows: [{ urdb_utility: 'Wisconsin Electric Power Co', choice: 'owner' }] };
        }
        if (sql.includes('FROM "TariffEffectivePeriod" p') && sql.includes('LEFT JOIN "TariffSelection" sel')) {
          return { rows: partitionedRows };
        }
        if (sql.includes('FROM "TariffEffectivePeriod"') && sql.includes('ORDER BY effective_from ASC')) {
          return { rows: partitionedRows };
        }
        if (sql.includes('FROM "TariffSelectionOriginal" o')) {
          return {
            rows: [
              {
                selection_id: 501,
                effective_from: '2025-01-01',
                effective_to: '2025-06-30',
                original_tariff_id: 10,
                original_selection_id: null,
                name: 'Tesla v1',
                version: 1,
                content_hash: teslaV1.contentHash,
              },
              {
                selection_id: 501,
                effective_from: '2025-07-01',
                effective_to: '2025-12-31',
                original_tariff_id: 11,
                original_selection_id: null,
                name: 'Tesla v2',
                version: 2,
                content_hash: teslaV2.contentHash,
              },
            ],
          };
        }
        if (sql.includes('FROM "Tariff"') && sql.includes('id = ANY')) {
          return {
            rows: [{
              id: 77, site_id: 'site-1', version: 1, name: 'Published Export Flat', is_current: true,
              updated: selectionCreatedAt, content_hash: candidateHash, source: 'estimated',
            }],
          };
        }
        if (sql.includes('FROM "TariffSeason"')) {
          return {
            rows: [{ id: 177, tariff_id: 77, name: 'All Year', from_month: 1, from_day: 1, to_month: 12, to_day: 31, buy_rate: 0.19, sell_rate: 0.08 }],
          };
        }
        if (sql.includes('FROM "TariffSchedule"')) {
          return {
            rows: [{ id: 277, season_id: 177, name: 'OFF_PEAK', buy_rate: 0.19, sell_rate: 0.08, from_day_of_week: 0, to_day_of_week: 6, from_hour: 0, from_minute: 0, to_hour: 24, to_minute: 0 }],
          };
        }
        if (sql.includes('SELECT timeline_revision FROM "Site" WHERE id = $1')) {
          return { rows: [{ timeline_revision: 1 }] };
        }
        if (sql.includes('FROM "TariffSelection"') && sql.includes('WHERE site_id = $1 AND scope = $2') && sql.includes('id = ANY')) {
          return {
            rows: [{
              id: 501,
              site_id: 'site-1',
              scope: 'actual',
              tariff_id: 77,
              effective_from: '2025-01-01',
              effective_to: '2025-12-31',
              source: 'estimated',
              choice_kind: 'owner',
              candidate_kind: 'public',
              selected_by_user_id: 'user-1',
              urdb_label: 'urdb-published-flat',
              utility_name: 'Wisconsin Electric Power Co',
              revision_start: '2025-01-01',
              export_rate_provenance: 'published',
              holidays_use_weekend: true,
              approximation_notes: [],
              selected_content_hash: candidateHash,
              restored_from_selection_id: null,
              review_hash: preview.reviewHash,
              timeline_revision: 1,
              created_at: selectionCreatedAt,
            }],
          };
        }
        if (sql.includes('MAX(id)') && sql.includes('FROM "TariffSelection"')) {
          return { rows: [{ max_id: 501 }] };
        }
        if (sql.includes('FROM "TariffSelectionVerification"')) {
          return { rows: [] };
        }
        return { rows: [] };
      };
      dbMocks.queryMock.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM "Site" s') && sql.includes('WHERE s.id = $1')) {
          return { rows: [{ name: 'Wisconsin Electric Power Co', timezone: 'America/Chicago', currency: 'USD', choice: 'owner' }] };
        }
        if (sql.includes('FROM "Site"') && sql.includes('WHERE id = $1')) {
          return { rows: [{ id: 'site-1', timezone: 'America/Chicago', installed: '2024-01-01T06:00:00Z', currency: 'USD' }] };
        }
        return { rows: [] };
      });

      const retryPublicMulti = await commitTariffSelection(
        'site-1',
        'user-1',
        {
          scope: 'actual',
          candidate: { kind: 'public', label: 'urdb-published-flat' },
          effectiveFrom: '2025-01-01',
          effectiveTo: '2025-12-31',
          expectedReviewHash: preview.reviewHash,
          verifiedAgainstBill: false,
        },
        {
          now: fixedNow,
          repo,
          urdb: { rateByLabel: async () => rate, ratesEffectiveOn: vi.fn() },
          monthlyUsage: async () => null,
        }
      );

      expect(retryPublicMulti.unchanged).toBe(true);
      expect(retryPublicMulti.selectionIds).toEqual([501]);

      // Multi-interval restore_tesla retry where two sequential selection rows were created (t1 < t2)
      const overridePlan: TariffReviewPlanSnapshot = {
        ...makeTeslaSnapshot(20, 'Public Override', 1, sampleSeasons),
        source: 'estimated',
        choiceKind: 'owner',
        selectionId: 300,
        urdbLabel: 'urdb-1',
      };
      vi.spyOn(repo, 'loadSelectionTimelineSnapshot').mockResolvedValueOnce({
        fallbackSellRate: 0.05,
        hasTeslaSellFallback: true,
        existingSpans: [
          {
            effectiveFrom: '2025-01-01',
            effectiveTo: '2025-06-30',
            plan: overridePlan,
            preservedTeslaOriginal: {
              originalSelectionId: 300,
              tariffId: 10,
              name: 'Tesla v1',
              version: 1,
              contentHash: teslaV1.contentHash,
              effectiveFrom: '2025-01-01',
              effectiveTo: '2025-06-30',
            },
          },
          {
            effectiveFrom: '2025-07-01',
            effectiveTo: '2025-12-31',
            plan: overridePlan,
            preservedTeslaOriginal: {
              originalSelectionId: 300,
              tariffId: 11,
              name: 'Tesla v2',
              version: 2,
              contentHash: teslaV2.contentHash,
              effectiveFrom: '2025-07-01',
              effectiveTo: '2025-12-31',
            },
          },
        ],
        restorationTargets: [
          {
            effectiveFrom: '2025-01-01',
            effectiveTo: '2025-06-30',
            original: {
              originalSelectionId: 300,
              tariffId: 10,
              name: 'Tesla v1',
              version: 1,
              contentHash: teslaV1.contentHash,
              effectiveFrom: '2025-01-01',
              effectiveTo: '2025-06-30',
            },
            plan: teslaV1,
          },
          {
            effectiveFrom: '2025-07-01',
            effectiveTo: '2025-12-31',
            original: {
              originalSelectionId: 300,
              tariffId: 11,
              name: 'Tesla v2',
              version: 2,
              contentHash: teslaV2.contentHash,
              effectiveFrom: '2025-07-01',
              effectiveTo: '2025-12-31',
            },
            plan: teslaV2,
          },
        ],
        manualNameTaken: false,
      });

      const restorePreview = await previewTariffSelection(
        'site-1',
        'user-1',
        {
          scope: 'actual',
          candidate: { kind: 'restore_tesla', originalSelectionId: 300 },
          effectiveFrom: '2025-01-01',
          effectiveTo: '2025-12-31',
        },
        { now: fixedNow, repo }
      );

      const restoreCommitAt = new Date('2026-11-17T18:01:00.000Z');
      let selectionRowsForRestore = [
        // Returned in reverse order to verify idempotent matching is order-independent.
        {
          id: 512, site_id: 'site-1', scope: 'actual', tariff_id: 11,
          effective_from: '2025-07-01', effective_to: '2025-12-31', source: 'tesla',
          choice_kind: 'owner', candidate_kind: 'restore_tesla', selected_by_user_id: 'user-1',
          urdb_label: null, utility_name: null, revision_start: null, export_rate_provenance: 'tesla',
          holidays_use_weekend: true, approximation_notes: [], selected_content_hash: teslaV2.contentHash,
          restored_from_selection_id: 300, review_hash: restorePreview.reviewHash, timeline_revision: 2,
          created_at: restoreCommitAt,
        },
        {
          id: 511, site_id: 'site-1', scope: 'actual', tariff_id: 10,
          effective_from: '2025-01-01', effective_to: '2025-06-30', source: 'tesla',
          choice_kind: 'owner', candidate_kind: 'restore_tesla', selected_by_user_id: 'user-1',
          urdb_label: null, utility_name: null, revision_start: null, export_rate_provenance: 'tesla',
          holidays_use_weekend: true, approximation_notes: [], selected_content_hash: teslaV1.contentHash,
          restored_from_selection_id: 300, review_hash: restorePreview.reviewHash, timeline_revision: 2,
          created_at: restoreCommitAt,
        },
      ];
      const restoredSpans = [
        {
          id: 701,
          period_id: 701,
          tariff_id: 10,
          effective_from: '2025-01-01',
          effective_to: '2025-06-30',
          source: 'tesla',
          updated_by_user_id: 'user-1',
          updated_by_email: 'owner@example.com',
          name: 'Tesla v1',
          version: 1,
          content_hash: teslaV1.contentHash,
          selection_id: 511,
          choice_kind: 'owner',
          candidate_kind: 'restore_tesla',
          selected_by_user_id: 'user-1',
          urdb_label: null,
          utility_name: null,
          revision_start: null,
          export_rate_provenance: 'tesla',
          holidays_use_weekend: true,
          approximation_notes: [],
        },
        {
          id: 702,
          period_id: 702,
          tariff_id: 11,
          effective_from: '2025-07-01',
          effective_to: '2025-12-31',
          source: 'tesla',
          updated_by_user_id: 'user-1',
          updated_by_email: 'owner@example.com',
          name: 'Tesla v2',
          version: 2,
          content_hash: teslaV2.contentHash,
          selection_id: 512,
          choice_kind: 'owner',
          candidate_kind: 'restore_tesla',
          selected_by_user_id: 'user-1',
          urdb_label: null,
          utility_name: null,
          revision_start: null,
          export_rate_provenance: 'tesla',
          holidays_use_weekend: true,
          approximation_notes: [],
        },
      ];
      clientQueryHandler = async (sql: string, params?: unknown[]) => {
        if (sql.includes('FROM "Site" WHERE id = $1 FOR UPDATE')) {
          return { rows: [{ id: 'site-1', timezone: 'America/Chicago', currency: 'USD', timeline_revision: 2 }] };
        }
        if (sql.includes('SELECT timeline_revision FROM "Site" WHERE id = $1')) {
          return { rows: [{ timeline_revision: 2 }] };
        }
        if (sql.includes('FROM "SiteUtility"') && sql.includes('updated_at >')) {
          return { rows: [] };
        }
        if (sql.includes('FROM "SiteUtility"')) {
          return { rows: [{ urdb_utility: 'Wisconsin Electric Power Co', choice: 'owner' }] };
        }
        if (sql.includes('WHERE site_id = $1 AND scope = $2 AND original_selection_id = $3')) {
          return {
            rows: [
              { selection_id: 300, effective_from: '2025-01-01', effective_to: '2025-06-30', original_tariff_id: 10, original_selection_id: null },
              { selection_id: 300, effective_from: '2025-07-01', effective_to: '2025-12-31', original_tariff_id: 11, original_selection_id: null },
            ],
          };
        }
        if (sql.includes('FROM "TariffEffectivePeriod" p') && sql.includes('LEFT JOIN "TariffSelection" sel')) {
          return { rows: restoredSpans };
        }
        if (sql.includes('FROM "TariffEffectivePeriod"') && sql.includes('ORDER BY effective_from ASC')) {
          return { rows: restoredSpans };
        }
        if (sql.includes('FROM "Tariff"') && sql.includes('id = ANY')) {
          return {
            rows: [
              { id: 10, site_id: 'site-1', version: 1, name: 'Tesla v1', is_current: false, updated: new Date('2025-01-01T00:00:00Z'), content_hash: teslaV1.contentHash, source: 'tesla' },
              { id: 11, site_id: 'site-1', version: 2, name: 'Tesla v2', is_current: false, updated: new Date('2025-07-01T00:00:00Z'), content_hash: teslaV2.contentHash, source: 'tesla' },
            ],
          };
        }
        if (sql.includes('FROM "TariffSeason"')) {
          return {
            rows: [
              { id: 110, tariff_id: 10, name: 'All Year', from_month: 1, from_day: 1, to_month: 12, to_day: 31, buy_rate: 0.15, sell_rate: 0.05 },
              { id: 111, tariff_id: 11, name: 'All Year', from_month: 1, from_day: 1, to_month: 12, to_day: 31, buy_rate: 0.12, sell_rate: 0.04 },
            ],
          };
        }
        if (sql.includes('FROM "TariffSchedule"')) {
          return {
            rows: [
              { id: 210, season_id: 110, name: 'OFF_PEAK', buy_rate: 0.15, sell_rate: 0.05, from_day_of_week: 0, to_day_of_week: 6, from_hour: 0, from_minute: 0, to_hour: 24, to_minute: 0 },
              { id: 211, season_id: 111, name: 'OFF_PEAK', buy_rate: 0.12, sell_rate: 0.04, from_day_of_week: 0, to_day_of_week: 6, from_hour: 0, from_minute: 0, to_hour: 24, to_minute: 0 },
            ],
          };
        }
        if (sql.includes('FROM "TariffSelection"') && sql.includes('WHERE site_id = $1 AND scope = $2') && sql.includes('id = ANY')) {
          return { rows: selectionRowsForRestore };
        }
        if (sql.includes('MAX(id)') && sql.includes('FROM "TariffSelection"')) {
          return { rows: [{ max_id: 512 }] };
        }
        if (sql.includes('FROM "TariffEffectivePeriod"') && sql.includes('created_at >')) {
          const threshold = new Date(String(params?.[1] ?? ''));
          return { rows: restoreCommitAt > threshold ? [{ id: 702 }] : [] };
        }
        if (sql.includes('FROM "TariffSelectionVerification"')) {
          return { rows: [] };
        }
        return { rows: [] };
      };

      const retryRestoreMulti = await commitTariffSelection(
        'site-1',
        'user-1',
        {
          scope: 'actual',
          candidate: { kind: 'restore_tesla', originalSelectionId: 300 },
          effectiveFrom: '2025-01-01',
          effectiveTo: '2025-12-31',
          expectedReviewHash: restorePreview.reviewHash,
          verifiedAgainstBill: false,
        },
        { now: fixedNow, repo }
      );

      expect(retryRestoreMulti.unchanged).toBe(true);
      expect(retryRestoreMulti.selectionIds).toEqual([511, 512]);

      // If multi-interval spans originated from separate commits (different created_at/timeline_revision), reject with 409 regardless of row order.
      selectionRowsForRestore = [
        { ...selectionRowsForRestore[0], created_at: new Date('2026-11-17T18:01:05.000Z') },
        { ...selectionRowsForRestore[1], created_at: new Date('2026-11-17T18:01:00.000Z'), timeline_revision: 1 },
      ];
      await expect(
        commitTariffSelection(
          'site-1',
          'user-1',
          {
            scope: 'actual',
            candidate: { kind: 'restore_tesla', originalSelectionId: 300 },
            effectiveFrom: '2025-01-01',
            effectiveTo: '2025-12-31',
            expectedReviewHash: restorePreview.reviewHash,
            verifiedAgainstBill: false,
          },
          { now: fixedNow, repo }
        )
      ).rejects.toThrow(TariffSelectionConflictError);
    });

    it('restores multi-interval saved Tesla versions without substituting a newer Tesla version', async () => {
      const teslaV1 = makeTeslaSnapshot(10, 'Tesla v1', 1, teslaSeasons);
      const teslaV2 = makeTeslaSnapshot(11, 'Tesla v2', 2, sampleSeasons);
      const overridePlan: TariffReviewPlanSnapshot = {
        ...makeTeslaSnapshot(20, 'Public Override', 1, sampleSeasons),
        source: 'estimated',
        choiceKind: 'owner',
        urdbLabel: 'urdb-1',
      };

      const repo = new TariffTimelineRepo();
      vi.spyOn(repo, 'getSiteUtilityContext').mockResolvedValue({
        name: 'Wisconsin Electric Power Co',
        timezone: 'America/Chicago',
        currency: 'USD',
        choice: 'owner',
      });
      vi.spyOn(repo, 'loadSelectionTimelineSnapshot').mockResolvedValue({
        fallbackSellRate: 0.05,
        hasTeslaSellFallback: true,
        existingSpans: [{ effectiveFrom: '2025-01-01', effectiveTo: '2025-12-31', plan: overridePlan }],
        restorationTargets: [
          {
            effectiveFrom: '2025-01-01',
            effectiveTo: '2025-06-30',
            original: {
              originalSelectionId: 300,
              tariffId: 10,
              name: 'Tesla v1',
              version: 1,
              contentHash: teslaV1.contentHash,
              effectiveFrom: '2025-01-01',
              effectiveTo: '2025-06-30',
            },
            plan: teslaV1,
          },
          {
            effectiveFrom: '2025-07-01',
            effectiveTo: '2025-12-31',
            original: {
              originalSelectionId: 300,
              tariffId: 11,
              name: 'Tesla v2',
              version: 2,
              contentHash: teslaV2.contentHash,
              effectiveFrom: '2025-07-01',
              effectiveTo: '2025-12-31',
            },
            plan: teslaV2,
          },
        ],
        manualNameTaken: false,
      });

      const preview = await previewTariffSelection(
        'site-1',
        'user-1',
        {
          scope: 'actual',
          candidate: { kind: 'restore_tesla', originalSelectionId: 300 },
          effectiveFrom: '2025-01-01',
          effectiveTo: '2025-12-31',
        },
        { now: fixedNow, repo }
      );

      expect(preview.restoration.canApplyRestoration).toBe(true);
      expect(preview.candidatePlan).toBeNull();
      expect(preview.affectedIntervals.map(i => [i.effectiveFrom, i.effectiveTo, i.after?.tariffId])).toEqual([
        ['2025-01-01', '2025-06-30', 10],
        ['2025-07-01', '2025-12-31', 11],
      ]);

      // Preview when no Tesla original exists returns canApplyRestoration: false without throwing
      vi.spyOn(repo, 'loadSelectionTimelineSnapshot').mockResolvedValueOnce({
        fallbackSellRate: 0.05,
        hasTeslaSellFallback: true,
        existingSpans: [{ effectiveFrom: '2025-01-01', effectiveTo: '2025-12-31', plan: overridePlan }],
        restorationTargets: [],
        manualNameTaken: false,
      });
      const noOrigPreview = await previewTariffSelection(
        'site-1',
        'user-1',
        {
          scope: 'actual',
          candidate: { kind: 'restore_tesla', originalSelectionId: 9999 },
          effectiveFrom: '2025-01-01',
          effectiveTo: '2025-12-31',
        },
        { now: fixedNow, repo }
      );
      expect(noOrigPreview.restoration.canApplyRestoration).toBe(false);
      expect(noOrigPreview.affectedIntervals[0].kind).toBe('restore_unavailable');
    });

    it('leaves actual reattribution untouched for reference-scope selections', async () => {
      const repo = new TariffTimelineRepo();
      vi.spyOn(repo, 'getSiteUtilityContext').mockResolvedValue({
        name: null,
        timezone: 'America/Chicago',
        currency: 'USD',
        choice: null,
      });
      vi.spyOn(repo, 'loadSelectionTimelineSnapshot').mockResolvedValue({
        fallbackSellRate: 0,
        hasTeslaSellFallback: false,
        existingSpans: [],
        restorationTargets: [],
        manualNameTaken: false,
      });

      const preview = await previewTariffSelection(
        'site-1',
        'user-1',
        {
          scope: 'reference',
          candidate: { kind: 'manual', name: 'Fixed Baseline', seasons: teslaSeasons },
          effectiveFrom: '2025-01-01',
          effectiveTo: null,
        },
        { now: fixedNow, repo }
      );

      expect(preview.recalculatesHistory).toBe(false);
      expect(preview.recalculationRange).toBeNull();

      clientQueryHandler = async (sql: string) => {
        if (sql.includes('FROM "Site" WHERE id = $1 FOR UPDATE')) {
          return { rows: [{ id: 'site-1', timezone: 'America/Chicago', currency: 'USD' }] };
        }
        if (sql.includes('COALESCE(MAX(version), 0) + 1')) return { rows: [{ next: 1 }] };
        if (sql.includes('INSERT INTO "Tariff"(')) return { rows: [{ id: 88 }] };
        if (sql.includes('INSERT INTO "TariffSeason"(')) return { rows: [{ id: 188 }] };
        if (sql.includes('INSERT INTO "TariffSelection"')) return { rows: [{ id: 701 }] };
        if (sql.includes('INSERT INTO "TariffReferencePeriod"')) return { rows: [{ id: 801 }] };
        return { rows: [] };
      };
      dbMocks.queryMock.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM "Site"') && sql.includes('WHERE id = $1')) {
          return { rows: [{ id: 'site-1', timezone: 'America/Chicago', installed: '2024-01-01T06:00:00Z', currency: 'USD' }] };
        }
        return { rows: [] };
      });

      const committed = await commitTariffSelection(
        'site-1',
        'user-1',
        {
          scope: 'reference',
          candidate: { kind: 'manual', name: 'Fixed Baseline', seasons: teslaSeasons },
          effectiveFrom: '2025-01-01',
          effectiveTo: null,
          expectedReviewHash: preview.reviewHash,
          verifiedAgainstBill: false,
        },
        { now: fixedNow, repo }
      );

      expect(committed.reattributionRange).toBeNull();
      expect(clientQueries.some(q => q.sql.includes('SiteTariffReattribution'))).toBe(false);
      expect(clientQueries.some(q => q.sql.includes('"TariffEffectivePeriod"'))).toBe(false);
    });
  });

  it('maps missing site to TariffNotFoundError, missing utility to UtilityChangedError, and URDB outage cleanly', async () => {
    const repo = new TariffTimelineRepo();
    vi.spyOn(repo, 'getSiteUtilityContext').mockRejectedValueOnce(new TariffNotFoundError('Site not found'));
    await expect(
      previewTariffSelection(
        'missing-site',
        'user-1',
        {
          scope: 'actual',
          candidate: { kind: 'manual', name: 'Plan', seasons: teslaSeasons },
          effectiveFrom: '2025-01-01',
          effectiveTo: null,
        },
        { now: fixedNow, repo }
      )
    ).rejects.toThrow(TariffNotFoundError);

    vi.spyOn(repo, 'getSiteUtilityContext').mockResolvedValueOnce({
      name: null,
      timezone: 'America/Chicago',
      currency: 'USD',
      choice: null,
    });
    await expect(
      listPublicUtilityPlansForSite('site-1', { now: fixedNow() }, { repo, urdb: { ratesEffectiveOn: vi.fn(), rateByLabel: vi.fn() } })
    ).rejects.toThrow(UtilityChangedError);

    vi.spyOn(repo, 'getSiteUtilityContext').mockResolvedValueOnce({
      name: 'We Energies',
      timezone: 'America/Chicago',
      currency: 'USD',
      choice: 'owner',
    });
    await expect(
      listPublicUtilityPlansForSite(
        'site-1',
        { now: fixedNow() },
        {
          repo,
          urdb: {
            ratesEffectiveOn: async () => {
              throw new UrdbUnavailableError('URDB down');
            },
            rateByLabel: vi.fn(),
          },
        }
      )
    ).rejects.toThrow(UrdbUnavailableError);
  });

  describe('additional edge cases: approximations, currency, utility mismatch, conversion conflicts, and name collisions', () => {
    it('explains base-tier fallback and $0 export fallback when no monthly usage or Tesla fallback exists', async () => {
      const repo = new TariffTimelineRepo();
      vi.spyOn(repo, 'getSiteUtilityContext').mockResolvedValue({
        name: 'We Energies',
        timezone: 'America/Chicago',
        currency: 'USD',
        choice: 'owner',
      });
      vi.spyOn(repo, 'loadSelectionTimelineSnapshot').mockResolvedValue({
        fallbackSellRate: 0,
        hasTeslaSellFallback: false,
        existingSpans: [],
        restorationTargets: [],
        manualNameTaken: false,
      });

      const rate = makeTieredNonNetMeteringRate({ dgrules: 'Buy All Sell All' });
      const preview = await previewTariffSelection(
        'site-1',
        'user-1',
        {
          scope: 'actual',
          candidate: { kind: 'public', label: rate.label },
          effectiveFrom: '2025-05-01',
          effectiveTo: '2025-05-31',
        },
        {
          now: fixedNow,
          repo,
          urdb: { rateByLabel: async () => rate, ratesEffectiveOn: async () => [rate] },
          monthlyUsage: async () => null,
        }
      );

      expect(preview.candidatePlan?.exportRateProvenance).toBe('inherited');
      expect(preview.candidatePlan?.seasons[0].weekdayPeriods[0]).toMatchObject({
        buyRate: 0.1,
        sellRate: 0,
      });
      expect(preview.approximationNotes).toEqual([
        {
          kind: 'tier_blended',
          message: 'Tiered grid rates use the base tier because recent monthly home use is unavailable.',
        },
        {
          kind: 'export_fallback_zero',
          message: 'Public utility rates did not publish export prices, so export rates default to $0.00/kWh.',
        },
      ]);
    });

    it('rejects public candidates whose rate currency, utility, start date, or rates are invalid or unsupported', async () => {
      const repo = new TariffTimelineRepo();
      vi.spyOn(repo, 'getSiteUtilityContext').mockResolvedValue({
        name: 'We Energies',
        timezone: 'America/Chicago',
        currency: 'USD',
        choice: 'owner',
      });

      const rateForeignCurrency = { ...makePublishedRate(), currency: 'CAD' } as UrdbRate;
      await expect(
        previewTariffSelection(
          'site-1',
          'user-1',
          { scope: 'actual', candidate: { kind: 'public', label: 'cad-rate' }, effectiveFrom: '2025-01-01', effectiveTo: null },
          { now: fixedNow, repo, urdb: { rateByLabel: async () => rateForeignCurrency, ratesEffectiveOn: async () => [] }, monthlyUsage: async () => null }
        )
      ).rejects.toThrow(/does not match your site currency/);

      const rateOtherUtility = makePublishedRate({ utility: 'Other Utility Co' });
      await expect(
        previewTariffSelection(
          'site-1',
          'user-1',
          { scope: 'actual', candidate: { kind: 'public', label: 'other-util' }, effectiveFrom: '2025-01-01', effectiveTo: null },
          { now: fixedNow, repo, urdb: { rateByLabel: async () => rateOtherUtility, ratesEffectiveOn: async () => [] }, monthlyUsage: async () => null }
        )
      ).rejects.toThrow(/not listed for your utility/);

      const rateMissingStart = makePublishedRate({ startdate: undefined });
      await expect(
        previewTariffSelection(
          'site-1',
          'user-1',
          { scope: 'actual', candidate: { kind: 'public', label: 'no-start' }, effectiveFrom: '2025-01-01', effectiveTo: null },
          { now: fixedNow, repo, urdb: { rateByLabel: async () => rateMissingStart, ratesEffectiveOn: async () => [rateMissingStart] }, monthlyUsage: async () => null }
        )
      ).rejects.toThrow(/missing an effective start date/);

      await expect(
        previewTariffSelection(
          'site-1',
          'user-1',
          { scope: 'actual', candidate: { kind: 'public', label: 'missing-label' }, effectiveFrom: '2025-01-01', effectiveTo: null },
          { now: fixedNow, repo, urdb: { rateByLabel: async () => null, ratesEffectiveOn: async () => [] }, monthlyUsage: async () => null }
        )
      ).rejects.toThrow(/could not be found/);

      const outOfRangeRate = makePublishedRate({ energyratestructure: [[{ rate: 25, sell: 0.05 }]] });
      await expect(
        previewTariffSelection(
          'site-1',
          'user-1',
          { scope: 'actual', candidate: { kind: 'public', label: 'out-of-range' }, effectiveFrom: '2025-01-01', effectiveTo: null },
          { now: fixedNow, repo, urdb: { rateByLabel: async () => outOfRangeRate, ratesEffectiveOn: async () => [outOfRangeRate] }, monthlyUsage: async () => null }
        )
      ).rejects.toThrow(TariffValidationError);
    });

    it('rejects duplicate manual plan name in actual scope during preview and accepts utility alias resolution', async () => {
      const repo = new TariffTimelineRepo();
      vi.spyOn(repo, 'getSiteUtilityContext').mockResolvedValue({
        name: 'We Energies',
        timezone: 'America/Chicago',
        currency: 'USD',
        choice: 'owner',
      });
      vi.spyOn(repo, 'loadSelectionTimelineSnapshot').mockResolvedValueOnce({
        fallbackSellRate: 0,
        hasTeslaSellFallback: false,
        existingSpans: [],
        restorationTargets: [],
        manualNameTaken: true,
      });

      await expect(
        previewTariffSelection(
          'site-1',
          'user-1',
          {
            scope: 'actual',
            candidate: { kind: 'manual', name: 'Existing Tesla Plan', seasons: teslaSeasons },
            effectiveFrom: '2025-01-01',
            effectiveTo: null,
          },
          { now: fixedNow, repo }
        )
      ).rejects.toThrow(/already exists/);

      // Utility alias: SiteUtility stores "We Energies" while URDB files rate under "Wisconsin Electric Power Co".
      const aliasedRate = makePublishedRate({ utility: 'Wisconsin Electric Power Co' });
      vi.spyOn(repo, 'loadSelectionTimelineSnapshot').mockResolvedValueOnce({
        fallbackSellRate: 0,
        hasTeslaSellFallback: false,
        existingSpans: [],
        restorationTargets: [],
        manualNameTaken: false,
      });
      const preview = await previewTariffSelection(
        'site-1',
        'user-1',
        {
          scope: 'actual',
          candidate: { kind: 'public', label: aliasedRate.label },
          effectiveFrom: '2025-06-01',
          effectiveTo: '2025-12-31',
        },
        {
          now: fixedNow,
          repo,
          urdb: { rateByLabel: async () => aliasedRate, ratesEffectiveOn: async () => [aliasedRate] },
          monthlyUsage: async () => null,
        }
      );
      expect(preview.candidatePlan?.urdbLabel).toBe(aliasedRate.label);
    });

    it('conflicts (409) when monthly usage conversion inputs change between preview and commit', async () => {
      const rate = makeTieredNonNetMeteringRate();
      const repo = new TariffTimelineRepo();
      vi.spyOn(repo, 'getSiteUtilityContext').mockResolvedValue({
        name: 'Wisconsin Electric Power Co',
        timezone: 'America/Chicago',
        currency: 'USD',
        choice: 'owner',
      });
      vi.spyOn(repo, 'loadSelectionTimelineSnapshot').mockResolvedValue({
        fallbackSellRate: 0.05,
        hasTeslaSellFallback: true,
        existingSpans: [],
        restorationTargets: [],
        manualNameTaken: false,
      });

      const preview = await previewTariffSelection(
        'site-1',
        'user-1',
        {
          scope: 'actual',
          candidate: { kind: 'public', label: rate.label },
          effectiveFrom: '2025-01-01',
          effectiveTo: null,
        },
        {
          now: fixedNow,
          repo,
          urdb: { rateByLabel: async () => rate, ratesEffectiveOn: async () => [rate] },
          monthlyUsage: async () => 500,
        }
      );

      clientQueryHandler = async (sql: string) => {
        if (sql.includes('FROM "Site" WHERE id = $1 FOR UPDATE')) {
          return { rows: [{ id: 'site-1', timezone: 'America/Chicago', currency: 'USD' }] };
        }
        if (sql.includes('FROM "SiteUtility"') && sql.includes('updated_at >')) {
          return { rows: [] };
        }
        if (sql.includes('FROM "SiteUtility"')) {
          return { rows: [{ urdb_utility: 'Wisconsin Electric Power Co', choice: 'owner' }] };
        }
        return { rows: [] };
      };
      dbMocks.queryMock.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM "Site" s') && sql.includes('WHERE s.id = $1')) {
          return { rows: [{ name: 'Wisconsin Electric Power Co', timezone: 'America/Chicago', currency: 'USD', choice: 'owner' }] };
        }
        return { rows: [] };
      });

      await expect(
        commitTariffSelection(
          'site-1',
          'user-1',
          {
            scope: 'actual',
            candidate: { kind: 'public', label: rate.label },
            effectiveFrom: '2025-01-01',
            effectiveTo: null,
            expectedReviewHash: preview.reviewHash,
            verifiedAgainstBill: false,
          },
          {
            now: fixedNow,
            repo,
            urdb: { rateByLabel: async () => rate, ratesEffectiveOn: async () => [rate] },
            monthlyUsage: async () => 950,
          }
        )
      ).rejects.toThrow(TariffSelectionConflictError);
    });
  });
});
