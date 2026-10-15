# Dev Database Copy

On pull requests that change migrations, CI's **Verify Migrations (Prod -> Dev)**
job (`verify-db` in `.github/workflows/ci.yml`) overwrites the dev database with a
copy of production, runs the new migrations on it, then scrubs and shrinks it. The
beta site (pwusagebeta.fm.rodeo) and the dev pg_cron jobs run against that copy.

## What the job does

1. **Checks the secrets** (`scripts/check-dev-database-url.sh`). It stops before any
   SQL when `DEV_DATABASE_URL` and `DATABASE_URL` point at the same Supabase
   project, or when either is missing or the dev project cannot be identified. It
   never prints either URL.
2. **Dumps production** with `supabase db dump` (schema, data, migration history).
3. **Restores to dev.** The first command is the dev guard
   (`scripts/assert-dev-database.sql`); only then does it drop and recreate the
   `public` schema and load the schema. Data is loaded and scrubbed in one
   transaction that stops on the first error:
   `psql --single-transaction -v ON_ERROR_STOP=1 -f data.sql -f scripts/sanitize-dev-copy.sql`.
   Beta and the dev pg_cron jobs never see unscrubbed rows, and a failed load
   leaves the data tables empty instead of half-loaded.
4. **Runs migrations on dev**, against full prod-sized data.
5. **Prunes the copy** (`scripts/prune-dev-copy.sql`): deletes `EnergyData` older
   than 45 days, then `VACUUM FULL "EnergyData"` returns the space. Deleting raw
   rows also drops any compact `EnergyDayArchive` days covering them (the
   `invalidate_compact_energy_day` trigger), as it would for any raw deletion.

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
  with the marker. CI runs it in the **Run Tests** job.
- `scripts/dev-copy-guards.test.ts` (part of `npm test`) checks that no migration
  mentions the marker, that no job other than `verify-db` references the dev-only
  scripts, that the guard runs before the `DROP SCHEMA`, that the secret check
  runs before any database step, that prune runs after the migrations, and the
  project-ref check itself.
