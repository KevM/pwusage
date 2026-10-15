# Database Backups

Private production backups, stored in the private Vercel Blob store behind
`BACKUP_BLOB_READ_WRITE_TOKEN`. Production runs on the Supabase Free plan, which
has no automatic backups and a 5 GB monthly egress quota shared with the app.

## What runs

| Kind | When | Contents | Folder | Kept |
|---|---|---|---|---|
| `daily` | Every day, 09:23 UTC | Every table except `EnergyData`, plus the last 3 days of `EnergyData` (`energy-recent.csv`) | `db-backup/daily/` | 14 |
| `weekly` | Sundays, 09:41 UTC | Complete | `db-backup/weekly/` | 8 |
| `pre-migration` | Before migrations, on merges to `main` that change them | Complete | `db-backup/pre-migration/` | 10 |

`EnergyData` history is about 90% of a dump and can be re-imported from Tesla
(billable), so daily backups skip it. Measured 2026-10-15 against the dev copy of
production: a full dump is about 65 MB of egress and a daily one about 1.4 MB,
roughly 0.33 GB a month in total.

Backups made before 2026-10-15 sit directly under `db-backup/` as
`backup-<timestamp>.zip`. Retention never touches them; delete them by hand when
they are no longer wanted.

Everything is defined in one place: `cmd/next-app/scripts/db-backup-kinds.ts`
(folders, retention, full or daily dump) and `.github/workflows/db-backup.yml`
(schedule). To take a backup now: Actions → **Database Backup** → **Run workflow**.

## Safety checks

- **Verified before upload.** `verify-db-backup.ts` rejects a missing or empty
  file, a dump cut off inside a table, a full backup without `User`, `Site` or
  `EnergyData` rows, and a daily backup that still contains `EnergyData`. A failed
  `supabase db dump` can leave an empty file behind; it fails here instead of
  being stored.
- **Old backups go only after a new one lands.** Retention runs after a verified
  upload, and `db-backup-retention.ts` also refuses to delete anything unless the
  folder's newest backup is under 6 hours old.
- **Restores only into an empty database.** `restore-db-backup.sh` refuses any
  target with tables in its `public` schema, so it cannot overwrite production or
  dev. It loads everything in one transaction: a failure leaves the target empty.

## Restoring

1. **Pick the backups.** Use the newest daily backup and the newest weekly (or
   pre-migration) backup taken *before* it. A full backup on its own also works.

   ```bash
   export BLOB_READ_WRITE_TOKEN=<BACKUP_BLOB_READ_WRITE_TOKEN value>
   vercel blob list --prefix db-backup/daily/
   vercel blob list --prefix db-backup/weekly/
   vercel blob get db-backup/weekly/<file>.zip --access private -o weekly.zip
   vercel blob get db-backup/daily/<file>.zip --access private -o daily.zip
   ```

   The backups contain user data and Tesla tokens. Keep the files private and
   delete local copies when done.

2. **Create an empty database.** For a real recovery, a new Supabase project. For a
   rehearsal, a local Postgres; it needs Supabase's roles first (see below).

3. **Restore.**

   ```bash
   cd cmd/next-app
   bash scripts/restore-db-backup.sh --target "<new database URL>" --full weekly.zip --daily daily.zip
   ```

   The schema and all tables except `EnergyData` come from the daily backup.
   `EnergyData` history comes from the weekly backup, minus rows for sites deleted
   since, and the daily backup's last 3 days replace any overlap. Readings between
   the weekly backup and those 3 days are not in either backup; re-import them
   from Tesla if needed.

4. **Re-create what the backups do not contain.** Backups cover the `public`
   schema only. A new project also needs:
   - the extensions the app uses (`pg_cron`, `pg_net`) and the Vault secrets and
     cron jobs set up by the cron-trigger migrations in `db-migrations/`;
   - migration history, so CI does not re-run applied migrations;
   - Vercel's `DATABASE_URL` pointed at the new project.

### Local rehearsal

A plain Postgres lacks the roles Supabase schemas grant to. Create stand-ins in
the empty target before restoring:

```sql
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
```

`npm run test:backup:postgres` exercises the restore script against a disposable
local Postgres in CI and locally (set `DB_BACKUP_PG_BIN` to the Postgres `bin`
directory if `pg_config` is not on `PATH`).
