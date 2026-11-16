/**
 * Store the Tesla rate plan already saved in Site.json -> tariff_content_v2 for sites that have no
 * Tariff rows. Makes no Tesla calls. Dry run by default.
 *
 *   npx tsx scripts/backfill-stored-tariffs.ts                       # dry run, every candidate site
 *   npx tsx scripts/backfill-stored-tariffs.ts --site <id> --apply   # write one site (Dev DB)
 *   npx tsx scripts/backfill-stored-tariffs.ts --apply --allow-prod  # write every site on a non-Dev DB
 *
 * Each write goes through TariffRepo.addTariffVersion: the Tesla version and its span (starting at
 * the site's first archived day), a queued re-attribution, URDB estimates and SiteUtility pending.
 */
import './bootstrap-env';
import { pool } from '../src/lib/db';
import {
  backfillStoredTariffs,
  STORED_TARIFF_CANDIDATES_SQL,
  type StoredTariffSite,
} from '../src/lib/importer/stored-tariff-backfill';
import { TariffRepo } from '../src/lib/tariff-repo';

const USAGE = 'Usage: npx tsx scripts/backfill-stored-tariffs.ts [--site <id>] [--apply [--allow-prod]]';
let poolInitialized = false;

interface Args { siteId: string | null; apply: boolean; allowProd: boolean }

function parseArgs(argv: string[]): Args {
  const args: Args = { siteId: null, apply: false, allowProd: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') args.apply = true;
    else if (arg === '--allow-prod') args.allowProd = true;
    else if (arg === '--site' && args.siteId === null && argv[i + 1] && !argv[i + 1].startsWith('--')) args.siteId = argv[++i];
    else throw new Error(USAGE);
  }
  if (args.allowProd && !args.apply) throw new Error(USAGE);
  return args;
}

async function isDevDatabase(): Promise<boolean> {
  const marker = await pool.query<{ present: boolean }>(
    "SELECT to_regclass('pwusage_env.environment') IS NOT NULL AS present"
  );
  if (!marker.rows[0]?.present) return false;
  const dev = await pool.query("SELECT 1 FROM pwusage_env.environment WHERE name = 'dev'");
  return dev.rowCount === 1;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!process.env.DATABASE_URL?.trim()) throw new Error('Refusing: DATABASE_URL is required');
  // Accessing the lazy pool can throw before a pool exists; only close it after this succeeds.
  void pool.query;
  poolInitialized = true;

  const dev = await isDevDatabase();
  if (args.apply && !dev && !args.allowProd) {
    throw new Error('Refusing: database has no Dev marker; pass --allow-prod to write to it');
  }

  const { rows } = await pool.query<StoredTariffSite>(STORED_TARIFF_CANDIDATES_SQL);
  const sites = args.siteId ? rows.filter(site => site.id === args.siteId) : rows;
  if (args.siteId && sites.length === 0) throw new Error('Refusing: that site has Tariff rows or no stored Tesla plan');

  const repo = new TariffRepo();
  const results = await backfillStoredTariffs(sites, {
    addTariffVersion: (siteId, parsed, metadata) => repo.addTariffVersion(siteId, parsed, metadata),
  }, { apply: args.apply });

  const counts: Record<string, number> = {};
  for (const result of results) counts[result.outcome] = (counts[result.outcome] ?? 0) + 1;
  const withEmptySeason = results.filter(result => (result.skippedEmptySeasons ?? 0) > 0).length;
  console.log(JSON.stringify({
    database: dev ? 'dev' : 'not-dev',
    mode: args.apply ? 'apply' : 'dry-run',
    candidates: sites.length,
    counts,
    withEmptySeason,
    // Site IDs only: no names, plan details or utility in the output.
    sites: results.map(({ siteId, outcome, seasons, skippedEmptySeasons, error }) => ({ siteId, outcome, seasons, skippedEmptySeasons, error })),
  }, null, 2));
  if (counts.failed) process.exitCode = 1;
}

main().catch((error: unknown) => {
  // Do not print database URLs from driver/network errors.
  const message = error instanceof Error && (error.message.startsWith('Refusing:') || error.message.startsWith('Usage:'))
    ? error.message : 'Backfill failed; check the database configuration.';
  console.error(message);
  process.exitCode = 1;
}).finally(async () => {
  if (!poolInitialized) return;
  try {
    await pool.end();
  } catch {
    console.error('Backfill failed while closing the database connection.');
    process.exitCode = 1;
  }
});
