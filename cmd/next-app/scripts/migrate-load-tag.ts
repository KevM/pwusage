
import 'dotenv/config';
import { pool } from '../src/lib/db';

async function migrate() {
    console.log('Starting migration: LoadTag Table...');
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        console.log('Creating LoadTag table if not exists...');
        await client.query(`
            CREATE TABLE IF NOT EXISTS "LoadTag" (
                id SERIAL PRIMARY KEY,
                site_id TEXT NOT NULL REFERENCES "Site"(id) ON DELETE CASCADE,
                start_time TIMESTAMP NOT NULL,
                end_time TIMESTAMP NOT NULL,
                tag TEXT NOT NULL,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await client.query('COMMIT');
        console.log('Migration completed successfully.');
    } catch (e) {
        await client.query('ROLLBACK');
        console.error('Migration failed:', e);
        process.exit(1);
    } finally {
        client.release();
        await pool.end();
    }
}

migrate();
