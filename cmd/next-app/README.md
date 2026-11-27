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
- `AUTH_SECRET`: A strong, random string used to sign session tokens. **Crucial for security and session persistence across deployments.**

### Optional / Integrations
- `DISCORD_ANNOUNCEMENTS_WEBHOOK_URL`: Discord webhook URL for sending system announcements.
- `TRMNL_CLIENT_ID`: Client ID for Trmnl integration.
- `TRMNL_CLIENT_SECRET`: Client Secret for Trmnl integration.
- `JWT_EXPIRY_DAYS`: Session duration in days (default: `7`).
- `JWT_REFRESH_THRESHOLD_HOURS`: Refresh token if expiration is within this many hours (default: `24`).
- `CRON_SECRET`: Secret key used to authorize Vercel Cron Job requests.
- `DATA_RETENTION_DAYS`: Number of days of raw energy data kept before it becomes eligible for archival (default: `365`). It controls archive/trim eligibility, not automatic deletion.
- `SPARKLINE_SCALE_WINDOW_HOURS`: Header sparkline y-axis clamp window in hours (default: `12`, minimum effective value: `4`).
- `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_PRIVATE_KEY`: Apple Push Notification service token-auth key (10-character Key ID, Team ID, and the full `.p8` PEM; `\n` escapes accepted) for battery hold Live Activity updates. `APNS_BUNDLE_ID` is optional (default `fm.rodeo.pwusage`). Without them the delivery cron does nothing. Production APNs is used only when `VERCEL_ENV=production`; Preview deployments send sandbox pushes only. Setup steps: [Live Activity delivery](../../docs/battery-hold-live-activity-delivery.md).

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

## Bill summary Wasm preview experiment

On a Vercel preview, open a home's **Estimated Bill** to price its rate buckets
with the Swift code from `PWUsageCore`. Add `billPricing=typescript` to the URL
for the control. Both paths use the same energy reads and bill display. The
preview retains canonical TypeScript prices if Wasm fails or the results differ.

Use runtime events `bill-pricing.wasm.initialized` for module read, compile and
instantiation time, and `bill-pricing.preview` for the selected engine, first use
in the instance, and per-request pricing time. Compare `page.completed` for
end-to-end page time with the same home and billing dates. Wasm's first use in
a process and a Vercel function cold start are distinct measurements.

CI builds the binary once with Swift 6.4.3 against `FoundationEssentials`,
optimizes it with `wasm-opt -Os`, gzips it as `wasm/bill-pricing.wasm.gz` (decompressed
in memory on cold start), and transfers it to the web test, build, and preview
jobs as a short-lived workflow artifact. On the Estimated Bill tab, the preview
starts warming Wasm concurrently with the page's database reads. The preview
upload includes the generated binary. To run the Wasm integration test locally,
install Swift 6.4.3 and its matching full Wasm SDK (and optionally Binaryen for
`wasm-opt`), then run `bash scripts/build-bill-pricing-wasm.sh` from this
directory.

## Integration Tokens

Create an integration token under **Site Settings → Connections** to read the
current bill from a script or another app. See [integration tokens](../../Authentication.md#integration-tokens)
for the endpoint, ETags, and data freshness.

## Remote MCP Server (OAuth 2.1)

Connect AI assistants to `POST /api/mcp` using OAuth 2.1 + PKCE (`S256`).
Discovery metadata is served at `/.well-known/oauth-protected-resource` and
`/.well-known/oauth-authorization-server`, with DCR (`POST /api/oauth/register`),
CIMD, consent (`/oauth/authorize`), token exchange/rotation (`POST /api/oauth/token`),
revocation (`POST /api/oauth/revoke`), and Site Settings management under
**Connections** (`/api/oauth/grants`), which also lists integration tokens. See
[Remote MCP Server & OAuth 2.1](../../Authentication.md#remote-mcp-server--oauth-21).

## Cron Jobs

The application uses [Vercel Cron Jobs](https://vercel.com/docs/cron-jobs) for background maintenance. These are configured in `vercel.json`:

- **User Status Check** (`/api/cron/check-users`): Runs daily at 08:00 UTC. Verifies Tesla Fleet API credentials for all users to ensure tokens are valid and active. Updates `last_checked_at` and `auth_status`.
- Energy history is compact day records written straight from Tesla (`CompactHistoryStore.writeDay`); there is no raw table, archive job or retention cron.

Sub-daily jobs run from Supabase `pg_cron` + `pg_net` (created by migrations, authorized with `CRON_SECRET`), not `vercel.json`:

- **Battery Saver** (`/api/cron/restore-reserve`): every 5 minutes, called only while a hold is active or a Live Activity needs work. Checks each hold, then sends Live Activity updates (a no-op until the `APNS_*` variables are set). See [Live Activity delivery](../../docs/battery-hold-live-activity-delivery.md).
- **Gap heal** (`/api/cron/heal-gaps`): every 2 hours at :37. Re-fetches missing history days for sites used in the last 7 days.
- **Tariff re-attribution** (`/api/cron/reattribute-tariffs`): every 5 minutes, called only while a re-attribution is pending or stalled.
- **Utility rate estimates** (`/api/cron/urdb-estimates`): every 10 minutes, called only while a site needs an estimate; at most five sites a run.
- **Run-history prune**: nightly at 03:41 UTC, deletes `cron.job_run_details` rows older than 7 days (SQL only, no route).

## Getting Started

First, run the development server:

```bash
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) with your browser to see the result. We also use ngrok to expose the application to the internet for testing purposes. You can find the ngrok URL in the terminal output.

```bash 
ngrok http 5173
```
