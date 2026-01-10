
import { loadEnvConfig } from '@next/env';
import path from 'path';

// Load env BEFORE importing db
loadEnvConfig(path.resolve(__dirname, '../'));

async function run() {
    try {
        const { pool } = await import('../src/lib/db');

        console.log('Checking Sites...');
        const sites = await pool.query('SELECT * FROM "Site"');
        console.log(`Found ${sites.rows.length} sites.`);

        for (const site of sites.rows) {
            console.log(`\nSite: ${site.name} (ID: ${site.id}) (User: ${site.user_id})`);

            // Check data count
            const count = await pool.query('SELECT COUNT(*) FROM "EnergyData" WHERE site_id = $1', [site.id]);
            console.log(`  Total Data Points: ${count.rows[0].count}`);

            // Check latest data
            const latest = await pool.query('SELECT MAX(timestamp) as last_ts FROM "EnergyData" WHERE site_id = $1', [site.id]);
            console.log(`  Latest Data: ${latest.rows[0].last_ts}`);

            // Check max power in last 7 days
            const maxP = await pool.query(`
                SELECT MAX(grid_power) as max_grid, MAX(load_power) as max_load 
                FROM "EnergyData" 
                WHERE site_id = $1 AND timestamp > NOW() - INTERVAL '7 days'
            `, [site.id]);
            console.log(`  Max Grid (7d): ${maxP.rows[0].max_grid} W`);
            console.log(`  Max Load (7d): ${maxP.rows[0].max_load} W`);
        }

    } catch (error) {
        console.error('Error checking sites:', error);
    } finally {
        process.exit(0);
    }
}

run();
