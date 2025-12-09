const { Pool } = require('pg');

let connStr = process.env.DATABASE_URL || '';
if (connStr.includes('sslmode=require')) {
    connStr = connStr.replace('sslmode=require', '');
}

const pool = new Pool({
    connectionString: connStr,
    ssl: { rejectUnauthorized: false }
});

async function run() {
    const client = await pool.connect();
    try {
        const resText = await client.query('SELECT timestamp::text as ts_text FROM "EnergyData" ORDER BY timestamp DESC LIMIT 5');
        console.log('Raw Strings in DB:');
        resText.rows.forEach(r => console.log(r.ts_text));
    } finally {
        client.release();
        pool.end();
    }
}

run().catch(console.error);
