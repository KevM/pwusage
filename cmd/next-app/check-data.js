const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

try {
    const envConfig = fs.readFileSync(path.resolve(__dirname, '.env'), 'utf8');
    envConfig.split('\n').forEach(line => {
        const match = line.match(/^([^=]+)=(.*)$/);
        if (match) {
            const key = match[1].trim();
            let value = match[2].trim();
            if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
            process.env[key] = value;
        }
    });
} catch (e) {
    console.error('Failed to read .env:', e);
}

// Force disable unauthorized reject for self-signed certs
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

(async () => {
    try {
        const client = await pool.connect();
        console.log('Connected.');
        const host = new URL(process.env.DATABASE_URL).host;
        console.log(`Connected to host: ${host}`);

        // Get All Sites
        const sitesRes = await client.query('SELECT id, name FROM "Site"');
        if (sitesRes.rows.length === 0) {
            console.log('No sites found.');
            process.exit(0);
        }

        for (const site of sitesRes.rows) {
            const siteId = site.id;
            console.log(`\nChecking Site: ${site.name} (${siteId})`);

            // Check Tariffs
            const tariffRes = await client.query('SELECT * FROM "Tariff" WHERE site_id = $1', [siteId]);
            console.log(`Tariffs found: ${tariffRes.rows.length}`);
            tariffRes.rows.forEach(t => console.log(` - ID: ${t.id}, Name: ${t.name}`));

            // Check EnergyData count
            const countRes = await client.query('SELECT count(*) FROM "EnergyData" WHERE site_id = $1', [siteId]);
            const count = parseInt(countRes.rows[0].count);
            console.log('Total EnergyData Rows:', count);

            if (count > 0 && count < 10) {
                const rows = await client.query('SELECT * FROM "EnergyData" WHERE site_id = $1', [siteId]);
                console.log('Rows:', rows.rows);
            }

        }


        client.release();
        process.exit(0);
    } catch (err) {
        console.error('Error:', err);
        process.exit(1);
    }
})();
