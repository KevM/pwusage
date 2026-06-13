import path from 'path';
import dotenv from 'dotenv';

// Load Env
dotenv.config({ path: path.resolve(__dirname, '../.env'), override: true });

async function main() {
    const [siteId, startISO, endISO] = process.argv.slice(2);
    if (!siteId || !startISO || !endISO) {
        console.error('usage: npx tsx scripts/backfill-charge-split.ts <siteId> <startISO> <endISO>');
        process.exit(1);
    }

    // Dynamic imports to prevent hoisting order issues with DATABASE_URL
    const { TeslaClient } = await import('../src/lib/tesla-client');
    const { Importer } = await import('../src/lib/importer');
    const { pool } = await import('../src/lib/db');

    // Fetch site & user token
    const siteRes = await pool.query('SELECT user_id FROM "Site" WHERE id = $1', [siteId]);
    const siteRow = siteRes.rows[0];
    if (!siteRow) {
        console.error(`Site ${siteId} not found in database!`);
        process.exit(1);
    }

    const userRes = await pool.query('SELECT access_token FROM "User" WHERE id = $1', [siteRow.user_id]);
    const token = userRes.rows[0]?.access_token;
    if (!token) {
        console.error(`No access token found for user ${siteRow.user_id}!`);
        process.exit(1);
    }

    const client = new TeslaClient({ accessToken: token });
    const importer = new Importer(client);

    console.log(`Starting charge-split backfill for site ${siteId} from ${startISO} to ${endISO}...`);
    const rows = await importer.importRange(
        siteId,
        new Date(startISO),
        new Date(endISO),
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
