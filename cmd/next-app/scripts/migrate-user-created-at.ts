import './bootstrap-env';
import { pool } from '../src/lib/db';

async function migrate() {
    try {
        console.log('Starting migration: Add created_at to User table...');

        // Check if column exists
        const res = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'User' AND column_name = 'created_at'
    `);

        if (res.rowCount === 0) {
            console.log('Column created_at does not exist. Adding it...');
            // Add column
            await pool.query(`ALTER TABLE "User" ADD COLUMN created_at BIGINT`);

            // Backfill with current time for existing users
            // Ideally we would use site installation time or something, but current time is safe fallback.
            // Or we can try to find the earliest site installation for that user?
            // Let's just use Date.now() for simplicity as per plan.
            const now = Date.now();
            await pool.query(`UPDATE "User" SET created_at = $1`, [now]);

            console.log('Column added and backfilled.');
        } else {
            console.log('Column created_at already exists.');
        }

    } catch (err) {
        console.error('Migration failed:', err);
        process.exit(1);
    } finally {
        await pool.end();
    }
}

migrate();
