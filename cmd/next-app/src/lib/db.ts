import { Pool, types } from 'pg';

// Force int8 to be parsed as number (if fits) or string? 
// By default pg parses bigint as string. We can leave it or force it.
// Date parsing: pg returns Date objects for timestamptz/timestamp.

const globalForDb = global as unknown as { pool: Pool };

// Hack to strip sslmode=require from connection string if present, 
// relying on the object config below instead.
let connStr = process.env.DATABASE_URL || '';
if (connStr.includes('sslmode=require')) {
  connStr = connStr.replace('sslmode=require', '');
}

export const pool = globalForDb.pool || new Pool({
  connectionString: connStr,
  ssl: {
    rejectUnauthorized: false
  },
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

if (process.env.NODE_ENV !== 'production') globalForDb.pool = pool;

// Helper to check and init schema
export async function initDb() {
  const client = await pool.connect();
  try {
    console.log('[DB] Checking schema...');

    // Check if Site table exists
    const res = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'Site'
      );
    `);

    // Note: table_name in information_schema is case sensitive if created with quotes
    // We strictly use quotes for table names in creation to preserve casing if desired,
    // or we can just rely on lowercase. best practice in PG is lowercase but we have existing casing.
    // Let's use quoted identifiers to match the existing schema names "Site", "Tariff", etc.

    if (!res.rows[0].exists) {
      console.log('[DB] Initializing database schema...');
      await client.query('BEGIN');

      await client.query(`
        CREATE TABLE IF NOT EXISTS "Site" (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          updated TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          installed TIMESTAMP NOT NULL,
          timezone TEXT NOT NULL,
          json JSONB,
          billing_start_day INTEGER DEFAULT 1,
          access_token TEXT,
          refresh_token TEXT,
          is_refreshing INTEGER DEFAULT 0,
          refresh_lock_expires BIGINT DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS "Tariff" (
          id SERIAL PRIMARY KEY,
          site_id TEXT NOT NULL REFERENCES "Site"(id) ON DELETE CASCADE,
          updated TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          name TEXT,
          UNIQUE(site_id, name)
        );

        CREATE TABLE IF NOT EXISTS "TariffSeason" (
          id SERIAL PRIMARY KEY,
          tariff_id INTEGER NOT NULL REFERENCES "Tariff"(id) ON DELETE CASCADE,
          name TEXT,
          from_month INTEGER NOT NULL,
          from_day INTEGER NOT NULL,
          to_month INTEGER NOT NULL,
          to_day INTEGER NOT NULL,
          buy_rate DOUBLE PRECISION NOT NULL,
          sell_rate DOUBLE PRECISION NOT NULL,
          UNIQUE(tariff_id, name)
        );

        CREATE TABLE IF NOT EXISTS "TariffSchedule" (
          id SERIAL PRIMARY KEY,
          season_id INTEGER NOT NULL REFERENCES "TariffSeason"(id) ON DELETE CASCADE,
          name TEXT,
          buy_rate DOUBLE PRECISION,
          sell_rate DOUBLE PRECISION,
          from_day_of_week INTEGER,
          from_hour INTEGER,
          from_minute INTEGER,
          to_day_of_week INTEGER,
          to_hour INTEGER,
          to_minute INTEGER
        );

        CREATE TABLE IF NOT EXISTS "EnergyData" (
          id SERIAL PRIMARY KEY,
          timestamp TIMESTAMP NOT NULL,
          site_id TEXT NOT NULL REFERENCES "Site"(id) ON DELETE CASCADE,
          tariff_id INTEGER NOT NULL REFERENCES "Tariff"(id) ON DELETE CASCADE,
          load_power DOUBLE PRECISION NOT NULL,
          solar_power DOUBLE PRECISION NOT NULL,
          grid_power DOUBLE PRECISION NOT NULL,
          battery_power DOUBLE PRECISION NOT NULL,
          battery_soc DOUBLE PRECISION,
          is_synthetic INTEGER DEFAULT 0,
          UNIQUE(timestamp, site_id, tariff_id)
        );

        CREATE TABLE IF NOT EXISTS "EnergyUsage" (
          id SERIAL PRIMARY KEY,
          tariff_id INTEGER NOT NULL REFERENCES "Tariff"(id) ON DELETE CASCADE,
          start TIMESTAMP NOT NULL,
          load_usage DOUBLE PRECISION NOT NULL,
          solar_produced DOUBLE PRECISION NOT NULL,
          grid_usage DOUBLE PRECISION NOT NULL,
          battery_usage DOUBLE PRECISION NOT NULL,
          UNIQUE(tariff_id, start)
        );

        CREATE TABLE IF NOT EXISTS "AppSettings" (
          key TEXT PRIMARY KEY,
          value TEXT
        );

        CREATE TABLE IF NOT EXISTS "TrmnlInstallation" (
          id SERIAL PRIMARY KEY,
          access_token TEXT UNIQUE NOT NULL,
          uuid TEXT UNIQUE,
          site_id TEXT NOT NULL,
          plugin_setting_id INTEGER,
          refresh_token TEXT,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          json JSONB,
          is_refreshing INTEGER DEFAULT 0,
          refresh_lock_expires BIGINT DEFAULT 0
        );
      `);

      await client.query('COMMIT');
      console.log('[DB] Database schema initialized.');
    }
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[DB] Schema initialization failed:', e);
    throw e;
  } finally {
    client.release();
  }
}

// Start Init (this is async, so it runs in background on module load, 
// strictly speaking we should await it in app entry point, 
// but for now we follow the pattern of "fire and log")
initDb().catch(e => console.error('Failed to init DB on load:', e));


export interface Site {
  id: string;
  name: string;
  updated: Date;
  installed: Date;
  timezone: string;
  json: any | null; // pg jsonb returns object
  billing_start_day: number;
  access_token?: string | null;
  refresh_token?: string | null;
  is_refreshing?: number;
  refresh_lock_expires?: number; // bigint comes as string usually, need to check
}

export interface Tariff {
  id: number;
  site_id: string;
  updated: Date;
  name: string | null;
  seasons?: TariffSeason[];
}

export interface TariffSeason {
  id: number;
  tariff_id: number;
  name: string | null;
  from_month: number;
  from_day: number;
  to_month: number;
  to_day: number;
  buy_rate: number;
  sell_rate: number;
  schedules?: TariffSchedule[];
}

export interface TariffSchedule {
  id: number;
  season_id: number;
  name: string | null;
  buy_rate: number | null;
  sell_rate: number | null;
  from_day_of_week: number | null;
  from_hour: number | null;
  from_minute: number | null;
  to_day_of_week: number | null;
  to_hour: number | null;
  to_minute: number | null;
}

export interface EnergyData {
  id: number;
  timestamp: Date;
  site_id: string;
  tariff_id: number;
  load_power: number;
  solar_power: number;
  grid_power: number;
  battery_power: number;
  battery_soc: number | null;
  is_synthetic?: number;
}

export interface EnergyUsage {
  id: number;
  tariff_id: number;
  start: Date;
  load_usage: number;
  solar_produced: number;
  grid_usage: number;
  battery_usage: number;
}

export interface TrmnlInstallation {
  id: number;
  access_token: string;
  uuid: string | null;
  site_id: string;
  plugin_setting_id: number | null;
  refresh_token: string | null;
  created_at: Date;
}

export interface SiteWithTariffs extends Site {
  tariffs: Tariff[];
}
