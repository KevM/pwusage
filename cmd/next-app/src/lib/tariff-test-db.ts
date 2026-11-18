import { readdir, readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { activityTestSocket, ensureRoles } from './battery-hold-activity-test-db';

/**
 * A fresh throwaway Postgres database with the tariff schema and migrations, for the tariff
 * Postgres suites. Runs only against the local test socket; never a real database.
 */
export async function createTariffTestDatabase(dbName: string): Promise<Pool> {
  const admin = new Pool({
    host: activityTestSocket,
    port: 55440,
    user: process.env.USER,
    database: 'postgres',
    max: 1,
  });
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();

  const database = new Pool({
    host: activityTestSocket,
    port: 55440,
    user: process.env.USER,
    database: dbName,
    max: 3,
  });
  await ensureRoles(database, ['anon', 'authenticated', 'service_role']);

  await database.query(`
    CREATE TABLE "User" (id TEXT PRIMARY KEY, email TEXT);
    CREATE TABLE "Site" (id TEXT PRIMARY KEY, user_id TEXT REFERENCES "User"(id) ON DELETE SET NULL, timezone TEXT NOT NULL, json JSONB, installed TIMESTAMPTZ);
    CREATE TABLE "Tariff" (
      id SERIAL PRIMARY KEY, site_id TEXT NOT NULL REFERENCES "Site"(id) ON DELETE CASCADE,
      updated TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, name TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
      is_current BOOLEAN NOT NULL DEFAULT true, content_hash TEXT
    );
    CREATE UNIQUE INDEX tariff_site_name_version_uidx ON "Tariff"(site_id, name, version);
    CREATE UNIQUE INDEX tariff_current_uidx ON "Tariff"(site_id, name) WHERE is_current;
    CREATE TABLE "TariffSeason" (
      id SERIAL PRIMARY KEY, tariff_id INTEGER NOT NULL REFERENCES "Tariff"(id) ON DELETE CASCADE,
      name TEXT, from_month INTEGER NOT NULL, from_day INTEGER NOT NULL, to_month INTEGER NOT NULL, to_day INTEGER NOT NULL,
      buy_rate DOUBLE PRECISION NOT NULL, sell_rate DOUBLE PRECISION NOT NULL
    );
    CREATE TABLE "TariffSchedule" (
      id SERIAL PRIMARY KEY, season_id INTEGER NOT NULL REFERENCES "TariffSeason"(id) ON DELETE CASCADE,
      name TEXT, buy_rate DOUBLE PRECISION, sell_rate DOUBLE PRECISION,
      from_day_of_week INTEGER, from_hour INTEGER, from_minute INTEGER, to_day_of_week INTEGER, to_hour INTEGER, to_minute INTEGER
    );
    CREATE TABLE "EnergyDayArchive" (site_id TEXT NOT NULL, day_start TIMESTAMPTZ NOT NULL, revision UUID NOT NULL, status TEXT, PRIMARY KEY (site_id, day_start));
    INSERT INTO "User" VALUES ('u1', 'owner@example.com'), ('u2', 'member@example.com');
    INSERT INTO "Site" VALUES ('s1', 'u1', 'America/Chicago', '{"currency":"USD"}');
  `);

  const migFile = (await readdir('db-migrations')).find(f => f.endsWith('_historic_effective_tariffs.sql'));
  if (!migFile) throw new Error('Migration missing');
  await database.query(await readFile(`db-migrations/${migFile}`, 'utf8'));
  const referenceMigration = (await readdir('db-migrations')).find(f => f.endsWith('_tariff_reference_periods.sql'));
  if (!referenceMigration) throw new Error('Reference migration missing');
  await database.query(await readFile(`db-migrations/${referenceMigration}`, 'utf8'));
  const estimateMigration = (await readdir('db-migrations')).find(f => f.endsWith('_urdb_estimated_rate_plans.sql'));
  if (!estimateMigration) throw new Error('URDB estimate migration missing');
  await database.query(await readFile(`db-migrations/${estimateMigration}`, 'utf8'));
  const newerStartMigration = (await readdir('db-migrations')).find(f => f.endsWith('_urdb_newer_plan_start.sql'));
  if (!newerStartMigration) throw new Error('URDB newer plan start migration missing');
  await database.query(await readFile(`db-migrations/${newerStartMigration}`, 'utf8'));
  const revisionStartMigration = (await readdir('db-migrations')).find(f => f.endsWith('_urdb_revision_start.sql'));
  if (!revisionStartMigration) throw new Error('URDB revision start migration missing');
  await database.query(await readFile(`db-migrations/${revisionStartMigration}`, 'utf8'));
  const ownerHistoryMigration = (await readdir('db-migrations')).find(f => f.endsWith('_urdb_owner_history.sql'));
  if (!ownerHistoryMigration) throw new Error('URDB owner history migration missing');
  await database.query(await readFile(`db-migrations/${ownerHistoryMigration}`, 'utf8'));
  const systemCostsMigration = (await readdir('db-migrations')).find(f => f.endsWith('_site_system_costs.sql'));
  if (!systemCostsMigration) throw new Error('Site system costs migration missing');
  await database.query(await readFile(`db-migrations/${systemCostsMigration}`, 'utf8'));
  const selectionProvenanceMigration = (await readdir('db-migrations')).find(f => f.endsWith('_tariff_selection_provenance.sql'));
  if (!selectionProvenanceMigration) throw new Error('Tariff selection provenance migration missing');
  await database.query(await readFile(`db-migrations/${selectionProvenanceMigration}`, 'utf8'));
  const rateCountryMigration = (await readdir('db-migrations')).find(f => f.endsWith('_site_rate_country.sql'));
  if (!rateCountryMigration) throw new Error('Site rate country migration missing');
  await database.query(await readFile(`db-migrations/${rateCountryMigration}`, 'utf8'));

  return database;
}
