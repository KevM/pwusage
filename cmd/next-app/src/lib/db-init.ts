import { pool } from './db';

let dbInitPromise: Promise<void> | null = null;

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

    // Always ensure User table exists (Migration)
    await client.query(`
        CREATE TABLE IF NOT EXISTS "User" (
            id TEXT PRIMARY KEY,
            email TEXT,
            access_token TEXT,
            refresh_token TEXT,
            token_expires_at BIGINT,
            is_refreshing INTEGER DEFAULT 0,
            refresh_lock_expires BIGINT DEFAULT 0
        );
    `);

    // Ensure user_id column exists on Site (Migration)
    // Note: We need to do this carefully if Site table might not exist yet, 
    // but the block below creates Site if not exists.
    // So we should probably do this AFTER the Site block or inside a check.
    // However, if Site exists, we still need to add user_id.

    // Let's rely on standard "CREATE IF NOT EXISTS" logic for new installs
    // and specific migration logic for existing installs.

    if (!res.rows[0].exists) {
      console.log('[DB] Initializing database schema (First Run)...');
      await client.query('BEGIN');



      await client.query(`
        CREATE TABLE IF NOT EXISTS "Site" (
          id TEXT PRIMARY KEY,
          user_id TEXT REFERENCES "User"(id),
          name TEXT NOT NULL,
          updated TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          installed TIMESTAMP NOT NULL,
          timezone TEXT NOT NULL,
          json JSONB,
          billing_start_day INTEGER DEFAULT 1
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
          uuid TEXT UNIQUE,
          site_id TEXT NOT NULL,
          plugin_setting_id INTEGER,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          json JSONB,
          access_token TEXT,
          refresh_token TEXT
        );
      `);

      // Migration: Add user_id column if it doesn't exist (for existing DBs)
      await client.query(`
        DO $$
        BEGIN
            IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='Site' AND column_name='user_id') THEN
                ALTER TABLE "Site" ADD COLUMN user_id TEXT REFERENCES "User"(id);
            END IF;
        END
        $$;
      `);

      console.log('[DB] Database schema initialized.');
    } else {
      // Run migrations for existing DB
      await client.query('BEGIN');
      await client.query(`
            DO $$
            BEGIN
                IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='Site') THEN
                    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='Site' AND column_name='user_id') THEN
                        ALTER TABLE "Site" ADD COLUMN user_id TEXT REFERENCES "User"(id);
                    END IF;
                END IF;

                -- Ensure TrmnlInstallation has json and plugin_setting_id
                IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='TrmnlInstallation') THEN
                    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='TrmnlInstallation' AND column_name='json') THEN
                         ALTER TABLE "TrmnlInstallation" ADD COLUMN json JSONB;
                    END IF;
                    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='TrmnlInstallation' AND column_name='plugin_setting_id') THEN
                         ALTER TABLE "TrmnlInstallation" ADD COLUMN plugin_setting_id INTEGER;
                    END IF;
                    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='TrmnlInstallation' AND column_name='access_token') THEN
                         ALTER TABLE "TrmnlInstallation" ADD COLUMN access_token TEXT;
                    END IF;
                    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='TrmnlInstallation' AND column_name='refresh_token') THEN
                         ALTER TABLE "TrmnlInstallation" ADD COLUMN refresh_token TEXT;
                    END IF;

                    -- Drop unused columns if they exist
                    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='TrmnlInstallation' AND column_name='is_refreshing') THEN
                         ALTER TABLE "TrmnlInstallation" DROP COLUMN is_refreshing;
                    END IF;
                    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='TrmnlInstallation' AND column_name='refresh_lock_expires') THEN
                         ALTER TABLE "TrmnlInstallation" DROP COLUMN refresh_lock_expires;
                    END IF;
                END IF;
            END
            $$;
        `);
      await client.query('COMMIT');
    }
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[DB] Schema initialization failed:', e);
    throw e;
  } finally {
    client.release();
  }
}

export function getDbReady() {
  if (!dbInitPromise) {
    dbInitPromise = initDb().catch(e => {
      console.error('Failed to init DB lazily:', e);
      dbInitPromise = null;
      throw e;
    });
  }
  return dbInitPromise;
}
