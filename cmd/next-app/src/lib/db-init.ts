import { pool } from './db';

// Decommissioned: DB Setup is now handled by Supabase Migrations in CI/CD.
// This function is kept for API compatibility.

export async function initDb() {
  // no-op
  console.log('[DB] initDb called: Skipping (Logic moved to migrations)');
}


import { PoolClient } from 'pg';

async function secureTables(client: PoolClient) {
  const TABLES = [
    'User',
    'Site',
    'Tariff',
    'TariffSeason',
    'TariffSchedule',
    'EnergyData',
    'TrmnlInstallation',
    'LoadTag',
    'SystemAnnouncement'
  ];

  console.log('[DB] Securing tables (RLS)...');
  for (const table of TABLES) {
    // Enable RLS
    await client.query(`ALTER TABLE IF EXISTS public."${table}" ENABLE ROW LEVEL SECURITY;`);

    // Revoke all access from PUBLIC
    await client.query(`REVOKE ALL ON public."${table}" FROM PUBLIC;`);

    // Revoke all access from anon (Supabase specific role often used for unauth access)
    await client.query(`
            DO $$
            BEGIN
                IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
                    REVOKE ALL ON public."${table}" FROM anon;
                END IF;
                IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
                    REVOKE ALL ON public."${table}" FROM authenticated;
                END IF;
            END
            $$;
        `);
  }
}

export function getDbReady() {
  return Promise.resolve();
}

