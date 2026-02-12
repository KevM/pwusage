const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// Manually load .env since we are standalone
try {
    const envPath = path.resolve(__dirname, '../.env');
    if (fs.existsSync(envPath)) {
        const envContent = fs.readFileSync(envPath, 'utf8');
        envContent.split('\n').forEach(line => {
            const match = line.match(/^([^=]+)=(.*)$/);
            if (match) {
                const key = match[1].trim();
                let value = match[2].trim();
                if (value.startsWith('"') && value.endsWith('"')) {
                    value = value.slice(1, -1);
                }
                process.env[key] = value;
            }
        });
    }
} catch (e) {
    console.warn('.env not found or unreadable', e);
}

// Strip sslmode=require if present for the script usage
let connStr = process.env.DATABASE_URL || '';
if (connStr.includes('sslmode=require')) {
    connStr = connStr.replace('sslmode=require', '');
}

// Force SSL override for script output cleanliness
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const pool = new Pool({
    connectionString: connStr,
    ssl: { rejectUnauthorized: false }
});

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

rl.question('Are you sure you want to WIPE the database? This cannot be undone. (y/N): ', async (answer) => {
    if (answer.toLowerCase() !== 'y') {
        console.log('Aborted.');
        rl.close();
        process.exit(0);
    }

    try {
        const client = await pool.connect();
        console.log('Connected. Wiping data...');

        await client.query('BEGIN');

        // Truncate tables with CASCADE to handle foreign keys
        await client.query('TRUNCATE TABLE "EnergyData", "TariffSchedule", "TariffSeason", "Tariff", "Site", "TrmnlInstallation" RESTART IDENTITY CASCADE');

        await client.query('COMMIT');
        console.log('Database wiped successfully.');

        client.release();
        process.exit(0);
    } catch (err) {
        console.error('Error wiping database:', err);
        process.exit(1);
    }
});
