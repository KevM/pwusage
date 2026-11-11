import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import {
  activityTestSocket,
  ensureRoles,
  safeActivityTestSocket,
} from './battery-hold-activity-test-db';

describe.skipIf(!safeActivityTestSocket)('historic_effective_tariffs migration (postgres)', () => {
  let pool: Pool | null = null;

  afterAll(async () => {
    if (pool) await pool.end();
  });

  it('backfills active tesla tariff spans, rejects overlapping intervals, and clears author refs on user delete', async () => {
    const admin = new Pool({
      host: activityTestSocket,
      port: 55440,
      user: process.env.USER,
      database: 'postgres',
      max: 1,
    });
    const dbName = 'tariff_effective_migration_test';
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();

    pool = new Pool({
      host: activityTestSocket,
      port: 55440,
      user: process.env.USER,
      database: dbName,
      max: 3,
    });
    await ensureRoles(pool, ['anon', 'authenticated', 'service_role']);

    await pool.query(`
      CREATE TABLE "User" (id TEXT PRIMARY KEY, email TEXT);
      CREATE TABLE "Site" (id TEXT PRIMARY KEY, user_id TEXT REFERENCES "User"(id) ON DELETE SET NULL, timezone TEXT NOT NULL);
      CREATE TABLE "Tariff" (
        id SERIAL PRIMARY KEY,
        site_id TEXT NOT NULL REFERENCES "Site"(id) ON DELETE CASCADE,
        updated TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        name TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        is_current BOOLEAN NOT NULL DEFAULT true,
        content_hash TEXT
      );
      CREATE UNIQUE INDEX tariff_site_name_version_uidx ON "Tariff"(site_id, name, version);
      CREATE UNIQUE INDEX tariff_current_uidx ON "Tariff"(site_id, name) WHERE is_current;
      CREATE TABLE "EnergyDayArchive" (
        site_id TEXT NOT NULL REFERENCES "Site"(id) ON DELETE CASCADE,
        day_start TIMESTAMPTZ NOT NULL,
        revision UUID NOT NULL,
        PRIMARY KEY (site_id, day_start)
      );
    `);

    await pool.query(`INSERT INTO "User" (id, email) VALUES ('u1', 'a@example.com'), ('u2', 'b@example.com')`);
    await pool.query(`INSERT INTO "Site" (id, user_id, timezone) VALUES ('s1', 'u1', 'America/Chicago')`);
    const t1 = (await pool.query<{ id: number }>(
      `INSERT INTO "Tariff" (site_id, name, version, is_current, content_hash) VALUES ('s1', 'We energies', 1, true, 'h1') RETURNING id`
    )).rows[0].id;
    // Also insert a second current tariff under a different name to verify deduplication before tightening tariff_current_uidx.
    const t1b = (await pool.query<{ id: number }>(
      `INSERT INTO "Tariff" (site_id, name, version, is_current, content_hash) VALUES ('s1', 'We energies alt', 1, true, 'h1b') RETURNING id`
    )).rows[0].id;
    await pool.query(
      `INSERT INTO "EnergyDayArchive" (site_id, day_start, revision) VALUES ('s1', '2025-01-15T06:00:00Z', '00000000-0000-0000-0000-000000000001')`
    );

    const migFile = (await readdir('db-migrations')).find(f => f.endsWith('_historic_effective_tariffs.sql'));
    if (!migFile) throw new Error('Migration missing');
    const sql = await readFile(`db-migrations/${migFile}`, 'utf8');
    await pool.query(sql);
    await pool.query(sql); // idempotent re-run

    const periods = (await pool.query(
      `SELECT tariff_id, effective_from::text, effective_to::text, source, updated_by_user_id FROM "TariffEffectivePeriod" WHERE site_id = 's1'`
    )).rows;
    expect(periods).toEqual([
      { tariff_id: t1b, effective_from: '2025-01-15', effective_to: null, source: 'tesla', updated_by_user_id: null },
    ]);
    const t1Current = (await pool.query<{ is_current: boolean }>(`SELECT is_current FROM "Tariff" WHERE id = $1`, [t1])).rows[0].is_current;
    expect(t1Current).toBe(false);

    const t2 = (await pool.query<{ id: number }>(
      `INSERT INTO "Tariff" (site_id, name, version, is_current, content_hash, source, created_by_user_id)
       VALUES ('s1', 'Manual', 2, false, 'h2', 'manual', 'u2') RETURNING id`
    )).rows[0].id;

    // GIST constraint rejects overlapping range on the same site.
    await expect(
      pool.query(
        `INSERT INTO "TariffEffectivePeriod" (site_id, tariff_id, effective_from, effective_to, source, updated_by_user_id)
         VALUES ('s1', $1, '2025-06-01', '2025-12-31', 'manual', 'u2')`,
        [t2]
      )
    ).rejects.toThrow(/tariff_effective_period_no_overlap/);

    // Deleting creator/editor user preserves Tariff, period, and job row with NULL user refs.
    await pool.query(`DELETE FROM "TariffEffectivePeriod" WHERE site_id = 's1'`);
    await pool.query(
      `INSERT INTO "TariffEffectivePeriod" (site_id, tariff_id, effective_from, effective_to, source, updated_by_user_id)
       VALUES ('s1', $1, '2025-01-01', '2025-12-31', 'manual', 'u2')`,
      [t2]
    );
    await pool.query(
      `INSERT INTO "SiteTariffReattribution" (site_id, status, from_date, requested_by_user_id) VALUES ('s1', 'pending', '2025-01-01', 'u2')`
    );
    await pool.query(`DELETE FROM "User" WHERE id = 'u2'`);

    const tariffAfter = (await pool.query(`SELECT created_by_user_id FROM "Tariff" WHERE id = $1`, [t2])).rows[0];
    const periodAfter = (await pool.query(`SELECT updated_by_user_id FROM "TariffEffectivePeriod" WHERE site_id = 's1'`)).rows[0];
    const jobAfter = (await pool.query(`SELECT requested_by_user_id FROM "SiteTariffReattribution" WHERE site_id = 's1'`)).rows[0];
    expect(tariffAfter.created_by_user_id).toBeNull();
    expect(periodAfter.updated_by_user_id).toBeNull();
    expect(jobAfter.requested_by_user_id).toBeNull();

    // Tightened unique index allows at most one is_current row per site even across different names.
    await expect(
      pool.query(
        `INSERT INTO "Tariff" (site_id, name, version, is_current, content_hash, source)
         VALUES ('s1', 'Another Plan', 3, true, 'h3', 'manual')`
      )
    ).rejects.toThrow(/tariff_current_uidx/);

    // Deleting Site cascades cleanly through Tariff -> TariffEffectivePeriod without FK trigger-order failure.
    await expect(pool.query(`DELETE FROM "Site" WHERE id = 's1'`)).resolves.toBeDefined();
    expect((await pool.query(`SELECT 1 FROM "TariffEffectivePeriod" WHERE site_id = 's1'`)).rowCount).toBe(0);
    expect((await pool.query(`SELECT 1 FROM "SiteTariffReattribution" WHERE site_id = 's1'`)).rowCount).toBe(0);

    // Cron migration schedules every-minute gated trigger.
    await pool.query(`CREATE SCHEMA IF NOT EXISTS cron; CREATE TABLE IF NOT EXISTS cron.captured(name text PRIMARY KEY, schedule text, command text);
      CREATE OR REPLACE FUNCTION cron.schedule(text,text,text) RETURNS bigint LANGUAGE sql AS $$
        INSERT INTO cron.captured VALUES ($1,$2,$3) ON CONFLICT(name) DO UPDATE SET schedule=$2,command=$3 RETURNING 1::bigint $$;`);
    const cronMig = (await readdir('db-migrations')).find(f => f.endsWith('_reattribute_tariffs_cron.sql'));
    if (!cronMig) throw new Error('Cron migration missing');
    await pool.query(await readFile(`db-migrations/${cronMig}`, 'utf8'));
    const cronRow = (await pool.query('SELECT * FROM cron.captured WHERE name = $1', ['reattribute-tariffs-trigger'])).rows[0];
    expect(cronRow.schedule).toBe('* * * * *');
    expect(cronRow.command).toContain('/api/cron/reattribute-tariffs');
    expect(cronRow.command).toContain('SiteTariffReattribution');
  });
});
