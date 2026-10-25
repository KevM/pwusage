import { loadEnvConfig } from '@next/env';
import path from 'path';

// Load env before importing app modules that depend on DATABASE_URL, tokens, etc.
loadEnvConfig(path.resolve(__dirname, '../'));

/**
 * Smoke test for TeslaClient.setBackupReserve against the live Tesla Fleet API.
 *
 * SCOPE: setting the backup reserve is an energy *command*, so the user's token
 * must carry the `energy_cmds` ("Energy Product Commands") scope. The read-only
 * `energy_device_data` scope used elsewhere in the app is NOT sufficient — a
 * write with only that scope returns 403. The scope must be enabled in the
 * Tesla developer dashboard for the app's domain AND the user must re-authenticate
 * via /login so a fresh token carries it.
 *
 * SAFETY: this script issues a *write* command to a real Powerwall. It is
 * conservative by default:
 *   - With no --percent it is read-only: it just prints the current reserve.
 *   - With --percent but no --confirm it is a dry run: it prints what it would do.
 *   - Only with --percent N --confirm does it actually POST the new reserve.
 *   - --restore puts the original value back after a confirmed write, so a
 *     smoke test leaves the device exactly as it found it.
 *
 * Usage:
 *   npx tsx scripts/set-backup-reserve.ts                              # read current reserve (first site)
 *   npx tsx scripts/set-backup-reserve.ts --site <id>                  # read current reserve (specific site)
 *   npx tsx scripts/set-backup-reserve.ts --percent 30                 # dry run (no write)
 *   npx tsx scripts/set-backup-reserve.ts --percent 30 --confirm       # set reserve to 30%
 *   npx tsx scripts/set-backup-reserve.ts --percent 30 --confirm --restore  # set 30%, verify, then restore
 */

interface CliArgs {
    siteId?: string;
    percent?: number;
    confirm: boolean;
    restore: boolean;
}

// site_info caches backup_reserve_percent and lags the command (often a minute
// or more), so verification polls rather than reading once.
const VERIFY_POLL_INTERVAL_MS = 5000;
const VERIFY_TIMEOUT_MS = 120000;

function parseArgs(argv: string[]): CliArgs {
    const args: CliArgs = { confirm: false, restore: false };

    for (let i = 0; i < argv.length; i++) {
        const token = argv[i];
        if (token === '--site' || token === '--site-id') {
            args.siteId = argv[i + 1];
            i++;
        } else if (token === '--percent' || token === '--reserve') {
            args.percent = Number(argv[i + 1]);
            i++;
        } else if (token === '--confirm') {
            args.confirm = true;
        } else if (token === '--restore') {
            args.restore = true;
        }
    }

    return args;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Poll site_info until backup_reserve_percent matches `expected` (or we time out).
 * site_info lags the command, so a single read can falsely look like a failure.
 */
async function waitForReserve(
    client: { getEnergySiteInfo(siteId: string): Promise<{ backup_reserve_percent: number }> },
    siteId: string,
    expected: number
): Promise<{ matched: boolean; observed: number; waitedMs: number }> {
    const startedAt = Date.now();
    let observed = NaN;
    while (Date.now() - startedAt < VERIFY_TIMEOUT_MS) {
        await sleep(VERIFY_POLL_INTERVAL_MS);
        observed = (await client.getEnergySiteInfo(siteId)).backup_reserve_percent;
        const waitedMs = Date.now() - startedAt;
        if (observed === expected) {
            return { matched: true, observed, waitedMs };
        }
        console.log(`  …still ${observed}% after ${Math.round(waitedMs / 1000)}s, waiting for ${expected}%`);
    }
    return { matched: false, observed, waitedMs: Date.now() - startedAt };
}

async function run(): Promise<void> {
    const { SiteRepo } = await import('../src/lib/site-repo');
    const { createTeslaClientForSite } = await import('../src/lib/tesla-client-factory');

    const args = parseArgs(process.argv.slice(2));
    const siteRepo = new SiteRepo();

    let siteId = args.siteId;
    if (!siteId) {
        const siteIds = await siteRepo.getSiteIds();
        siteId = siteIds[0];
        if (!siteId) {
            throw new Error('No sites found in DB. Provide --site <siteId>.');
        }
        console.log(`No --site provided. Using first site: ${siteId}`);
    }

    const site = await siteRepo.getSite(siteId);
    if (!site) {
        throw new Error(`Site not found: ${siteId}`);
    }
    const client = await createTeslaClientForSite(siteId);
    if (!client) {
        throw new Error(`Site ${siteId} is missing Tesla tokens (access/refresh).`);
    }

    console.log(`\nBackup reserve smoke test`);
    console.log(`- site: ${site.name} (${siteId})`);

    // 1. Read the current reserve so we can report and (optionally) restore it.
    const before = await client.getEnergySiteInfo(siteId);
    const originalReserve = before.backup_reserve_percent;
    console.log(`- current backup_reserve_percent: ${originalReserve}%`);
    console.log(`- default_real_mode: ${before.default_real_mode}`);

    // No target requested: read-only probe, done.
    if (args.percent === undefined) {
        console.log('\nNo --percent given. Read-only probe complete (nothing written).');
        return;
    }

    if (!Number.isInteger(args.percent) || args.percent < 0 || args.percent > 100) {
        throw new Error(`Invalid --percent: ${args.percent}. Must be an integer between 0 and 100.`);
    }

    // Dry run unless explicitly confirmed.
    if (!args.confirm) {
        console.log(`\n[DRY RUN] Would set backup_reserve_percent: ${originalReserve}% -> ${args.percent}%`);
        console.log('Re-run with --confirm to actually write this value.');
        return;
    }

    // 2. Perform the write.
    console.log(`\nSetting backup_reserve_percent: ${originalReserve}% -> ${args.percent}% ...`);
    const result = await client.setBackupReserve(siteId, args.percent);
    console.log(`- command response: ${JSON.stringify(result)}`);

    // 3. Poll site_info to verify (it lags the command by up to a minute or more).
    console.log(`- verifying via site_info (polling up to ${VERIFY_TIMEOUT_MS / 1000}s)...`);
    const verify = await waitForReserve(client, siteId, args.percent);
    if (verify.matched) {
        console.log(`  ✓ Verified: site reports ${args.percent}% after ${Math.round(verify.waitedMs / 1000)}s.`);
    } else {
        console.log(`  ⚠ site_info still ${verify.observed}% after ${Math.round(verify.waitedMs / 1000)}s.`);
        console.log('    The command returned success; site_info caching can lag further. Check the Tesla app.');
    }

    // 4. Optionally restore the original value so the smoke test is non-destructive.
    if (args.restore) {
        console.log(`\nRestoring original backup_reserve_percent: ${args.percent}% -> ${originalReserve}% ...`);
        const restoreResult = await client.setBackupReserve(siteId, originalReserve);
        console.log(`- restore command response: ${JSON.stringify(restoreResult)}`);
        const restored = await waitForReserve(client, siteId, originalReserve);
        if (restored.matched) {
            console.log(`  ✓ Verified: original reserve ${originalReserve}% restored after ${Math.round(restored.waitedMs / 1000)}s.`);
        } else {
            console.log(`  ⚠ site_info still ${restored.observed}% after ${Math.round(restored.waitedMs / 1000)}s (caching lag).`);
        }
    } else {
        console.log(`\nLeft reserve at ${args.percent}%. To put it back, run:`);
        console.log(`  npx tsx scripts/set-backup-reserve.ts --site ${siteId} --percent ${originalReserve} --confirm`);
    }
}

run()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('Backup reserve smoke test failed:', error);
        process.exit(1);
    });
