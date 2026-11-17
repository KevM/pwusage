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
        if (sql.includes('SELECT id') && sql.includes('FROM "Site"')) {
          return { rows: [{ id: 's1', timezone: 'America/Chicago', rate_country: 'US' }], rowCount: 1 };
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
            rate_country: 'US',
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

  it('skips OpenEI calls for unknown and outside-US sites even with a US timezone or owner utility', async () => {
    for (const scenario of [
      { label: 'unknown country with US timezone', rateCountry: null, choice: 'owner' },
      { label: 'outside-US country with US timezone and owner utility', rateCountry: 'CA', choice: 'owner' },
    ]) {
      vi.clearAllMocks();
      const executed: Array<{ sql: string; params?: unknown[] }> = [];
      const client = {
        query: vi.fn(async (sql: string, params?: unknown[]) => {
          executed.push({ sql, params });
          if (sql.includes('SELECT id FROM "Site"') || sql.includes('FROM "Site" WHERE id = $1')) {
            return { rows: [{ id: 's1', timezone: 'America/Chicago', rate_country: scenario.rateCountry }], rowCount: 1 };
          }
          if (sql.includes('RETURNING updated_at::text AS claim')) {
            return { rows: [{ claim: '2026-11-17T00:00:00Z' }], rowCount: 1 };
          }
          if (sql.includes('SELECT updated_at::text AS claim, choice FROM "SiteUtility"')) {
            return { rows: [{ claim: '2026-11-17T00:00:00Z', choice: scenario.choice }], rowCount: 1 };
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
              rate_country: scenario.rateCountry,
              tariff_content: null,
              site_name: 'Home',
              history_start: '2025-01-01',
            }],
            rowCount: 1,
          };
        }
        if (sql.includes('FROM "SiteUtility"')) {
          return {
            rows: [{
              site_id: 's1',
              urdb_utility: 'Wisconsin Electric Power Co',
              choice: scenario.choice,
              status: 'needs_utility',
            }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      });

      const api: UrdbApi = {
        utilityNames: vi.fn(async () => { throw new Error(`unexpected utilityNames call for ${scenario.label}`); }),
        ratesEffectiveOn: vi.fn(async () => { throw new Error(`unexpected ratesEffectiveOn call for ${scenario.label}`); }),
        rateByLabel: vi.fn(async () => { throw new Error(`unexpected rateByLabel call for ${scenario.label}`); }),
        defaultRates: vi.fn(async () => { throw new Error(`unexpected defaultRates call for ${scenario.label}`); }),
      };

      const result = await runUrdbEstimatesForSite('s1', api, new Date('2026-11-17T12:00:00Z'));
      expect(result.status, scenario.label).toBe('ready');
      expect(api.utilityNames).not.toHaveBeenCalled();
      expect(api.ratesEffectiveOn).not.toHaveBeenCalled();
      expect(api.rateByLabel).not.toHaveBeenCalled();
      expect(api.defaultRates).not.toHaveBeenCalled();

      const utilityUpdate = executed.find(q => q.sql.includes('UPDATE "SiteUtility"') && q.sql.includes('attempt_count = 0'));
      expect(utilityUpdate, scenario.label).toBeDefined();
      expect(utilityUpdate?.sql).toContain('next_check_at = NULL');
    }
  });

  it('clears unprotected automatic public estimates and enqueues reattribution when site becomes outside-US', async () => {
    const executed: Array<{ sql: string; params?: unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        executed.push({ sql, params });
        if (sql.includes('FROM "Site" WHERE id = $1')) {
          return { rows: [{ id: 's1', timezone: 'America/Chicago', rate_country: 'GB' }], rowCount: 1 };
        }
        if (sql.includes('RETURNING updated_at::text AS claim')) {
          return { rows: [{ claim: '2026-11-17T00:00:00Z' }], rowCount: 1 };
        }
        if (sql.includes('SELECT updated_at::text AS claim, choice FROM "SiteUtility"')) {
          return { rows: [{ claim: '2026-11-17T00:00:00Z', choice: 'auto' }], rowCount: 1 };
        }
        if (sql.includes('FROM "TariffEffectivePeriod"') && sql.includes('ORDER BY effective_from ASC')) {
          return {
            rows: [{
              id: 99,
              tariff_id: 500,
              source: 'estimated',
              effective_from: '2025-01-01',
              effective_to: null,
              updated_by_user_id: null,
              selection_id: null,
              choice_kind: null,
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
            utility: null,
            timezone: 'America/Chicago',
            rate_country: 'GB',
            tariff_content: null,
            site_name: 'London House',
            history_start: '2025-01-01',
          }],
          rowCount: 1,
        };
      }
      if (sql.includes('FROM "SiteUtility"')) {
        return { rows: [{ site_id: 's1', urdb_utility: 'Some US Utility', choice: 'auto', status: 'ready' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const api: UrdbApi = {
      utilityNames: vi.fn(async () => { throw new Error('unexpected utilityNames call'); }),
      ratesEffectiveOn: vi.fn(async () => { throw new Error('unexpected ratesEffectiveOn call'); }),
      rateByLabel: vi.fn(async () => { throw new Error('unexpected rateByLabel call'); }),
      defaultRates: vi.fn(async () => { throw new Error('unexpected defaultRates call'); }),
    };

    const result = await runUrdbEstimatesForSite('s1', api, new Date('2026-11-17T12:00:00Z'));
    expect(result.status).toBe('ready');
    expect(result.changedDays).toBeGreaterThan(0);
    expect(
      executed.some(
        q =>
          q.sql.includes('DELETE FROM "TariffEffectivePeriod"') &&
          Array.isArray(q.params?.[1]) &&
          q.params[1].includes(99)
      )
    ).toBe(true);
    expect(executed.some(q => q.sql.includes('INSERT INTO "SiteTariffReattribution"'))).toBe(true);
    const utilityUpdate = executed.find(q => q.sql.includes('UPDATE "SiteUtility"') && q.sql.includes('attempt_count = 0'));
    expect(utilityUpdate?.sql).toContain('next_check_at = NULL');
    expect(utilityUpdate?.params?.[1]).toBeNull();
  });

  it('filters cron due queries to US-eligible sites or dirty legacy cleanup without recurring unknown/outside-US lookups', async () => {
    dbMocks.queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const api: UrdbApi = {
      utilityNames: vi.fn(async () => []),
      ratesEffectiveOn: vi.fn(async () => []),
      rateByLabel: vi.fn(async () => null),
      defaultRates: vi.fn(async () => []),
    };

    const result = await runUrdbEstimatesCron({ maxTimeMs: 5000, maxSites: 10, api });
    expect(result).toEqual({ checked: 0, sites: [] });
    expect(dbMocks.queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = dbMocks.queryMock.mock.calls[0] as [string, [number, string[]]];
    expect(sql).toContain('s.rate_country = ANY($2::text[])');
    expect(sql).toContain("u.status = 'ready' AND u.next_check_at IS NOT NULL AND u.next_check_at <= now()");
    expect(params[0]).toBe(10);
    expect(params[1]).toEqual(expect.arrayContaining(['US', 'PR', 'VI', 'GU', 'AS', 'MP', 'UM']));
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
