# Dev Database Copy

On pull requests that change migrations, CI's **Verify Migrations (Prod -> Dev)**
job (`verify-db` in `.github/workflows/ci.yml`) overwrites the dev database with a
copy of production, runs the new migrations on it, and scrubs it. The beta site
(pwusagebeta.fm.rodeo) and the dev pg_cron jobs run against that copy.

Every table is copied in full except `EnergyData`, which is cut down to a slice
on the prod side (see step 2) so that its history is never downloaded. Full
`EnergyData` dumps were the largest use of production's 5 GB/month Free-plan
egress, since a full copy was downloaded only for most of it to be deleted.

## What the job does

1. **Checks the secrets** (`scripts/check-dev-database-url.sh`). It stops before any
   SQL when `DEV_DATABASE_URL` and `DATABASE_URL` point at the same Supabase
   project, or when either is missing or the dev project cannot be identified. It
   never prints either URL.
2. **Dumps production** with `supabase db dump` (schema, data, migration history).
   The data dump explicitly selects `--schema public`: only application tables
   are copied. Supabase-managed `auth` and `storage` tables stay untouched;
   protected tables such as `storage.buckets_vectors` cannot be restored by
   `postgres`. Migration history is dumped separately from `supabase_migrations`.
   The data dump skips `EnergyData` rows (`-x public.EnergyData`; its sequence is
   kept). Just before it, `scripts/export-dev-energy-data.sql`, which is
   read-only, writes `dev-energy-data.csv` with just the rows dev keeps. The two
   cannot share a snapshot, so the export goes first: every `Site` and `Tariff`
   a row references then already exists when `data.sql` is taken. The rows kept are the last 45 days for the
   5 sites with the most recent live status refresh, plus Harrison (the site used
   for live tests). Measured 2026-10-19: about 63k rows (4.4 MB) instead of 1.19M
   rows (about 87 MB).
3. **Restores to dev.** The first command is the dev guard
   (`scripts/assert-dev-database.sql`); only then does it drop and recreate the
   `public` schema and load the schema. Data is loaded and scrubbed in one
   transaction that stops on the first error:
   `psql --single-transaction -v ON_ERROR_STOP=1 -f data.sql -f scripts/load-dev-energy-data.sql -f scripts/sanitize-dev-copy.sql < dev-energy-data.csv`.
   Beta and the dev pg_cron jobs never see unscrubbed rows, and a failed load
   leaves the data tables empty instead of half-loaded.
   `load-dev-energy-data.sql` loads the `EnergyData` slice from stdin with
   triggers paused, as the dump's own load does, and refuses a CSV whose columns
   differ from the table (`HEADER MATCH`). Because paused triggers also skip
   foreign-key checks, it applies `EnergyData`'s own `ON DELETE` actions by hand
   to rows whose `Site`, `Tariff` or `TariffSchedule` was deleted on prod between
   the export and the dump. It then:
   - drops the `EnergyDayArchive` days (and, by cascade, their `EnergyDaySummary`
     rows) whose raw rows were not copied or changed in that gap, as the `invalidate_compact_energy_day`
     trigger does when raw rows are deleted. Otherwise a later write to such a
     day would fail with "Raw archive source incomplete". Archive-only days
     (`raw_pruned`) have no raw rows to copy and stay;
   - sets `Site.last_live_refresh_at` to 0 for sites left without readings, so
     beta's live-site crons (heal-gaps) do not re-import their history from
     Tesla.
4. **Runs migrations on dev**. Every table except `EnergyData` is at full prod
   size; `EnergyData` holds only the slice. A migration that rewrites or
   re-indexes `EnergyData` is therefore not timed against prod's row count
   here. Check such migrations against prod's size separately.
5. **Prunes the copy** (`scripts/prune-dev-copy.sql`): deletes `EnergyData` older
   than 45 days, then `VACUUM FULL "EnergyData"`. The slice already covers only
   45 days, so this is a safety net. A test checks that the export and the prune
   use the same interval.

## What the scrub changes

`scripts/sanitize-dev-copy.sql` is idempotent and skips each rule while its table
does not exist.

| Table | Rule | Why |
|---|---|---|
| `MobileLoginHandoff` | All rows deleted | Short-lived one-time login codes |
| `TrmnlInstallation` | `refresh_token` set to NULL | Stored but never used by the app |
| `BatteryHoldActivity` | All rows deleted | Live Activity push tokens; beta must never push to copied prod registrations |

Kept on purpose: `TrmnlInstallation.access_token` (inbound-only), `User` Tesla
tokens and emails. Beta's cron jobs rely on the Tesla tokens.

When a table holds new secrets, add its rule to `sanitize-dev-copy.sql` in the
same PR that creates the table.

## The dev marker

Every dev-only script starts with `assert-dev-database.sql`, which refuses to run
unless the database has the row `pwusage_env.environment = 'dev'`. It fails
closed: a missing schema, an empty table or any other value stops psql before the
next statement. The marker is created once, by hand, on the dev project. It is
never created by a migration (a test checks no migration mentions `pwusage_env`),
so migrations can never mark production as dev. It survives every copy because
the restore drops only the `public` schema.

If the dev project is ever recreated, connect to it (never production) and run:

```sql
CREATE SCHEMA pwusage_env; CREATE TABLE pwusage_env.environment (name text PRIMARY KEY); INSERT INTO pwusage_env.environment VALUES ('dev');
```

Until then, the verify-db job fails at the guard and dev is left untouched.

## Tests

- `npm run test:dev-copy:postgres` runs `scripts/dev-copy-scripts.test.ts` against
  a disposable local PostgreSQL: the guard refuses without the marker and changes
  nothing, it stops a following file, and sanitize and prune do the right thing
  with the marker. It also covers which rows the export picks, and how the load
  handles the archive, idle sites, paused triggers and a column mismatch. CI runs
  it in the **Run Tests** job.
- `scripts/dev-copy-guards.test.ts` (part of `npm test`) checks that no migration
  mentions the marker, that no job other than `verify-db` references the dev-only
  scripts, that the guard runs before the `DROP SCHEMA`, that the secret check
  runs before any database step, that prune runs after the migrations, that the
  data dump excludes `EnergyData` and the export stays read-only and unguarded
  (it runs against prod), and the project-ref check itself.
