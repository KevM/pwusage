# Database Backups

Private production backups, stored in the private Vercel Blob store behind
`BACKUP_BLOB_READ_WRITE_TOKEN`. Production runs on the Supabase Free plan, which
has no automatic backups and a 5 GB monthly egress quota shared with the app.

## What runs

| Kind | When | Folder | Kept |
|---|---|---|---|
| `daily` | Every day, 09:23 UTC | `db-backup/daily/` | 14 |
| `weekly` | Sundays, 09:41 UTC | `db-backup/weekly/` | 8 |
| `pre-migration` | Before migrations, on merges to `main` that change them | `db-backup/pre-migration/` | 10 |

Every kind is a complete dump of the `public` schema. Energy history is compact
day records (`EnergyDayArchive` + `EnergyDaySummary`, about 20 MB on production
on 2026-10-27), so every backup holds all of it. The kinds differ only in when
they run and how long they are kept.

Until 2026-10-27 raw 5-minute `EnergyData` held the history: daily backups then
skipped it (keeping 3 days in `energy-recent.csv`) and only weekly and
pre-migration backups were complete. The pre-migration backup taken before
`20261027120000_drop_energy_data` is the last one that holds `EnergyData`.

Backups made before 2026-10-15 sit directly under `db-backup/` as
`backup-<timestamp>.zip`. Retention never touches them; delete them by hand when
they are no longer wanted.

Everything is defined in one place: `cmd/next-app/scripts/db-backup-kinds.ts`
(folders, retention) and `.github/workflows/db-backup.yml`
(schedule). To take a backup now: Actions → **Database Backup** → **Run workflow**.

Data dumps explicitly select `--schema public`. Supabase-managed `auth` and
`storage` tables are excluded: some, such as `storage.buckets_vectors`, cannot
be restored by the hosted `postgres` role. These backups cover application data,
not Supabase Auth accounts or Storage metadata.

The separate prod -> dev copy that CI makes for migration PRs is described in
[`dev-database-copy.md`](./dev-database-copy.md).

Backups use a direct or session connection. `dump-db-backup.sh` switches hosted
Supavisor URLs from transaction port 6543 to session port 5432 for every dump. This keeps backup session settings out of the
application's transaction pool; direct and local URLs are preserved.

## Safety checks

- **Verified before upload.** `verify-db-backup.ts` rejects a missing or empty
  file, a dump cut off inside a table, and a backup without `User` or `Site`
  rows or without energy history (day records with their summaries; raw
  `EnergyData` in a backup from before 2026-10-27). A failed
  `supabase db dump` can leave an empty file behind; it fails here instead of
  being stored.
- **Old backups go only after a new one lands.** Retention runs after a verified
  upload, and `db-backup-retention.ts` also refuses to delete anything unless the
  folder's newest backup is under 6 hours old.
- **Restores only into an empty database.** `restore-db-backup.sh` refuses any
  target with tables in its `public` schema, so it cannot overwrite production or
  dev. It loads everything in one transaction: a failure leaves the target empty.
- **Restores check what they are given.** Before touching the target, the restore
  runs the same verification on the backup. Each backup carries a `backup-info`
  file (kind and UTC time taken); backups from before it existed are accepted.

## Restoring

1. **Pick the backup.** The newest one of any kind (usually the newest daily).

   ```bash
   export BLOB_READ_WRITE_TOKEN=<BACKUP_BLOB_READ_WRITE_TOKEN value>
   vercel blob list --prefix db-backup/daily/
   vercel blob get db-backup/daily/<file>.zip --access private -o backup.zip
   ```

   The backups contain user data and Tesla tokens. Keep the files private and
   delete local copies when done.

2. **Create an empty database.** For a real recovery, a new Supabase project. For a
   rehearsal, a local Postgres; it needs Supabase's roles first (see below).

3. **Restore.**

   ```bash
   cd cmd/next-app
   bash scripts/restore-db-backup.sh --target "<new database URL>" --backup backup.zip
   ```

   Days after the backup was taken are not in it; the app refetches them from
   Tesla (gap-heal and the importer plan missing days).

   A backup from before 2026-10-27 has raw `EnergyData`; restore it with the
   version of this script from that time (`git show <commit>:cmd/next-app/scripts/restore-db-backup.sh`).

4. **Re-create what the backups do not contain.** Backups cover the `public`
   schema only. A new project also needs:
   - the extensions the app uses (`pg_cron`, `pg_net`) and the Vault secrets and
     cron jobs set up by the cron-trigger migrations in `db-migrations/`;
   - migration history, so CI does not re-run applied migrations;
   - Vercel's `DATABASE_URL` pointed at the new project.

### Local rehearsal

A plain Postgres cannot take these backups: `schema.sql` installs Supabase
extensions (`supabase_vault`, `pg_graphql`, `pg_net`, `pg_cron`, `index_advisor`,
`hypopg` and others) and `roles.sql` adjusts Supabase's own roles. Rehearse
against Supabase's Postgres image instead, which the Supabase CLI already pulls:

```bash
docker run -d --name pwusage-restore-rehearsal -p 127.0.0.1:55443:5432 \
  -e POSTGRES_PASSWORD=rehearsal public.ecr.aws/supabase/postgres:17.11.0.004
bash scripts/restore-db-backup.sh --target "postgresql://postgres:rehearsal@127.0.0.1:55443/postgres" \
  --backup backup.zip
docker rm -f pwusage-restore-rehearsal   # the restored data includes Tesla tokens
```

As on Supabase, `postgres` is not a superuser there; the restore's paused-trigger
load still works.

`npm run test:backup:postgres` covers the restore script's logic against a
disposable plain Postgres, in CI and locally (set `DB_BACKUP_PG_BIN` to the
Postgres `bin` directory if `pg_config` is not on `PATH`).

### Rehearsal record

**2026-10-15**, from the dev database (a copy of production): a full and a daily
backup, both passing `verify-db-backup.ts`, restored together into the Supabase
image in 9 seconds. All 15 tables matched the backups' row counts (75 users,
77 sites, 911,671 `EnergyData` rows), and all 12,820 recent readings were
identical to the daily backup's. The dumps were taken with the host's `pg_dump`
plus the CLI's `roles.sql` and `schema.sql`, because this machine's network kept
dropping the CLI's container connections; CI's own pre-migration dumps on
2026-10-08 and 2026-10-14 succeeded. The first scheduled runs are still the first
end-to-end test against Supabase itself; `verify-db-backup.ts` fails them loudly
if anything is off.

**2026-10-15, CLI check.** `dump-db-backup.sh` ran end to end (Supabase CLI
2.120, daily and weekly) against a seeded local Supabase Postgres container. The
check caught a real bug: the CLI parses `-x` as a CSV list and rejected the
quoted `-x 'public."EnergyData"'` outright, so every daily backup would have
failed. Unquoted, `-x public.EnergyData` excludes the table's data and keeps its
sequence. Real CLI dumps also contain Supabase's `auth.*` tables; restoring a
weekly plus a newer daily into a fresh container worked, the next `EnergyData`
insert got an id past every restored row, and an older daily was refused.
