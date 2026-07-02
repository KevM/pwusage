import './bootstrap-env';
import { pool } from '../src/lib/db';

async function migrate() {
    console.log('Starting migration: User Table & Schema Updates...');
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        console.log('1. Creating User table...');
        await client.query(`
      CREATE TABLE IF NOT EXISTS "User" (
          id TEXT PRIMARY KEY,
          email TEXT,
          access_token TEXT,
          refresh_token TEXT,
          token_expires_at BIGINT,
          is_refreshing INTEGER DEFAULT 0,
          refresh_lock_expires BIGINT DEFAULT 0
      );
    `);

        console.log('2. checking for user_id column on Site...');
        const res = await client.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name='Site' AND column_name='user_id'
    `);

        if (res.rows.length === 0) {
            console.log('   Adding user_id column to Site table...');
            await client.query(`ALTER TABLE "Site" ADD COLUMN user_id TEXT REFERENCES "User"(id)`);
        } else {
            console.log('   user_id column already exists.');
        }

        console.log('3. Cleaning up legacy Site columns...');
        await client.query(`
            ALTER TABLE "Site" 
            DROP COLUMN IF EXISTS access_token,
            DROP COLUMN IF EXISTS refresh_token,
            DROP COLUMN IF EXISTS is_refreshing,
            DROP COLUMN IF EXISTS refresh_lock_expires
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
