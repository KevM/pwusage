import { expect, it } from 'vitest';
import { applyEstimatesOnClient } from './tariff-timeline-repo';
import type { PoolClient } from 'pg';
it('keeps the timeline unchanged when there are no estimates', async () => {
  const calls: string[] = [];
  const client = { query: async (sql: string) => { calls.push(sql); return { rows: [], rowCount: 0 }; } } as unknown as PoolClient;
  const result = await applyEstimatesOnClient(client, 'site', '2026-01-01');
  expect(result.changed).toEqual([]);
  expect(calls.some(sql => sql.includes('TariffUrdbSource'))).toBe(true);
});

it('queries only active automatic estimates from TariffUrdbSource and preserves owner-selected estimated spans on actual and reference scopes', async () => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      if (sql.includes('FROM "TariffUrdbSource"')) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('FROM "TariffReferencePeriod"')) {
        return {
          rows: [{
            id: 41,
            tariff_id: 201,
            source: 'estimated',
            effective_from: '2025-01-01',
            effective_to: null,
            updated_by_user_id: 'u1',
            selection_id: 91,
            choice_kind: 'owner',
          }],
          rowCount: 1,
        };
      }
      if (sql.includes('FROM "TariffEffectivePeriod"') && sql.includes('ORDER BY effective_from ASC')) {
        return {
          rows: [{
            id: 42,
            tariff_id: 202,
            source: 'estimated',
            effective_from: '2025-01-01',
            effective_to: null,
            updated_by_user_id: 'u1',
            selection_id: 92,
            choice_kind: 'owner',
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as PoolClient;

  const result = await applyEstimatesOnClient(client, 'site', '2026-11-17');
  expect(result.changed).toEqual([]);
  expect(calls.some(c => c.sql.includes('FROM "TariffUrdbSource"') && c.sql.includes('is_current_estimate'))).toBe(true);
  expect(calls.some(c => c.sql.includes('DELETE FROM "TariffReferencePeriod"'))).toBe(false);
  expect(calls.some(c => c.sql.includes('DELETE FROM "TariffEffectivePeriod"'))).toBe(false);
});
