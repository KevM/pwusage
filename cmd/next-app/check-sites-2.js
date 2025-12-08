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

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
});

(async () => {
    try {
        const client = await pool.connect();
        console.log('Connected to DB.');

        // Check tables
        const tables = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
    `);
        console.log('Tables:', tables.rows.map(r => r.table_name));

        // Check sites
        const res = await client.query('SELECT count(*) FROM "Site"');
        console.log('Site count:', res.rows[0].count);

        if (parseInt(res.rows[0].count) > 0) {
            const sites = await client.query('SELECT id, name FROM "Site"');
            console.log('Sites:', sites.rows);
        } else {
            console.log('No sites found.');
        }

        client.release();
        process.exit(0);
    } catch (err) {
        console.error('Error:', err);
        process.exit(1);
    }
})();
