# Dev history reset and restore

Two Dev-only scripts for watching the iOS app load a site's history from scratch against the real server and Tesla. No Tesla backend is simulated. `dev-history-reset.sh` saves one site's energy history to a private snapshot and deletes it. `dev-history-restore.sh` puts it back.

Both refuse any database without the positive dev marker (`assert-dev-database.sql`). A hostname or environment variable is never treated as proof of Dev. Each runs as one transaction, so a refusal or a failure changes nothing.

## What they touch

The reset deletes only the chosen site's `EnergyDayArchive` rows. Its `EnergyDaySummary` rows go with them by cascade.

The `Site` row, the owner's credentials, rate plans and every other site stay. So does the server's solar layout state, which no longer exists on the server. The snapshot also records the site's `history_backfill_from` and `history_migrated_at`, and a `--replace` restore puts `history_backfill_from` back.

## Reset

```bash
scripts/dev-history-reset.sh --database-url "$DEV_DATABASE_URL" \
  --site 2252268092126997 --expect-name "Harrison" \
  --snapshot ~/pwusage-snapshots/harrison-$(date +%Y%m%d-%H%M%S)
```

The reset refuses when:
- the site doesn't exist or its name differs from `--expect-name`;
- an import holds the site's lock;
- the snapshot path already exists, or git would track it (keep snapshots outside the repository or in an ignored path).

It holds the site row and write-locks the two day tables while it works, so imports and gap healing wait instead of racing it. It writes `archive.csv`, `summary.csv` and `manifest.json`, then reloads the files inside the transaction and proves they match the rows exactly before deleting anything.

The manifest records:
- the Supabase project ref, database name and server version;
- the newest migration and a signature of the day tables' columns;
- row counts and the first and last day;
- row digests of the archive and summary.

The directory is `700` and the files `600`.

## Restore

```bash
scripts/dev-history-restore.sh --database-url "$DEV_DATABASE_URL" \
  --site 2252268092126997 --snapshot ~/pwusage-snapshots/harrison-…
```

The restore refuses a snapshot for another site, project or database, or one taken when the day tables had different columns. It also refuses any file that is missing or no longer matches the manifest's counts and digests. It then compares the site's current records with the snapshot by day.

If the test imported history since the reset, the restore refuses unless you choose what happens to it:

| Option | Effect |
|---|---|
| `--preview` | Prints snapshot, current, overlapping, identical, current-only and snapshot-only day counts. Changes nothing. |
| `--replace` | Deletes the site's current records and restores the snapshot exactly, verified by digest. |
| `--keep-newer` | Keeps every current record and restores only the days that are missing, each with its summaries. |

After restoring, it checks that every snapshot day is present, and for an exact restore, that the rows match the snapshot's digests.

A future PR's Prod → Dev copy also refreshes Dev, but don't rely on it to restore: it keeps only 45 days.

## Real-device test

1. Deploy this branch's server to Beta. Then point a Debug build at Beta by setting `PWUSAGE_DEBUG_API_ORIGIN` in `cmd/ios-app/project.yml` to `https://pwusagebeta.fm.rodeo` and running `./generate.sh`. Debug builds default to Prod.
2. Confirm the site ID and name in the Beta admin view, then run the reset for that site only.
3. Confirm the site's coverage is empty. Gap healing may refill recent days quickly for a live site.
4. In the app (Debug build), open Settings › Solar System:
   - **Ignore Existing Layout:** turn on to make a site that already has a layout run the full search.
   - **Reset History on This Device:** forgets the phone's loading progress and stored history for the selected site. The server's history and the solar layout record are left alone, so nothing synced through iCloud changes.
5. Watch the import. Background the app and return to see it resume, and relaunch to see the saved position kept. In Console (subsystem `fm.rodeo.pwusage`, category `solar-layout`), each "Clear-day pass" line gives the pass's duration; it runs every second slice (six days).
6. Run the restore, with `--preview` first, then `--replace` or `--keep-newer`. Check the reported counts.

The tests run both scripts against a disposable local PostgreSQL (`npm run test:dev-history:postgres`, also in CI). They cover refusal on a database without the marker, the wrong site, a held lock, an existing snapshot, missing or changed files, another project and a changed schema. They also cover conflicts, and a restore that fails partway and leaves the database as it was.
