# Migrate existing database backups

`cmd/next-app/scripts/migrate-db-backups.ts` copies the `db-backup/` prefix from the public `pwusage-blob` store into the private `pwusage-db-backups` store. It preserves the full paths, leaving announcement images and public originals untouched. This is a copy-and-verify operation; removing the old public backups requires a separate action.

Run from `cmd/next-app` with these environment variables in your private `.env` file or shell:

- `BLOB_READ_WRITE_TOKEN`: the source `pwusage-blob` credential (existing application credential).
- `BACKUP_BLOB_READ_WRITE_TOKEN`: the destination `pwusage-db-backups` credential (the same value used by GitHub Actions).

The script loads `.env` at startup and checks that both tokens belong to the expected stores. Vercel's production connection calls the destination variable `BACKUP_READ_WRITE_TOKEN`; map that value to `BACKUP_BLOB_READ_WRITE_TOKEN` when running this script. GitHub does not expose stored secret values for retrieval. Do not commit credentials or pass them as command-line arguments.

Preview all backups without downloading or uploading file contents:

```sh
npx tsx scripts/migrate-db-backups.ts --dry-run
```

Copy and verify:

```sh
npx tsx scripts/migrate-db-backups.ts --apply
```

The default is dry run. The script lists every page before copying, skips zero-byte folder markers, and processes one backup at a time. Each source is streamed to a temporary file with restricted permissions, uploaded with private access, and downloaded with authentication to compare byte count and SHA-256. Temporary files are removed on success or failure. Allow temporary disk space for the largest backup; a killed process may leave a `pwusage-backup-migration-*` directory in the system temporary directory.

Rerunning `--apply` verifies existing destinations rather than uploading or overwriting them. Any download, upload, or verification failure stops the script with a nonzero exit code. A conflicting destination is retained for inspection; do not remove or replace it until its contents have been reviewed. Successful copies from earlier in the run remain available for the next run. New source backups created after listing are handled by a subsequent run.

The script never deletes public originals. They remain publicly accessible until separately removed, even after all copies have been verified. Verification downloads both source and destination bytes, so account for Blob request and data-transfer charges.
