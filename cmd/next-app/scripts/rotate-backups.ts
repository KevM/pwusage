
import { list, del } from '@vercel/blob';

async function rotateBackups() {
    console.log('Starting Backup Rotation...');

    if (!process.env.BLOB_READ_WRITE_TOKEN) {
        console.error('Error: BLOB_READ_WRITE_TOKEN environment variable is missing.');
        process.exit(1);
    }

    try {
        // List all files in the db-backup folder
        // Note: list operation might return pagination if there are many files, 
        // but for <100 backups default limit is usually fine. 
        // We'll trust default for now, which is usually 1000.
        const { blobs } = await list({
            prefix: 'db-backup/',
            token: process.env.BLOB_READ_WRITE_TOKEN,
        });

        console.log(`Found ${blobs.length} backups in 'db-backup/'.`);

        // Sort by uploadedAt descending (newest first)
        const sortedBlobs = blobs.sort((a, b) => {
            return new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime();
        });

        const BACKUP_LIMIT = 10;

        if (sortedBlobs.length <= BACKUP_LIMIT) {
            console.log(`Backup count (${sortedBlobs.length}) is within acceptable limit (${BACKUP_LIMIT}). No deletion needed.`);
            return;
        }

        const blobsToDelete = sortedBlobs.slice(BACKUP_LIMIT);
        console.log(`Deleting ${blobsToDelete.length} old backups...`);

        // Delete in parallel
        await Promise.all(blobsToDelete.map(async (blob) => {
            console.log(`Deleting: ${blob.url}`);
            await del(blob.url, { token: process.env.BLOB_READ_WRITE_TOKEN });
        }));

        console.log('Rotation complete.');

    } catch (error) {
        console.error('Rotation failed:', error);
        process.exit(1);
    }
}

rotateBackups();
