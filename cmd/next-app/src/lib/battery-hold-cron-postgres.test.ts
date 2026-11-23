import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { createActivityTestDatabase, safeActivityTestSocket as safeSocket } from './battery-hold-activity-test-db';

// Applies the Battery Saver cron migration against stand-ins for pg_cron, Vault
// and pg_net, then runs the captured job command to prove when it calls the app.
describe.skipIf(!safeSocket)('Battery Saver cron migration (isolated PostgreSQL)', () => {
  let pool: Pool;
  let holdId: number;
  const job = async (name: string) =>
    (await pool.query('SELECT schedule, command FROM cron.job WHERE jobname = $1', [name])).rows[0] as { schedule: string; command: string } | undefined;
  /** Runs restore-reserve-trigger's command and returns how many HTTP calls it queued. */
  const runRestoreTrigger = async () => {
    await pool.query('TRUNCATE net.calls');
    await pool.query((await job('restore-reserve-trigger'))!.command);
    return (await pool.query('SELECT url FROM net.calls')).rows.map(row => row.url as string);
  };
  const activity = (state: string, expires: string, updated = 'now()') => pool.query(`INSERT INTO "BatteryHoldActivity"
      (hold_id, user_id, registration_id, push_token, apns_environment, delivery_state, expires_at, updated_at)
      VALUES ($1, 'u1', $2::uuid, $3, 'sandbox', $4, ${expires}, ${updated})`,
  [holdId, randomUUID(), state === 'disabled' ? null : 'a'.repeat(64), state]);

  beforeAll(async () => {
    pool = await createActivityTestDatabase('battery_saver_cron');
    await pool.query(`
      CREATE SCHEMA cron;
      CREATE TABLE cron.job (jobname text PRIMARY KEY, schedule text, command text);
      CREATE FUNCTION cron.schedule(text, text, text) RETURNS bigint LANGUAGE sql AS $$
        INSERT INTO cron.job VALUES ($1, $2, $3) ON CONFLICT (jobname) DO UPDATE SET schedule = $2, command = $3 RETURNING 1::bigint $$;
      CREATE FUNCTION cron.unschedule(text) RETURNS boolean LANGUAGE sql AS $$
        DELETE FROM cron.job WHERE jobname = $1 RETURNING true $$;
      CREATE SCHEMA vault;
      CREATE TABLE vault.decrypted_secrets (name text, decrypted_secret text);
      INSERT INTO vault.decrypted_secrets VALUES
        ('battery_restore_cron_target_url', 'https://example.test/api/cron/restore-reserve'), ('cron_secret', 'secret');
      CREATE SCHEMA net;
      CREATE TABLE net.calls (url text);
      CREATE FUNCTION net.http_get(url text, headers jsonb, timeout_milliseconds integer) RETURNS bigint LANGUAGE sql AS $$
        INSERT INTO net.calls VALUES (url) RETURNING 1::bigint $$;
      INSERT INTO cron.job VALUES ('battery-hold-activity-delivery-trigger', '2-59/5 * * * *', 'SELECT 1');
      INSERT INTO "User" (id) VALUES ('u1');
      INSERT INTO "Site" (id, user_id) VALUES ('s1', 'u1');`);
    const migration = (await readdir('db-migrations')).find(file => file.endsWith('_battery_saver_cron_merge_and_cron_prune.sql'));
    if (!migration) throw new Error('Battery Saver cron migration missing');
    const sql = await readFile(`db-migrations/${migration}`, 'utf8');
    await pool.query(sql);
    await pool.query(sql); // idempotent
  });
  afterAll(async () => { await pool?.end(); });
  beforeEach(async () => {
    await pool.query('TRUNCATE "BatteryHold" CASCADE');
    holdId = (await pool.query(`INSERT INTO "BatteryHold" (site_id, status, original_reserve, target_reserve, parked_soc, baseline_load_w, safety_expires_at)
      VALUES ('s1', 'restored', 20, 100, 80, 500, now()) RETURNING id`)).rows[0].id;
  });

  it('replaces the delivery job with one 5-minute Battery Saver job, and slows re-attribution', async () => {
    expect(await job('battery-hold-activity-delivery-trigger')).toBeUndefined();
    expect(await job('restore-reserve-trigger')).toMatchObject({ schedule: '*/5 * * * *' });
    expect((await job('restore-reserve-trigger'))!.command).toContain('timeout_milliseconds := 65000');
    const reattribute = await job('reattribute-tariffs-trigger');
    expect(reattribute?.schedule).toBe('*/5 * * * *');
    expect(reattribute?.command).toContain('SiteTariffReattribution');
  });

  it('prunes pg_cron run history older than 7 days every night', async () => {
    expect(await job('cron-run-history-prune')).toEqual({
      schedule: '41 3 * * *', command: `DELETE FROM cron.job_run_details WHERE start_time < now() - interval '7 days'`,
    });
  });

  it('calls nothing when no hold is active and no activity needs work', async () => {
    expect(await runRestoreTrigger()).toEqual([]);
    await activity('ended', `now() + interval '6 hours'`);
    await activity('disabled', `now() - interval '1 hour'`);
    expect(await runRestoreTrigger()).toEqual([]);
  });

  it('calls the route while a hold is active', async () => {
    await pool.query(`UPDATE "BatteryHold" SET status = 'active' WHERE id = $1`, [holdId]);
    expect(await runRestoreTrigger()).toEqual(['https://example.test/api/cron/restore-reserve']);
  });

  it.each([
    ['an unsent update', 'pending', `now() + interval '6 hours'`, 'now()'],
    ['a live registration whose hold ended unsynced', 'current', `now() + interval '6 hours'`, 'now()'],
    ['an ended activity past expiry', 'ended', `now() - interval '1 minute'`, 'now()'],
    ['a disabled row past retention', 'disabled', `now() + interval '6 hours'`, `now() - interval '25 hours'`],
  ])('calls the route for %s', async (_, state, expires, updated) => {
    await activity(state, expires, updated);
    expect(await runRestoreTrigger()).toEqual(['https://example.test/api/cron/restore-reserve']);
  });
});
