import './bootstrap-env';
import { pool } from '../src/lib/db';
import * as api from '../src/lib/urdb/client';
import { previewUrdbEstimatesForSite, runUrdbEstimatesForSite } from '../src/lib/urdb/estimate-job';

let poolInitialized = false;

async function main() {
  const args = process.argv.slice(2);
  const siteIndex = args.indexOf('--site');
  const siteId = siteIndex >= 0 ? args[siteIndex + 1] : undefined;
  const dryRun = args.includes('--dry-run');
  if (!siteId || siteId.startsWith('--') || args.filter((arg) => arg === '--site').length !== 1 ||
      args.some((arg, index) => arg !== '--site' && arg !== '--dry-run' && index !== siteIndex + 1)) {
    throw new Error('Usage: npx tsx scripts/run-urdb-estimates.ts --site <id> [--dry-run]');
  }

  if (!process.env.OPENEI_API_KEY?.trim()) throw new Error('Refusing: OPENEI_API_KEY is required');
  if (!process.env.DATABASE_URL?.trim()) throw new Error('Refusing: DATABASE_URL is required');
  // Accessing the lazy pool can throw before a pool exists; only close it after this succeeds.
  const query = pool.query;
  poolInitialized = true;
  const marker = await query<{ present: boolean }>(
    "SELECT to_regclass('pwusage_env.environment') IS NOT NULL AS present"
  );
  if (!marker.rows[0]?.present) throw new Error('Refusing: database has no Dev marker');
  const dev = await pool.query("SELECT 1 FROM pwusage_env.environment WHERE name = 'dev'");
  if (dev.rowCount !== 1) throw new Error('Refusing: database has no Dev marker');
  const site = await pool.query<{ name: string }>('SELECT name FROM "Site" WHERE id = $1', [siteId]);
  if (site.rows.length !== 1 || site.rows[0].name !== 'Harrison') {
    throw new Error('Refusing: site ID must identify Harrison');
  }
  const now = new Date();
  const result = dryRun
    ? await previewUrdbEstimatesForSite(siteId, api, now)
    : await runUrdbEstimatesForSite(siteId, api, now);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error: unknown) => {
  // Do not print database URLs or API keys from driver/network errors.
  const message = error instanceof Error && (error.message.startsWith('Refusing:') || error.message.startsWith('Usage:'))
    ? error.message : 'Live check failed; check the Dev database and OpenEI configuration.';
  console.error(message);
  process.exitCode = 1;
}).finally(async () => {
  if (!poolInitialized) return;
  try {
    await pool.end();
  } catch {
    console.error('Live check failed while closing the database connection.');
    process.exitCode = 1;
  }
});
