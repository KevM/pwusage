import { pool } from './db';

// Decommissioned: DB Setup is now handled by Supabase Migrations in CI/CD.
// This function is kept for API compatibility.

export async function initDb() {
  // no-op
  console.log('[DB] initDb called: Skipping (Logic moved to migrations)');
}

export function getDbReady() {
  return Promise.resolve();
}

