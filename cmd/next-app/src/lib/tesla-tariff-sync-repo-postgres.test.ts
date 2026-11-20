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

  it('finishAttempt reports whether it wrote, and does not rewrite a settled attempt', async () => {
    const begun = await inTransaction(database, client => repo.beginAttempt(client, attempt()));
    const id = (begun as { id: number }).id;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(await repo.finishAttempt(id, 'confirmed', { ok: true })).toBe(true);
    expect(await repo.finishAttempt(id, 'failed', { late: true })).toBe(false);

    expect(await repo.latestForSite('s1')).toMatchObject({ id, status: 'confirmed', teslaResponse: { ok: true } });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
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

  it('listUnconfirmed returns only this site\'s unconfirmed attempts, oldest first, with what was sent', async () => {
    await database.query(`INSERT INTO "Site" (id, user_id, timezone) VALUES ('s3', 'u1', 'America/Chicago'), ('s4', 'u1', 'America/Chicago')`);
    await database.query(
      `INSERT INTO "TeslaTariffSyncAttempt" (site_id, user_id, fingerprint, sent_content, status, created_at)
       VALUES ('s3', 'u1', 'fp-late', '{"name":"B"}', 'unconfirmed', now() - interval '1 minute'),
              ('s3', 'u1', 'fp-early', '{"name":"A"}', 'unconfirmed', now() - interval '3 minutes'),
              ('s3', 'u1', 'fp-done', '{"name":"C"}', 'confirmed', now() - interval '2 minutes'),
              ('s4', 'u1', 'fp-other', '{"name":"D"}', 'unconfirmed', now() - interval '2 minutes')`,
    );

    const listed = await repo.listUnconfirmed('s3');

    expect(listed.map(attempt => attempt.sentContent)).toEqual([{ name: 'A' }, { name: 'B' }]);
    expect(listed.every(attempt => attempt.siteId === 's3' && attempt.status === 'unconfirmed')).toBe(true);
  });

  it('confirmUnconfirmed confirms one unconfirmed attempt by id and leaves every other row alone', async () => {
    await database.query(`INSERT INTO "Site" (id, user_id, timezone) VALUES ('s5', 'u1', 'America/Chicago') ON CONFLICT (id) DO NOTHING`);
    const inserted = await database.query<{ id: string; fingerprint: string }>(
      `INSERT INTO "TeslaTariffSyncAttempt" (site_id, user_id, fingerprint, sent_content, status, created_at)
       VALUES ('s5', 'u1', 'fp-match', '{}', 'unconfirmed', now() - interval '2 minutes'),
              ('s5', 'u1', 'fp-other', '{}', 'unconfirmed', now() - interval '1 minute'),
              ('s5', 'u1', 'fp-sending', '{}', 'sending', now())
       RETURNING id, fingerprint`,
    );
    const idFor = (fingerprint: string): number => Number(inserted.rows.find(r => r.fingerprint === fingerprint)?.id);
    const sendingId = idFor('fp-sending');

    expect(await repo.confirmUnconfirmed(idFor('fp-match'))).toBe(true);
    expect(await repo.confirmUnconfirmed(sendingId)).toBe(false);
    expect(await repo.confirmUnconfirmed(999999)).toBe(false);

    const remaining = await repo.listUnconfirmed('s5');
    expect(remaining.map(attempt => attempt.fingerprint)).toEqual(['fp-other']);
    const statuses = await database.query<{ status: string }>(`SELECT status FROM "TeslaTariffSyncAttempt" WHERE site_id = 's5' ORDER BY id`);
    expect(statuses.rows.map(r => r.status)).toEqual(['confirmed', 'unconfirmed', 'sending']);
  });
});
