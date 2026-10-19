import { Pool } from 'pg';
import { readFile, readdir } from 'node:fs/promises';

// Shared setup for the isolated PostgreSQL activity suites (scripts/test-battery-hold.sh).
export const activityTestSocket = process.env.BATTERY_HOLD_TEST_SOCKET;
export const safeActivityTestSocket = !!activityTestSocket
  && /^\/(?:private\/)?tmp\/battery-hold-pg-[a-zA-Z0-9]+$/.test(activityTestSocket);
if (activityTestSocket && !safeActivityTestSocket) throw new Error('Battery hold tests require a disposable private local socket');

const HOLD_MIGRATIONS = [
  '20260525000000_add_battery_hold.sql', '20260525010000_battery_hold_enhancements.sql',
  '20260525020000_add_cancelled_observed_reserve.sql', '20260701114315_enable_battery_hold_rls.sql',
  '20261002135116_battery_hold_monitoring.sql', '20261014133344_battery_hold_monitor_claim.sql',
];
// Schema migrations for BatteryHoldActivity, oldest first; the pg_cron schedule needs Supabase and is excluded.
const ACTIVITY_SCHEMA_MIGRATION = /_battery_hold_activit(?:ies|y_ended_token)\.sql$/;

/** Creates each role if it is missing; the cluster-wide CREATE ROLE races between parallel suites. */
export async function ensureRoles(pool: Pool, roles: string[]): Promise<void> {
  for (const role of roles) {
    await pool.query(`DO $$ BEGIN CREATE ROLE ${role}; EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL; END $$;`);
  }
}

/** Creates a fresh database with the hold and activity schema, applying each activity migration twice (idempotency). */
export async function createActivityTestDatabase(database: string): Promise<Pool> {
  const admin = new Pool({ host: activityTestSocket, port: 55440, user: process.env.USER, database: 'postgres', max: 1 });
  await admin.query(`DROP DATABASE IF EXISTS ${database}`);
  await admin.query(`CREATE DATABASE ${database}`);
  await admin.end();
  const pool = new Pool({ host: activityTestSocket, port: 55440, user: process.env.USER, database, max: 5 });
  await ensureRoles(pool, ['anon', 'authenticated', 'service_role']);
  await pool.query(`CREATE TABLE "User" (id text PRIMARY KEY, is_active boolean DEFAULT true, roles text[])`);
  await pool.query(`CREATE TABLE "Site" (id text PRIMARY KEY, user_id text REFERENCES "User"(id))`);
  for (const migration of HOLD_MIGRATIONS) await pool.query(await readFile(`db-migrations/${migration}`, 'utf8'));
  for (const migration of (await readdir('db-migrations')).filter(f => ACTIVITY_SCHEMA_MIGRATION.test(f)).sort()) {
    const sql = await readFile(`db-migrations/${migration}`, 'utf8');
    await pool.query(sql);
    await pool.query(sql);
  }
  return pool;
}
