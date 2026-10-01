# Powerwall Usage 

This application helps you track your Powerwall usage and monitor your energy production and consumption. The main goal is for users who have time of use (TOU) rates and want to optimize their energy usage. 

## Configuration

Create a `.env` file in the root directory (or use `env_file` in Docker) with the following variables:

### Required
- `DATABASE_URL`: Connection string for the PostgreSQL database (Supabase recommended). 
    - **Important**: Use the **Transaction Pooler (IPv4)** connection string on port `6543` to avoid connection limits and ensure IPv4 compatibility in Docker.
    - Format: `postgres://[user]:[password]@aws-0-[region].pooler.supabase.com:6543/[dbname]?sslmode=require`
    - Make sure to explicitly provide the password (do not use the placeholder).
- `DATABASE_SSL_CA` (Optional): Raw SSL CA certificate content (PEM format) to enable secure CA cert pinning.
- `DATABASE_SSL_CA_FILE` (Optional): Path to the SSL CA certificate file to use for verification. Alternatively, you can place your CA certificate at `certs/supabase-ca.crt` (or `certs/prod-ca-2021.crt`) in the application root directory.
- `NEXT_PUBLIC_APP_URL`: The base URL of your application. Used for API calls and OAuth redirects. Example: `http://localhost:3000`
- `PUBLIC_TESLA_OAUTH_CLIENT_ID`: Your Tesla Fleet API Client ID.
- `TESLA_OAUTH_SECRET`: Your Tesla Fleet API Client Secret.
- `PUBLIC_TESLA_OAUTH_AUDIENCE`: The Tesla API audience. Example: `https://fleet-api.prd.na.vn.cloud.tesla.com`
- `AUTH_SECRET`: A strong, random string used to sign session tokens. **Crucial for security and session persistence across deployments.**

### Optional / Integrations
- `DISCORD_ANNOUNCEMENTS_WEBHOOK_URL`: Discord webhook URL for sending system announcements.
- `TRMNL_CLIENT_ID`: Client ID for Trmnl integration.
- `TRMNL_CLIENT_SECRET`: Client Secret for Trmnl integration.
- `JWT_EXPIRY_DAYS`: Session duration in days (default: `7`).
- `JWT_REFRESH_THRESHOLD_HOURS`: Refresh token if expiration is within this many hours (default: `24`).
- `CRON_SECRET`: Secret key used to authorize Vercel Cron Job requests.
- `HISTORY_RETENTION_POLICY_START_AT`: Explicit zoned ISO timestamp when the 90-day policy is announced and disclosed to new accounts. Until this is set and reached, newly authenticated accounts remain transition-pending with 365-day access. Login does not change an existing account’s entitlement.
- `RETENTION_CLEANUP_ENABLED`: Set to exactly `true` only after migration, notice delivery, existing-account grace bootstrap, recoverable backup, and preview approval. Defaults to disabled. `DATA_RETENTION_DAYS` is no longer used.
- `SPARKLINE_SCALE_WINDOW_HOURS`: Header sparkline y-axis clamp window in hours (default: `12`, minimum effective value: `4`).

### Deployment & CI (GitHub Actions Secrets)
These variables are set as Secrets in your GitHub repository for automated deployments, backups, and migrations:
- `DATABASE_URL`: The production database connection string. Used for running production migrations and creating pre-migration backups.
- `DEV_DATABASE_URL`: Connection string for the preview/staging database (used for migration verification on PRs).
- `CRON_SECRET`: Secret key used to authorize sub-daily cron triggers. The migration job replaces the `{{CRON_SECRET}}` placeholder in SQL migration files with this secret at deploy time.
- `BLOB_READ_WRITE_TOKEN`: Vercel Blob token used for uploading daily/pre-migration database backups.
- `VERCEL_TOKEN`: Vercel Personal Access Token for CLI-based deployments.
- `VERCEL_ORG_ID`: Your Vercel Organization/Team ID.
- `VERCEL_PROJECT_ID`: Your Vercel Project ID.
- `DISCORD_WEBHOOK`: Discord Webhook URL for Build/Deploy status notifications.

## Cron Jobs

The application uses [Vercel Cron Jobs](https://vercel.com/docs/cron-jobs) for background maintenance. These are configured in `vercel.json`:

- **User Status Check** (`/api/cron/check-users`): Runs daily at 08:00 UTC. Verifies Tesla Fleet API credentials for all users to ensure tokens are valid and active. Updates `last_checked_at` and `auth_status`.
- **Data Cleanup** (`/api/cron/cleanup`): Runs daily at 09:00 UTC. When explicitly activated, removes expired `EnergyData` and `LoadTag` in bounded batches using each account’s 90/365-day policy and grace. Pending transitions block deletion. All tariff versions remain permanent.

## Getting Started

First, run the development server:

```bash
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) with your browser to see the result. We also use ngrok to expose the application to the internet for testing purposes. You can find the ngrok URL in the terminal output.

```bash 
ngrok http 5173
```


### Internal history retention controls

The entitlement migration and internal maintenance tool support a 90-day default,
manually granted 365-day history, and a 30-day grace after removing extended history.
Imports, coverage audits, and the shared energy writer now enforce this policy after the migration is installed.
Cleanup is disabled by default and requires explicit rollout activation. Each run is limited to 50 site batches of at most 1,000 energy rows and 1,000 tags each, with a 35-second execution budget. Larger backlogs receive priority; remaining work resumes on later runs.
All tariff versions, seasons, and schedules must remain permanent.

The migration marks existing accounts `history_retention_transition_pending=true`;
they keep an effective 365-day window until their notice/grace is initialized.
The schema defaults to 90 configured days and pending=true, protecting old-code
signups between migration and deployment. The authentication upsert marks pre-announcement
new accounts pending too; post-announcement accounts start at 90 days without grace.
Installing the migration never deletes history. Apply the migration before using these controls.

Run from `cmd/next-app` in the implementation worktree, with `DATABASE_URL` explicitly
pointing to the requested environment. The tool loads `.env` first and refuses a
mismatched database target. `--env` validates the target; it does not select a URL.

```bash
npx tsx scripts/set-history-retention.ts --env dev --user <account-id> --days 365
npx tsx scripts/set-history-retention.ts --env dev --user <account-id> --days 365 --apply
npx tsx scripts/set-history-retention.ts --env dev --cohort <cohort.json> --notice-at <ISO-instant>
```

Commands preview by default. The cohort file is an explicit JSON array of existing
account IDs. After actual notice delivery, apply bootstrap with `--apply --notice-delivered`.
The recorded notice timestamp must already have occurred. Bootstrap preserves 365-day
exceptions and later grace, excludes post-announcement new accounts, and does not extend grace on reruns.
The tool sends no notices and deletes no data. Each account update is transactional;
a multi-account run may partially complete on an operational failure and is safe to retry.


Read-only capacity preview (after installing the migration):

```bash
npx tsx scripts/audit-history-retention.ts --env dev
npx tsx scripts/audit-history-retention.ts --env prod --as-of <ISO-instant>
```

The audit runs in a database read-only transaction and reports per-site entitlements,
grace, cutoffs, eligible counts, skipped ownership, and approximate retained allocation.
An `--as-of` preview does not change any account or advance its grace deadline.
Deleting rows alone need not shrink allocated files; compaction is a separate operation.

Rollback-only dev validation:

```bash
npx tsx scripts/verify-history-retention.ts --env dev
# Exact migration against an unmigrated dev/local schema, always rolled back:
npx tsx scripts/verify-history-retention-migration.ts --env dev
```

This exercises the actual preview, locked batch deletes, rollback, activation guard,
90/365-day and grace boundaries, and idempotence against temporary session tables.
It compares every fixture tariff/version/season/schedule and User/Site value before
and after, including unused tariffs. It refuses production targets and never modifies
public tables. Production-backup migration CI still validates the actual public schema.

Web history and bill queries use the same site-local boundary as imports. Expired
requests stop without Tesla calls; partial totals are explicitly labeled and exclude
expired samples. Navigation retains the oldest partial billing cycle. The native
bill endpoint serves only the current cycle (at most 31 days), so its response and
query counts remain unchanged. Site switching resets the web history state.

See [the rollout report](../../docs/plans/2026-10-01-history-retention-rollout.md)
for the production read-only snapshot, announcement draft, backup/restore rehearsal,
and separate cleanup activation steps. Count queries in activated cleanup have
remaining-budget statement/lock timeouts; final counts are skipped or timed out
conservatively as `workRemaining=true`.
