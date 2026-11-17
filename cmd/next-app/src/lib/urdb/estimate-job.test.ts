import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbMocks = vi.hoisted(() => ({
  queryMock: vi.fn(),
  connectMock: vi.fn(),
  invalidateCacheMock: vi.fn(),
}));

vi.mock('../db', () => ({
  pool: {
    query: dbMocks.queryMock,
    connect: dbMocks.connectMock,
  },
}));

vi.mock('../site-repo', () => ({
  SiteRepo: class {
    invalidateCache = dbMocks.invalidateCacheMock;
  },
}));

import { ownerPlanMatchesUtility, runUrdbEstimatesCron, runUrdbEstimatesForSite, type UrdbApi } from './estimate-job';
import type { UrdbRate } from './types';
import effective from './__fixtures__/we-energies-effective-2026-04-28.json';
import chain from './__fixtures__/we-energies-option-a-chain.json';

describe('estimate-job', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('disables the cron without an OpenEI API key', async () => {
    vi.stubEnv('OPENEI_API_KEY', '');
    await expect(runUrdbEstimatesCron({ maxTimeMs: 1000, maxSites: 5 })).resolves.toMatchObject({ checked: 0, stopped: 'disabled' });
    vi.unstubAllEnvs();
  });

  it('protects owner public source records from blanket deletion during estimate refresh', async () => {
    const executedSql: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        executedSql.push(sql);
        if (sql.includes('SELECT id FROM "Site"')) {
          return { rows: [{ id: 's1' }], rowCount: 1 };
        }
        if (sql.includes('RETURNING updated_at::text AS claim')) {
          return { rows: [{ claim: '2026-11-17T00:00:00Z' }], rowCount: 1 };
        }
        if (sql.includes('SELECT updated_at::text AS claim, choice FROM "SiteUtility"')) {
          return { rows: [{ claim: '2026-11-17T00:00:00Z', choice: 'auto' }], rowCount: 1 };
        }
        if (sql.includes('SELECT timezone FROM "Site"')) {
          return { rows: [{ timezone: 'America/Chicago' }], rowCount: 1 };
        }
        if (sql.includes('FROM "TariffEffectivePeriod"') && sql.includes('ORDER BY effective_from ASC')) {
          return {
            rows: [{
              id: 1,
              tariff_id: 50,
              source: 'estimated',
              effective_from: '2025-01-01',
              effective_to: null,
              updated_by_user_id: 'u1',
              selection_id: 77,
              choice_kind: 'owner',
            }],
            rowCount: 1,
          };
        }
        if (sql.includes('INSERT INTO "SiteTariffReattribution"')) {
          return {
            rows: [{
              site_id: 's1', status: 'pending', generation: 1, from_date: '2025-01-01', to_date: null,
              cursor_day_start: null, total_days: 0, processed_days: 0, updated_days: 0, attempt_count: 0,
              last_error: null, requested_by_user_id: null, updated_at: new Date(),
            }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    dbMocks.connectMock.mockResolvedValue(client);
    dbMocks.queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM "Site" s WHERE s.id = $1')) {
        return {
          rows: [{
            id: 's1',
            utility: 'We Energies',
            timezone: 'America/Chicago',
            tariff_content: null,
            site_name: 'Home',
            history_start: '2025-01-01',
          }],
          rowCount: 1,
        };
      }
      if (sql.includes('FROM "SiteUtility"')) {
        return { rows: [{ site_id: 's1', urdb_utility: 'Wisconsin Electric Power Co', choice: 'skipped', status: 'pending' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const api: UrdbApi = {
      utilityNames: async () => ['Wisconsin Electric Power Co'],
      ratesEffectiveOn: async () => [],
      rateByLabel: async () => null,
      defaultRates: async () => [],
    };

    await runUrdbEstimatesForSite('s1', api, new Date('2026-11-17T12:00:00Z'));

    const deleteSourceSql = executedSql.find(sql => sql.includes('DELETE FROM "TariffUrdbSource"'));
    expect(deleteSourceSql).toBeDefined();
    expect(deleteSourceSql).toContain('TariffSelection');
    expect(deleteSourceSql).toContain("choice_kind = 'owner'");
    expect(executedSql.some(sql => sql.includes('UPDATE "TariffUrdbSource"') && sql.includes('is_current_estimate = FALSE'))).toBe(true);
    expect(executedSql.some(sql => sql.includes('DELETE FROM "TariffEffectivePeriod"'))).toBe(false);
  });
});

describe('ownerPlanMatchesUtility', () => {
  const picked = chain[0] as unknown as UrdbRate;
  const inEffect = effective as unknown as UrdbRate[];

  it('accepts a plan URDB files under the canonical name of the stored alias', () => {
    // URDB lists "We energies" as a utility but files its rates under "Wisconsin Electric Power Co".
    expect(picked.utility).toBe('Wisconsin Electric Power Co');
    expect(ownerPlanMatchesUtility(picked, 'We energies', inEffect)).toBe(true);
  });

  it('accepts a plan whose utility matches the stored name loosely', () => {
    expect(ownerPlanMatchesUtility(picked, 'Wisconsin Electric Power Company', [])).toBe(true);
  });

  it('rejects a plan from another utility or a missing plan', () => {
    expect(ownerPlanMatchesUtility({ ...picked, utility: 'Pacific Gas & Electric Co' }, 'We energies', inEffect)).toBe(false);
    expect(ownerPlanMatchesUtility(picked, 'We energies', [])).toBe(false);
    expect(ownerPlanMatchesUtility(null, 'We energies', inEffect)).toBe(false);
  });
});
