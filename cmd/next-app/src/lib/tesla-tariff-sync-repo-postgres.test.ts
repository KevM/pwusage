import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { safeActivityTestSocket } from './battery-hold-activity-test-db';
import { createTariffTestDatabase } from './tariff-test-db';

const local = vi.hoisted(() => ({ database: undefined as unknown as Pool }));
vi.mock('./db', () => ({
  pool: {
    query: (...args: unknown[]) => Reflect.apply(local.database.query, local.database, args),
    connect: () => local.database.connect(),
  },
}));

import { TeslaTariffSyncRepo, type BeginAttemptInput } from './tesla-tariff-sync-repo';

const SENT = { name: 'PWUsage', currency: 'USD' };

function attempt(overrides: Partial<BeginAttemptInput> = {}): BeginAttemptInput {
  return {
    siteId: 's1',
    userId: 'u1',
    fingerprint: 'fp-1',
    selectionId: 7,
    replacedTeslaTariffId: 3,
    sentContent: SENT,
    ...overrides,
  };
}

/** Runs `fn` in a transaction on one client, the way the sync service holds the Site lock. */
async function inTransaction<T>(database: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

describe.skipIf(!safeActivityTestSocket)('Tesla tariff sync attempts (postgres)', () => {
  let database: Pool;
  let repo: TeslaTariffSyncRepo;

  beforeAll(async () => {
    database = await createTariffTestDatabase('tesla_tariff_sync_attempt_test');
    local.database = database;
    await database.query(`INSERT INTO "Site" (id, user_id, timezone) VALUES ('s2', 'u1', 'America/Chicago')`);
    repo = new TeslaTariffSyncRepo(database);
  });

  afterAll(async () => {
    await database.end();
  });

  beforeEach(async () => {
    await database.query('DELETE FROM "TeslaTariffSyncAttempt"');
  });

  it('begin inserts a sending attempt and returns its id', async () => {
    const result = await inTransaction(database, client => repo.beginAttempt(client, attempt()));

    expect(result).toEqual({ id: expect.any(Number) });
    const { rows } = await database.query(
      `SELECT status, finished_at, sent_content FROM "TeslaTariffSyncAttempt" WHERE id = $1`,
      [(result as { id: number }).id],
    );
    expect(rows[0]).toMatchObject({ status: 'sending', finished_at: null, sent_content: SENT });
  });

  it('begin returns inFlight while one is sending', async () => {
    const first = await inTransaction(database, client => repo.beginAttempt(client, attempt()));
    const second = await inTransaction(database, client => repo.beginAttempt(client, attempt({ fingerprint: 'fp-2' })));

    expect(second).toEqual({
      inFlight: expect.objectContaining({ id: (first as { id: number }).id, status: 'sending', fingerprint: 'fp-1' }),
    });
    const { rows } = await database.query('SELECT count(*)::int AS n FROM "TeslaTariffSyncAttempt"');
    expect(rows[0]).toEqual({ n: 1 });
  });

  it('a sending row younger than 2 minutes stays in flight', async () => {
    await database.query(
      `INSERT INTO "TeslaTariffSyncAttempt" (site_id, user_id, fingerprint, sent_content, status, created_at)
       VALUES ('s1', 'u1', 'fp-old', '{}', 'sending', now() - interval '90 seconds')`,
    );

    const result = await inTransaction(database, client => repo.beginAttempt(client, attempt()));

    expect(result).toEqual({ inFlight: expect.objectContaining({ fingerprint: 'fp-old', status: 'sending' }) });
  });

  it('stale sending row older than 2 minutes is failed and replaced', async () => {
    const { rows: stale } = await database.query<{ id: string }>(
      `INSERT INTO "TeslaTariffSyncAttempt" (site_id, user_id, fingerprint, sent_content, status, created_at)
       VALUES ('s1', 'u1', 'fp-stale', '{}', 'sending', now() - interval '3 minutes') RETURNING id`,
    );

    const result = await inTransaction(database, client => repo.beginAttempt(client, attempt()));

    expect(result).toEqual({ id: expect.any(Number) });
    expect(result).not.toEqual({ id: Number(stale[0].id) });
    const { rows } = await database.query(
      `SELECT status, finished_at FROM "TeslaTariffSyncAttempt" WHERE id = $1`,
      [stale[0].id],
    );
    expect(rows[0].status).toBe('failed');
    expect(rows[0].finished_at).not.toBeNull();
  });

  it('a second sending row for the same site is rejected by the unique index', async () => {
    await inTransaction(database, client => repo.beginAttempt(client, attempt()));

    await expect(database.query(
      `INSERT INTO "TeslaTariffSyncAttempt" (site_id, user_id, fingerprint, sent_content, status)
       VALUES ('s1', 'u1', 'fp-raw', '{}', 'sending')`,
    )).rejects.toMatchObject({ code: '23505' });
  });

  it('in-flight is per site, so another site can send', async () => {
    await inTransaction(database, client => repo.beginAttempt(client, attempt()));

    const other = await inTransaction(database, client => repo.beginAttempt(client, attempt({ siteId: 's2' })));

    expect(other).toEqual({ id: expect.any(Number) });
  });

  it('finishAttempt records the outcome, its response and finished_at, so the site can send again', async () => {
    const begun = await inTransaction(database, client => repo.beginAttempt(client, attempt()));
    const id = (begun as { id: number }).id;

    await repo.finishAttempt(id, 'rejected', { error: 'bad_tariff' });

    const latest = await repo.latestForSite('s1');
    expect(latest).toMatchObject({ id, status: 'rejected', teslaResponse: { error: 'bad_tariff' } });
    expect(latest?.finishedAt).not.toBeNull();
    const next = await inTransaction(database, client => repo.beginAttempt(client, attempt({ fingerprint: 'fp-2' })));
    expect(next).toEqual({ id: expect.any(Number) });
  });

  it('latestForSite returns the newest attempt, or null when there are none', async () => {
    expect(await repo.latestForSite('s1')).toBeNull();
    await database.query(
      `INSERT INTO "TeslaTariffSyncAttempt" (site_id, user_id, fingerprint, sent_content, status, created_at, finished_at)
       VALUES ('s1', 'u1', 'fp-older', '{}', 'confirmed', now() - interval '1 hour', now() - interval '1 hour'),
              ('s1', 'u1', 'fp-newer', '{}', 'failed', now() - interval '5 minutes', now() - interval '5 minutes')`,
    );

    const latest = await repo.latestForSite('s1');

    expect(latest).toMatchObject({
      siteId: 's1',
      userId: 'u1',
      fingerprint: 'fp-newer',
      selectionId: null,
      replacedTeslaTariffId: null,
      sentContent: {},
      status: 'failed',
      teslaResponse: null,
    });
    expect(typeof latest?.id).toBe('number');
    expect(latest?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(latest?.finishedAt).toMatch(/Z$/);
  });

  it('settleUnconfirmed marks unconfirmed attempts confirmed when the read-back matches', async () => {
    await database.query(
      `INSERT INTO "TeslaTariffSyncAttempt" (site_id, user_id, fingerprint, sent_content, status, created_at)
       VALUES ('s1', 'u1', 'fp-u', '{}', 'unconfirmed', now() - interval '1 minute')`,
    );

    await repo.settleUnconfirmed('s1', true);

    const latest = await repo.latestForSite('s1');
    expect(latest).toMatchObject({ status: 'confirmed' });
    expect(latest?.finishedAt).not.toBeNull();
  });

  it('settleUnconfirmed leaves unconfirmed attempts unchanged when the read-back does not match', async () => {
    await database.query(
      `INSERT INTO "TeslaTariffSyncAttempt" (site_id, user_id, fingerprint, sent_content, status, created_at)
       VALUES ('s1', 'u1', 'fp-u', '{}', 'unconfirmed', now() - interval '1 minute')`,
    );

    await repo.settleUnconfirmed('s1', false);

    expect(await repo.latestForSite('s1')).toMatchObject({ status: 'unconfirmed', finishedAt: null });
  });
});
