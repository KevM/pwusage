# Powerwall Usage 

This application helps you track your Powerwall usage and monitor your energy production and consumption. The main goal is for users who have time of use (TOU) rates and want to optimize their energy usage. 

## Configuration

Create a `.env` file in the root directory (or use `env_file` in Docker) with the following variables:

### Required
- `DATABASE_URL`: Connection string for the PostgreSQL database (Supabase recommended). 
    - **Important**: Use the **Transaction Pooler (IPv4)** connection string on port `6543` to avoid connection limits and ensure IPv4 compatibility in Docker.
    - Format: `postgres://[user]:[password]@aws-0-[region].pooler.supabase.com:6543/[dbname]?sslmode=require`
    - Make sure to explicitly provide the password (do not use the placeholder).
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
- `DATA_RETENTION_DAYS`: Number of days of raw 5-minute `EnergyData` (and `LoadTag`) history to keep before the cleanup cron prunes older rows. **Default: `0` (keep forever).** Unset, empty, `0`, or any non-positive value all mean *keep all history indefinitely* — the cleanup cron skips deletion and the history backfill persists raw samples for every day instead of discarding pre-cutoff days. This is the current policy because the **Savings** feature re-buckets raw energy into arbitrary tariff TOU windows to compare plans (Fixed *and* TOU) across full history, which is only possible while the underlying 5-minute samples still exist. Set a positive integer (e.g. `365`) to re-enable finite pruning. A future flat-file archive is intended to replace "keep forever" — cold-storing old samples and re-hydrating them for savings calculations — at which point a finite live window can be reintroduced.
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
- **Data Cleanup** (`/api/cron/cleanup`): Runs daily at 09:00 UTC. Removes historical `EnergyData` and `LoadTag` records older than `DATA_RETENTION_DAYS` to manage database growth. When `DATA_RETENTION_DAYS` is `0`/unset (the default — keep forever), the job is a no-op and returns `{ retentionDisabled: true }`, preserving the full raw history the Savings comparisons depend on.

## Getting Started

First, run the development server:

```bash
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) with your browser to see the result. We also use ngrok to expose the application to the internet for testing purposes. You can find the ngrok URL in the terminal output.

```bash 
ngrok http 5173
```
