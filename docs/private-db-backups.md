# Private database backups

Before merging the private backup workflow:

1. In Vercel Storage, create a separate **private** Blob store for database backups. Keep the existing public store for announcement images.
2. Copy the private store's read-write token into the GitHub repository Actions secret `BACKUP_BLOB_READ_WRITE_TOKEN`. The uploader deliberately does not fall back to `BLOB_READ_WRITE_TOKEN`.
3. After merge, the next production migration saves its ZIP under `db-backup/` in the private store. A missing token or failed upload blocks the dependent migration job.

Private backups require authenticated access through Vercel's dashboard or Blob SDK. Migration verification currently dumps production directly and does not download these backup blobs, so its restore path does not change.

This change protects future backups. Existing public backups stay in the old store; review and migrate them to private storage, verify those copies, and separately authorize removal of the public copies. Do not switch the existing announcement store to private.

To upload an existing local backup to the private store, set the dedicated token in your private environment and run from `cmd/next-app`:

```sh
npx tsx scripts/upload-db-backup.ts /path/to/backup.zip
```
