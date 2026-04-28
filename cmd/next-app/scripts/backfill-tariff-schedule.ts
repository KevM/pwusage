import 'dotenv/config';
import { pool } from '../src/lib/db';
import { EnergyRepo } from '../src/lib/energy-repo';
import { Schedule } from '../src/lib/schedule';

async function main() {
    try {
        const repo = new EnergyRepo();
        const client = await pool.connect();
        
        try {
            // Get all site IDs
            const sitesRes = await client.query('SELECT DISTINCT site_id FROM "EnergyData"');
            const siteIds = sitesRes.rows.map(r => r.site_id);
            
            console.log(`Found ${siteIds.length} sites. Starting backfill...`);
            
            const cutoff = new Date();
            cutoff.setDate(cutoff.getDate() - 45);
            
            for (const siteId of siteIds) {
                const site = await repo.getSite(siteId);
                if (!site) {
                    console.log(`[Site ${siteId}] Could not load site data. Skipping.`);
                    continue;
                }
                
                const schedule = new Schedule(site.tariffs, site.timezone);
                
                const rowsRes = await client.query(`
                    SELECT id, timestamp 
                    FROM "EnergyData" 
                    WHERE site_id = $1 
                      AND timestamp >= $2 
                      AND tariff_schedule_id IS NULL
                `, [siteId, cutoff]);
                
                const rows = rowsRes.rows;
                if (rows.length === 0) {
                    console.log(`[Site ${siteId}] scanned=0 updated=0 unmatched=0`);
                    continue;
                }
                
                const idBuckets = new Map<number, number[]>(); // schedule_id -> array of row IDs
                let unmatched = 0;
                
                for (const row of rows) {
                    const ts = new Date(row.timestamp);
                    const period = schedule.getTariffPeriod(ts);
                    const scheduleId = period?.schedule.id ?? null;
                    
                    if (scheduleId === null) {
                        unmatched++;
                    } else {
                        if (!idBuckets.has(scheduleId)) {
                            idBuckets.set(scheduleId, []);
                        }
                        idBuckets.get(scheduleId)!.push(row.id);
                    }
                }
                
                let updated = 0;
                
                for (const [scheduleId, ids] of idBuckets.entries()) {
                    // Update in chunks of 1000
                    for (let i = 0; i < ids.length; i += 1000) {
                        const chunk = ids.slice(i, i + 1000);
                        await client.query(`
                            UPDATE "EnergyData" 
                            SET tariff_schedule_id = $1 
                            WHERE id = ANY($2::int[]) 
                              AND tariff_schedule_id IS NULL
                        `, [scheduleId, chunk]);
                        updated += chunk.length;
                    }
                }
                
                console.log(`[Site ${siteId}] scanned=${rows.length} updated=${updated} unmatched=${unmatched}`);
            }
            
            console.log('Backfill complete.');
        } finally {
            client.release();
            await pool.end();
        }
    } catch (err) {
        console.error('Error during backfill:', err);
        process.exit(1);
    }
}

main();
