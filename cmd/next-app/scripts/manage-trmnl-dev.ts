import './bootstrap-env';
import { pool } from '../src/lib/db';
import { writeFile, readFile } from 'fs/promises';

const SITE_NAME = 'Harrison';
const BACKUP_FILE = 'trmnl-harrison-backup.json';

async function main() {
    const args = process.argv.slice(2);
    const command = args[0];
    const uuid = args[1];

    if (!command) {
        console.log('Usage:');
        console.log('  npx tsx scripts/manage-trmnl-dev.ts capture');
        console.log('  npx tsx scripts/manage-trmnl-dev.ts restore');
        console.log('  npx tsx scripts/manage-trmnl-dev.ts clear');
        console.log('  npx tsx scripts/manage-trmnl-dev.ts set <uuid>');
        process.exit(1);
    }

    try {
        // 1. Find Site
        // Using strict name check for safety
        const siteRes = await pool.query('SELECT id, name FROM "Site" WHERE name = $1', [SITE_NAME]);

        if (siteRes.rows.length === 0) {
            console.error(`Site "${SITE_NAME}" not found!`);
            process.exit(1);
        }

        const site = siteRes.rows[0];
        console.log(`Found Site: ${site.name} (${site.id})`);

        // 2. Execute Command
        if (command === 'clear') {
            await clearInstallation(site.id);
        } else if (command === 'set') {
            if (!uuid) {
                console.error('Error: UUID required for set command');
                process.exit(1);
            }
            await setInstallation(site.id, uuid);
        } else if (command === 'capture' || command === 'backup') {
            await captureInstallation(site.id);
        } else if (command === 'restore') {
            await restoreInstallation(site.id);
        } else {
            console.error('Unknown command:', command);
        }

    } catch (err) {
        console.error('Error:', err);
    } finally {
        await pool.end();
    }
}

async function clearInstallation(siteId: string) {
    console.log(`Clearing Trmnl Installation for site ${siteId}...`);
    // Fetch first to show what was removed
    const exist = await pool.query('SELECT uuid FROM "TrmnlInstallation" WHERE site_id = $1', [siteId]);
    if (exist.rows.length > 0) {
        console.log(`Removing existing UUID: ${exist.rows[0].uuid}`);
    } else {
        console.log('No existing installation found.');
    }
    const res = await pool.query('DELETE FROM "TrmnlInstallation" WHERE site_id = $1', [siteId]);
    console.log(`Deleted ${res.rowCount} rows.`);
}

async function setInstallation(siteId: string, uuid: string) {
    console.log(`Setting Trmnl Installation for site ${siteId} to UUID: ${uuid}...`);

    // Upsert: Create or Update
    const res = await pool.query(`
        INSERT INTO "TrmnlInstallation" (uuid, site_id, created_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (uuid) DO UPDATE SET
            site_id = EXCLUDED.site_id
    `, [uuid, siteId]);

    // Cleanup: Ensure site is only linked to THIS uuid?
    const cleanRes = await pool.query('DELETE FROM "TrmnlInstallation" WHERE site_id = $1 AND uuid != $2', [siteId, uuid]);
    if (cleanRes.rowCount && cleanRes.rowCount > 0) {
        console.log(`Cleaned up ${cleanRes.rowCount} old/conflicting installations for this site.`);
    }

    console.log(`Successfully linked UUID ${uuid} to site ${siteId}.`);
}

async function captureInstallation(siteId: string) {
    console.log(`Capturing Trmnl Installation for site ${siteId}...`);
    const res = await pool.query('SELECT * FROM "TrmnlInstallation" WHERE site_id = $1', [siteId]);

    if (res.rows.length === 0) {
        console.log('No installation found to capture.');
        return;
    }

    // Capture ALL rows (even duplicates or bad data, to be safe)
    const data = res.rows;
    await writeFile(BACKUP_FILE, JSON.stringify(data, null, 2));
    console.log(`Saved ${data.length} installation records to ${BACKUP_FILE}`);
}

async function restoreInstallation(siteId: string) {
    console.log(`Restoring Trmnl Installation for site ${siteId} from ${BACKUP_FILE}...`);

    try {
        const fileContent = await readFile(BACKUP_FILE, 'utf-8');
        let data = JSON.parse(fileContent);

        // Normalize to array
        if (!Array.isArray(data)) {
            data = [data];
        }

        console.log(`Restoring ${data.length} records...`);

        const restoredUuids: string[] = [];

        for (const record of data) {
            if (!record.uuid) {
                // Warn but maybe skip? Or insert? Unique constraint is on UUID.
                // If UUID is null, we can have multiple. 
                // But restore via UPSERT requires a conflict target.
                // If we can't identify it, we can't upsert it safely without creating dupes.
                // Let's skip nulls for now as they are likely trash.
                console.warn('Skipping record with NULL UUID during restore.');
                continue;
            }

            restoredUuids.push(record.uuid);

            // Upsert
            await pool.query(`
                INSERT INTO "TrmnlInstallation" (
                    uuid, site_id, plugin_setting_id, json, access_token, refresh_token, created_at
                )
                VALUES ($1, $2, $3, $4, $5, $6, NOW())
                ON CONFLICT (uuid) DO UPDATE SET
                    site_id = EXCLUDED.site_id,
                    plugin_setting_id = EXCLUDED.plugin_setting_id,
                    json = EXCLUDED.json,
                    access_token = EXCLUDED.access_token,
                    refresh_token = EXCLUDED.refresh_token
            `, [
                record.uuid,
                siteId, // Force to current site
                record.plugin_setting_id,
                record.json,
                record.access_token,
                record.refresh_token
            ]);
        }

        // Cleanup: Remove any installations for this site that were NOT in the backup?
        // This makes "Restore" an authoritative reset to the backup state.
        if (restoredUuids.length > 0) {
            const cleanup = await pool.query(`
                DELETE FROM "TrmnlInstallation" 
                WHERE site_id = $1 AND uuid NOT IN (${restoredUuids.map((_, i) => `$${i + 2}`).join(',')})
            `, [siteId, ...restoredUuids]);
            console.log(`Cleaned up ${cleanup.rowCount} records not in backup.`);
        } else {
            // If backup had no valid UUIDs, maybe clear everything?
            // Or maybe we shouldn't touch existing?
            // Let's assume if we are restoring empty/trash, we shouldn't wipe valid stuff unless explicit.
            console.log('No valid UUIDs restored. Skipping cleanup.');
        }

        console.log('Restore complete.');

    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            console.error(`Backup file ${BACKUP_FILE} not found.`);
        } else {
            console.error('Error restoring:', err);
        }
    }
}

main();
