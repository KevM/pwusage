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
