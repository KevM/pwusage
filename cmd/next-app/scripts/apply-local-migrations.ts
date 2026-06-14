import { Pool } from 'pg';
import { loadEnvConfig } from '@next/env';
import path from 'path';
import fs from 'fs';

// Load env from project root
loadEnvConfig(path.resolve(__dirname, '../'));

let connStr = process.env.DATABASE_URL || '';
if (connStr.includes('sslmode=require')) {
    connStr = connStr.replace('sslmode=require', '');
}

const pool = new Pool({
    connectionString: connStr,
    ssl: {
        rejectUnauthorized: false
    }
});

async function run() {
    console.log('Applying migrations to database...');
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Locate migration file
        const migrationFile = path.resolve(__dirname, '../db-migrations/20260614065533_roi_reporting_tariffs.sql');
        if (!fs.existsSync(migrationFile)) {
            throw new Error(`Migration file not found: ${migrationFile}`);
        }

        const sql = fs.readFileSync(migrationFile, 'utf8');
        console.log(`Executing SQL from 20260614065533_roi_reporting_tariffs.sql...`);
        await client.query(sql);

        await client.query('COMMIT');
        console.log('Migration applied successfully!');
    } catch (e) {
        await client.query('ROLLBACK');
        console.error('Migration failed:', e);
        process.exit(1);
    } finally {
        client.release();
        await pool.end();
    }
}

run();
