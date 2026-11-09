# Next.js web app (`cmd/next-app`)

The web app: App Router pages and API routes under `cmd/next-app/src`, PostgreSQL through `pg`,
and the Tesla Fleet API and TRMNL integrations. Repo-wide conventions live in the root
[`AGENTS.md`](../../AGENTS.md); auth is documented once in [`Authentication.md`](../../Authentication.md).

## Tech stack

- **Framework**: Next.js 15+ (App Router)
- **Language**: TypeScript — **strictly avoid `any`**; define an interface or type for every
  variable and function parameter.
- **Styling**: Tailwind CSS
- **Database**: PostgreSQL through the `pg` driver/pool
- **Testing**: Vitest (`npm test`)

## Architecture patterns

- **Repository pattern**: data access in `src/lib/*-repo.ts` (for example `EnergyRepo`).
- **Service pattern**: business logic in `src/lib/*-service.ts` (for example `SiteService`).
- **Authorization**: see [`Authentication.md`](../../Authentication.md) for the route-level rules.
- **Load-bearing decisions**: [`DesignDecisions.md`](../../DesignDecisions.md) — read the relevant
  section before "simplifying" the Tesla claim pattern, append-only tariff versioning, the loose
  TRMNL pending flow or the battery provenance model.

## Quick start

Prerequisites: Node.js 24+, plus PostgreSQL (production) or SQLite (local development).

```bash
cd cmd/next-app
npm install
cp example.env .env      # DATABASE_URL and Tesla API credentials
./create-db.sh           # optional: creates pwusage.db with the schema
export DATABASE_URL="file:pwusage.db"
```

## Commands

```bash
cd cmd/next-app
npm run dev        # dev server on http://localhost:5173
npm run dev:agent  # port 5174; the user usually keeps 5173
npm run lint       # ESLint
npm run typecheck  # tsc --noEmit (faster than a full build)
npm test -- --run  # Vitest, one shot (add file paths to narrow it)
npm run build      # production build and full type check
npm start          # run the production build locally
npm run test:fleet # integration tests against the Tesla Fleet API
```

`npm test` on its own starts Vitest in watch mode and never exits; always add `--run` when you
need a command that finishes.

## Verification (before finishing)

Run these from `cmd/next-app`, in this order; fix anything that fails:

```bash
npm run lint
npm run typecheck
npm test -- --run
npm run build
```

`npm run build` is the authoritative type check and must pass before you report a task complete.
`npm run typecheck` is the fast loop while editing; it is not a substitute for the build.

## Conventions

- **Files**: kebab-case.
- **Components**: functional components in `src/components`.
- **Scripts**: standalone maintenance scripts in `scripts/`, run with
  `npx tsx scripts/script-name.ts`. They must load `.env` explicitly (for example with `dotenv`) at
  the very start so CLI runs get real configuration.
- **Cron jobs**: handlers live under `src/app/api/cron/*`. Most schedules (for example the
  15-minute battery-hold restore, Live Activity delivery, history archive and gap healing) are
  Supabase `pg_cron` + `pg_net` jobs created by migrations in `db-migrations/` (search for
  `cron.schedule`). `vercel.json` holds only the daily `check-users` cron: the Vercel Hobby plan
  allows daily crons at most, so anything more frequent must be a `pg_cron` job.
- **User-facing copy**: follow [`docs/voice-and-terms.md`](../../docs/voice-and-terms.md).

## Key data models

Tables use PascalCase quoted identifiers.

- `User` — accounts with Tesla refresh tokens, auth status and regional Fleet API host
  (`fleet_api_base_url`, allowlisted in `src/lib/tesla-region.ts`; NULL = North America).
- `Site` — energy sites (Powerwalls) owned by a `User`.
- `Tariff` — billing rate plans per site, append-only versioned: each save inserts a new row
  (`version` + `is_current`, deduped by `content_hash`) instead of replacing, and only one row per
  `(site_id, name)` has `is_current = true`. See [`DesignDecisions.md`](../../DesignDecisions.md).
- `TariffSeason` — seasonal ranges within a tariff (`from_month`/`from_day` → `to_month`/`to_day`)
  with buy/sell rates.
- `TariffSchedule` — TOU period definitions within a season (day-of-week plus hour/minute windows)
  with buy/sell rates.
- `EnergyDayArchive` — one compact record per `(site_id, day_start)` (site-local midnight) and the
  only energy history: the day's 5-minute Tesla samples (`load_power, solar_power, grid_power,
  battery_power, battery_soc`) as a compressed payload, a tariff segment timeline (`attribution`),
  `status` (`open`/`complete`/`gapped`/`empty`) and `fetched_at`. Each fetch replaces the record;
  only a newer fetch wins. See
  [`docs/plans/2026-10-24-day-record-v2.md`](../../docs/plans/2026-10-24-day-record-v2.md).
- `EnergyDaySummary` — per-day billing totals by tariff period, derived from a record's samples and
  segments.
- `TrmnlInstallation` — TRMNL device configs (UUID, linked `site_id`, access token).
- `AppSettings` — key/value app config.

TOU periods are assigned when a day record is written, from the site's current tariff
(`Schedule.getTariffPeriod`, walking the `TariffSeason → TariffSchedule` chain), and stored in the
record's segment timeline.

## Database and migrations

- SQL migrations live in `cmd/next-app/db-migrations/`.
- **Never create a migration file by hand** — timestamps and ordering collide. Use the generator,
  which also prepends the RLS boilerplate:

  ```bash
  # from cmd/next-app
  npm run db:migration:create <migration_name>
  ```

- Apply locally with `supabase migration up --db-url "postgresql://user:pass@localhost/pwusage"`.
  It wraps the file in a transaction, so `CONCURRENTLY` cannot be used.
- Migrations must be idempotent (safe to run twice).
- PRs: migrations are tested against a fresh production copy dumped into the Dev DB (only a recent
  slice of day records is copied). On merge to `main`: production is backed up to Vercel Blob, then
  migrations run. Either path can invalidate TRMNL devices in the dev database.
- The dev copy is guarded by a positive dev marker, scrubbed in the restore transaction and pruned
  after migrations. See [`docs/dev-database-copy.md`](../../docs/dev-database-copy.md).
- **Row Level Security**: every new table must enable RLS, revoke `PUBLIC`/`anon`/`authenticated`,
  and grant everything to `service_role`:

  ```sql
  ALTER TABLE "MyNewTable" ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON "MyNewTable" FROM PUBLIC;
  REVOKE ALL ON "MyNewTable" FROM anon;
  REVOKE ALL ON "MyNewTable" FROM authenticated;
  GRANT ALL ON "MyNewTable" TO service_role;
  -- serial/BIGSERIAL sequences, too:
  GRANT ALL ON SEQUENCE "MyNewTable_id_seq" TO service_role;
  ```

## Deployment and environment

- Production: `pwusage.fm.rodeo` (from `main`). Staging: `pwusagebeta.fm.rodeo` (PR preview).
- Database: production is Supabase PostgreSQL (Free plan: no automatic backups, 5 GB/month egress).
  Dev is PostgreSQL from a production copy, or local SQLite. Private Vercel Blob backups run daily
  (kept 14 days plus one per week for 8 weeks) and before every migration; see
  [`docs/database-backups.md`](../../docs/database-backups.md).
- Environment variables (full list in `cmd/next-app/example.env`):
  - Required: `DATABASE_URL` (PostgreSQL URL, or `file:pwusage.db` for SQLite) and
    `NEXT_PUBLIC_APP_URL` (public app URL, for example `https://pwusage.fm.rodeo`).
  - Tesla OAuth: `TESLA_CLIENT_ID`, `TESLA_CLIENT_SECRET`.
  - Tesla token encryption at rest: `TOKEN_ENCRYPTION_KEYS` (`keyId:base64`, comma-separated,
    first is active) and `TOKEN_FINGERPRINT_KEY` (32-byte base64). Required wherever tokens are
    written; see [`Authentication.md`](../../Authentication.md).
  - TRMNL: `TRMNL_CLIENT_ID`, `TRMNL_CLIENT_SECRET`, `TRMNL_API_URL`.
  - Battery-hold Live Activities (APNs, optional): `APNS_KEY_ID`, `APNS_TEAM_ID`,
    `APNS_PRIVATE_KEY` (the `.p8` PEM) and optional `APNS_BUNDLE_ID`. Unset means the delivery cron
    is a no-op. Production APNs is used only when `VERCEL_ENV=production`; previews send sandbox
    pushes only. See
    [`docs/battery-hold-live-activity-delivery.md`](../../docs/battery-hold-live-activity-delivery.md).

## Authentication quick reference

- **Session**: `site_auth` HTTP-only JWT cookie (user id plus authorized site ids).
- **Authorization**: `verifySiteAccess(siteId)` checks that the user owns the site.
- **Tesla tokens**: stored encrypted on `User` (`src/lib/token-crypto.ts`; reads decrypt, writes
  encrypt, refresh compare-and-swap uses `refresh_token_fp`), refreshed automatically on a 401.
- **TRMNL**: bearer token in `TrmnlInstallation.access_token`.
- Details: [`Authentication.md`](../../Authentication.md).

## TRMNL + Tesla constraints

- **Poll cadence**: assume TRMNL devices poll at most once every 15 minutes.
- **Cost control**: the Tesla Energy API calls this app makes are not billed today; the binding
  limits are the Supabase database quota (500 MB shared by Prod and Dev) and its egress. Keep
  caching energy data anyway, and never fetch live or history data per request when it is not
  needed.
- **Energy history resolution**: Tesla history is 5-minute samples and is easiest to retrieve by
  day; requests for less than a day behave oddly.
- **Markup** (`/api/trmnl/markup`, `src/lib/trmnl-renderer.ts`):
  - Prefer [TRMNL Framework v2](https://trmnl.com/framework/docs/) markup/classes/utilities for
    layout, spacing, typography and tables. Avoid custom inline layout/typography CSS when a
    Framework v2 primitive exists; use custom inline styles only when there is no primitive. Keep
    markup under 500 KB.
  - Serve markup from cached DB data as the blocking source of truth; run Tesla refreshes in the
    background with per-site throttling aligned to the poll cadence.
  - Prefer stale-while-refresh; never block the response on the Tesla API.
  - Never present battery SoC as fresh when it is stale; show unknown (`--`) when it is too old.
  - Include freshness/debug headers (for example data/SOC age) when adjusting route behaviour.

## Agent dev environment

- The user usually runs `npm run dev` on port 5173; use `npm run dev:agent` (port 5174) for agent
  work.
- Next.js locks `.next/`, so only one `next dev` can run per directory. To test without stopping
  the user's server, either stop it briefly or run `npm run build && next start -p 5174`.

## Troubleshooting

- **Tesla API 401**: the refresh token expired and the user must re-authenticate via `/login`.
  Check `User.auth_status` for "revoked" or error details.
- **TRMNL device not rendering**: verify the `TrmnlInstallation` row (UUID and token), check
  `/api/trmnl/markup` returns 200, and allow up to 15 minutes for the next poll.
- **Multiple dev servers fail**: see "Agent dev environment" above.
