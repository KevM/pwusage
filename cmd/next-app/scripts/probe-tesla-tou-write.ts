import { loadEnvConfig } from '@next/env';
import { mkdirSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';

// Load env before importing app modules that depend on DATABASE_URL, tokens, etc.
loadEnvConfig(path.resolve(__dirname, '../'));

/**
 * Research probe: can we upload a rate plan with finer-than-Tesla-app precision?
 *
 * Tesla's Fleet API documents `POST /api/1/energy_sites/{id}/time_of_use_settings`
 * (body `{ tou_settings: { tariff_content_v2 } }`) but says nothing about decimal places.
 * This script finds out by writing the site's CURRENT tariff back with exactly one buy
 * rate raised by 0.00001 $/kWh, then reading `site_info` to see whether Tesla kept all
 * five decimals or rounded them away.
 *
 * SCOPE: a write command, so the token needs `energy_cmds` (same as the backup reserve).
 *
 * SAFETY: this changes the rates a real Powerwall uses.
 *   - No flags: read-only. Prints the current tariff's rates and precision.
 *   - --site <id> without --confirm: dry run. Prints the one-rate change it would make.
 *   - --site <id> --confirm: writes the nudged tariff. --site is REQUIRED for writes
 *     (never "first site"); use a site you own. The original tariff is saved to a JSON
 *     file first, and --restore writes it back afterwards. Use --restore.
 *
 * Usage:
 *   npx tsx scripts/probe-tesla-tou-write.ts                               # read-only, first site
 *   npx tsx scripts/probe-tesla-tou-write.ts --site <id>                   # read-only
 *   npx tsx scripts/probe-tesla-tou-write.ts --site <id> --dry-run         # show the change
 *   npx tsx scripts/probe-tesla-tou-write.ts --site <id> --confirm --restore
 */

const VERIFY_POLL_INTERVAL_MS = 5000;
const VERIFY_TIMEOUT_MS = 120000;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface CliArgs {
    siteId?: string;
    confirm: boolean;
    restore: boolean;
}

function parseArgs(argv: string[]): CliArgs {
    const args: CliArgs = { confirm: false, restore: false };
    for (let i = 0; i < argv.length; i++) {
        const token = argv[i];
        if (token === '--site' || token === '--site-id') {
            args.siteId = argv[++i];
        } else if (token === '--confirm') {
            args.confirm = true;
        } else if (token === '--restore') {
            args.restore = true;
        }
    }
    return args;
}

async function run(): Promise<void> {
    const { SiteRepo } = await import('../src/lib/site-repo');
    const { createTeslaClientForSite } = await import('../src/lib/tesla-client-factory');
    const { buildPrecisionProbe, decimalPlaces, listRates } = await import('../src/lib/tesla-tou-probe');

    const args = parseArgs(process.argv.slice(2));
    const siteRepo = new SiteRepo();

    if (args.confirm && !args.siteId) {
        throw new Error('--confirm needs an explicit --site <id>: this writes to a real Powerwall.');
    }
    let siteId = args.siteId;
    if (!siteId) {
        siteId = (await siteRepo.getSiteIds())[0];
        if (!siteId) throw new Error('No sites found in DB. Provide --site <siteId>.');
        console.log(`No --site provided. Using first site: ${siteId}`);
    }
    // Name only: getSite() also joins tables this probe does not need (and that an older
    // database may not have yet).
    const { pool } = await import('../src/lib/db');
    const siteName = (await pool.query<{ name: string | null }>('SELECT name FROM "Site" WHERE id = $1', [siteId])).rows[0];
    if (!siteName) throw new Error(`Site not found: ${siteId}`);
    const client = await createTeslaClientForSite(siteId);
    if (!client) throw new Error(`Site ${siteId} is missing Tesla tokens (access/refresh).`);

    console.log(`\nTime-of-use precision probe`);
    console.log(`- site: ${siteName.name} (${siteId})`);

    const before = await client.getEnergySiteInfo(siteId);
    const original = before.tariff_content_v2;
    if (!original) throw new Error('site_info has no tariff_content_v2.');
    const rates = listRates(original);
    console.log(`- tariff: ${original.name} (${original.utility}), tou_capable=${before.components?.tou_capable}`);
    for (const rate of rates) {
        console.log(`    ${rate.chargeKind.padEnd(4)} ${rate.period.padEnd(28)} ${rate.value}  (${decimalPlaces(rate.value)} dp)`);
    }
    const maxDp = Math.max(0, ...rates.map((r) => decimalPlaces(r.value)));
    console.log(`- most precise stored rate: ${maxDp} decimal places`);

    const probe = buildPrecisionProbe(original);
    if (!probe) throw new Error('No buy rate to nudge in this tariff.');
    const { target } = probe;

    if (!args.confirm) {
        console.log(`\n[${args.siteId ? 'DRY RUN' : 'READ-ONLY'}] Would change buy ${target.group}/${target.period}: ${target.before} -> ${target.after}`);
        console.log('Re-run with --site <id> --confirm --restore to actually write (and put it back).');
        return;
    }

    // Save the original so a failed restore can be redone by hand.
    const backupDir = path.join(os.tmpdir(), 'pwusage-tou-probe');
    mkdirSync(backupDir, { recursive: true });
    const backupFile = path.join(backupDir, `${siteId}-${Date.now()}.json`);
    writeFileSync(backupFile, JSON.stringify(original, null, 2));
    console.log(`\nOriginal tariff saved to ${backupFile}`);

    console.log(`Writing buy ${target.group}/${target.period}: ${target.before} -> ${target.after} ...`);
    const result = await client.setTimeOfUseSettings(siteId, probe.candidate);
    console.log(`- command response: ${JSON.stringify(result)}`);

    // site_info lags writes, so poll until the rate changes at all.
    const startedAt = Date.now();
    let observed = target.before;
    while (Date.now() - startedAt < VERIFY_TIMEOUT_MS) {
        await sleep(VERIFY_POLL_INTERVAL_MS);
        const info = await client.getEnergySiteInfo(siteId);
        observed = info.tariff_content_v2?.energy_charges?.[target.group]?.rates?.[target.period] ?? NaN;
        if (observed !== target.before) break;
        console.log(`  ...still ${observed} after ${Math.round((Date.now() - startedAt) / 1000)}s`);
    }
    if (observed === target.after) {
        console.log(`  ✓ Tesla kept the 5-decimal rate: ${observed}`);
    } else if (observed === target.before) {
        console.log(`  ⚠ Still ${observed} after ${Math.round((Date.now() - startedAt) / 1000)}s (caching lag, or the write was ignored).`);
    } else {
        console.log(`  ✗ Tesla stored ${observed} instead of ${target.after}: precision was changed (rounded/truncated).`);
    }

    if (args.restore) {
        console.log('\nRestoring the original tariff ...');
        const restored = await client.setTimeOfUseSettings(siteId, original);
        console.log(`- restore response: ${JSON.stringify(restored)}`);
    } else {
        console.log(`\nLeft the probe rate in place. To put it back, rewrite ${backupFile} via setTimeOfUseSettings.`);
    }
}

run()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('TOU precision probe failed:', error);
        process.exit(1);
    });
