import path from 'path';
import dotenv from 'dotenv';

// Load Env
dotenv.config({ path: path.resolve(__dirname, '../.env'), override: true });

async function main() {
    const siteId = process.argv[2];
    if (!siteId) {
        console.error('usage: npx tsx scripts/backfill-charge-split.ts <siteId>');
        process.exit(1);
    }

    // Dynamic imports to prevent hoisting order issues with DATABASE_URL
    const { TeslaClient } = await import('../src/lib/tesla-client');
    const { Importer } = await import('../src/lib/importer');
    const { SiteRepo } = await import('../src/lib/site-repo');
    const { pool } = await import('../src/lib/db');

    // Fetch site & user token
    const siteRepo = new SiteRepo();
    const site = await siteRepo.getSite(siteId);
    if (!site) {
        console.error(`Site ${siteId} not found in database!`);
        process.exit(1);
    }

    const installDate = new Date(site.installed);
    const start = new Date(installDate);
    const end = new Date(Date.now() - 24 * 60 * 60 * 1000); // Up to yesterday
    
    // Ensure we start at midnight of the install date
    start.setUTCHours(0, 0, 0, 0);
    end.setUTCHours(23, 59, 59, 999);

    const userRes = await pool.query('SELECT access_token FROM "User" WHERE id = $1', [site.user_id]);
    const token = userRes.rows[0]?.access_token;
    if (!token) {
        console.error(`No access token found for user ${site.user_id}!`);
        process.exit(1);
    }

    const client = new TeslaClient({ accessToken: token });
    const importer = new Importer(client);

    console.log(`Site: ${site.name} (Installed: ${installDate.toISOString().slice(0, 10)})`);
    console.log(`Starting charge-split backfill from install date ${start.toISOString().slice(0, 10)} to yesterday ${end.toISOString().slice(0, 10)}...`);

    const rows = await importer.importRange(
        siteId,
        start,
        end,
        'day',
        (d) => console.log('imported', d.toISOString().slice(0, 10))
    );

    console.log(`done: ${rows.length} rows re-imported with charge split`);
}

main()
    .then(() => process.exit(0))
    .catch((e) => {
        console.error(e);
        process.exit(1);
    });
