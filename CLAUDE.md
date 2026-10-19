# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository. For tech stack, architecture patterns, conventions, and security details, see [`Agents.md`](./Agents.md).

## Project Overview

**PWUsage** is a Tesla Powerwall energy monitoring and optimization web application designed to help homeowners maximize savings through Time-of-Use (ToU) rate optimization and battery management. The app monitors solar production, battery state, and grid imports/exports, providing data-driven recommendations to shift consumption to cheaper rate periods.

See [`GOALS.md`](./GOALS.md) for the energy optimization strategy and success metrics.

## Quick Setup

**Prerequisites:** Node.js 24+, PostgreSQL (production) or SQLite (local dev)

```bash
cd cmd/next-app
npm install
cp example.env .env  # Configure DATABASE_URL and Tesla API credentials
```

**Database Setup (Local):**
```bash
cd cmd/next-app
./create-db.sh  # Creates pwusage.db with schema
export DATABASE_URL="file:pwusage.db"
```

## Common Development Commands

```bash
cd cmd/next-app

npm run dev        # Start dev server on http://localhost:5173
npm run dev:agent  # Start on port 5174 (for agent development, user uses 5173)
npm run build      # Production build (must pass before finishing tasks)
npm run lint       # ESLint checks (must pass)
npm test           # Run Vitest suite
npm test -- --ui   # Open test UI in browser
npm run test:fleet # Integration tests against Tesla Fleet API
npm start          # Run production build locally
```

## Project File Structure

```
cmd/next-app/src/
├── app/
│   ├── api/
│   │   ├── trmnl/          # Trmnl plugin endpoints (setup, manage, markup, webhook, uninstall)
│   │   ├── cron/           # Vercel cron jobs
│   │   ├── site-live-data
│   │   └── ...
│   ├── site/[id]/          # Main site dashboard page
│   ├── admin/              # Admin panel
│   ├── auth/tesla-callback # Tesla OAuth callback
│   ├── login               # Tesla OAuth login entry
│   ├── logout              # Session logout
│   ├── trmnl/              # Trmnl plugin pages (install, manage)
│   ├── profile             # User profile
│   └── ...
├── components/
│   ├── site/               # Site dashboard components
│   ├── trmnl/              # Trmnl device markup rendering
│   ├── ui/                 # UI primitives
│   └── ...
├── lib/
│   ├── auth-checks.ts      # Authorization helpers (verifySiteAccess, etc.)
│   ├── auth-jwt.ts         # JWT token creation and validation
│   ├── tesla-client.ts     # Tesla Fleet API wrapper
│   ├── site-service.ts     # Site data aggregation and business logic
│   ├── energy-repo.ts      # Energy data queries
│   ├── trmnl-service.ts    # Trmnl integration (site linking, etc.)
│   ├── trmnl-auth.ts       # Trmnl JWT validation
│   ├── trmnl-renderer.ts   # Trmnl markup generation
│   └── ...
└── app.css                 # Global styles (Tailwind)

cmd/next-app/
├── db-migrations/          # SQL migration files (timestamp-prefixed)
├── supabase/               # Supabase config and migrations
├── scripts/                # Maintenance scripts (run via npx tsx)
├── public/                 # Static assets
└── vitest.config.mts
```

## Key Data Models

Tables (PascalCase quoted identifiers):
- `User`: User accounts with Tesla refresh tokens, auth status
- `Site`: Energy sites (Powerwalls) owned by users; references `User`
- `Tariff`: Billing rate plans per site. Append-only versioned: each save inserts a new row (`version` + `is_current`, deduped by `content_hash`) rather than replacing; only one row per `(site_id, name)` has `is_current = true`. See [`DesignDecisions.md`](./DesignDecisions.md).
- `TariffSeason`: Seasonal date ranges within a tariff (`from_month`/`from_day` → `to_month`/`to_day`) with buy/sell rates
- `TariffSchedule`: TOU period definitions within a season (day-of-week + hour/minute windows) with buy/sell rates
- `EnergyData`: 5-minute energy samples (`load_power, solar_power, grid_power, battery_power, battery_soc`) keyed by `(timestamp, site_id)` (the `tariff_id` column is retained for billing aggregation but is not part of the uniqueness key)
- `TrmnlInstallation`: Trmnl device configs (UUID, linked `site_id`, access token)
- `AppSettings`: Key/value app config

TOU period assignment for an `EnergyData` row is computed at read time by `Schedule.getTariffPeriod(timestamp)` walking the `TariffSeason → TariffSchedule` chain.

## Database Migrations

**Creating a Migration:**
```bash
cd cmd/next-app
# Create a new file in db-migrations/ with timestamp prefix
touch db-migrations/$(date +%Y%m%d_%H%M%S)_add_column.sql
```

**Running Migrations Locally:**
```bash
supabase migration up --db-url "postgresql://user:pass@localhost/pwusage"
```

**CI/CD Behavior:**
- On PR: Migrations are tested against a fresh copy of production dumped into the Dev DB (not a stored backup); `EnergyData` is copied only as a recent slice
- On merge to main: Database is backed up to Vercel Blob, then migrations run
- Migrations must be idempotent (safe to run multiple times)
- Note: This may invalidate Trmnl devices in dev database
- The dev copy is guarded by a positive dev marker, scrubbed in the restore transaction, and pruned after migrations. See [`docs/dev-database-copy.md`](./docs/dev-database-copy.md).

See [`Agents.md`](./Agents.md) for migration and deployment conventions.

## Authentication & Authorization

See [`Authentication.md`](./Authentication.md) for detailed OAuth flows and Trmnl integration.

**Quick Reference:**
- **Session Auth**: `site_auth` HTTP-only JWT cookie (user id + authorized site ids)
- **Authorization**: `verifySiteAccess(siteId)` checks if user owns site
- **Tesla Tokens**: Stored in `User` table, auto-refreshed on 401
- **Trmnl Auth**: Bearer token in `TrmnlInstallation.access_token`

## Performance & API Constraints

**Tesla Fleet API:**
- Calls are billable; cache energy data locally and avoid per-request fetches
- Energy history is 5-minute resolution, easiest to retrieve by day
- `/api/trmnl/markup` should be fast: serve cached DB data, refresh Tesla in background

**Trmnl Devices:**
- Poll at most every 15 minutes (assume eventual consistency)
- Markup should stay under 500KB
- Use TRMNL Framework v2 primitives; avoid custom CSS

See [`Agents.md`](./Agents.md) for TRMNL + Tesla API constraints.

## Testing

**Test Structure:**
- Test files co-located with code: `file.test.ts` next to `file.ts`
- Use Vitest for unit tests
- Fleet integration tests in `test:fleet` script

**Running Tests:**
```bash
npm test                    # Run all tests
npm test -- src/lib/auth   # Run specific file
npm test -- --ui           # Open test UI
```

## Deployment

**Vercel Deployment:**
- Production: pwusage.fm.rodeo (main branch)
- Staging: pwusagebeta.fm.rodeo (PR preview)
- Cron jobs configured in `vercel.json` run in `src/app/api/cron/*`

**Database:**
- Production: Supabase PostgreSQL (Free plan: no automatic backups, 5 GB/month egress)
- Dev: PostgreSQL (from backup) or local SQLite
- Private backups in Vercel Blob: daily (no EnergyData history), weekly full, and before migrations. See [`docs/database-backups.md`](./docs/database-backups.md) for retention and the restore runbook.

## Environment Variables

**Required:**
- `DATABASE_URL`: PostgreSQL connection string or `file:pwusage.db` for SQLite
- `NEXT_PUBLIC_APP_URL`: Public app URL (e.g., `https://pwusage.fm.rodeo`)

**Tesla OAuth (for local dev):**
- `TESLA_CLIENT_ID`
- `TESLA_CLIENT_SECRET`

**Trmnl Integration:**
- `TRMNL_CLIENT_ID`
- `TRMNL_CLIENT_SECRET`
- `TRMNL_API_URL`

**Battery hold Live Activities (APNs, optional):**
- `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_PRIVATE_KEY` (the `.p8` PEM), optional `APNS_BUNDLE_ID`
- Unset = the delivery cron is a no-op. Production APNs is used only when `VERCEL_ENV=production`; Preview sends sandbox pushes only. See [`docs/battery-hold-live-activity-delivery.md`](./docs/battery-hold-live-activity-delivery.md).

See `cmd/next-app/example.env` for full list.

## Common Troubleshooting

**"Cannot find module" errors:**
- Run `npm install` in `cmd/next-app`
- Clear `.next` cache: `rm -rf .next`

**Database connection fails:**
- Check `DATABASE_URL` syntax (PostgreSQL or `file:path/to/db.sqlite`)
- Verify database exists and is accessible

**Tesla API 401 (Unauthorized):**
- User's refresh token expired; they must re-authenticate via `/login`
- Check `User.auth_status` for "revoked" or error details

**Trmnl device not rendering:**
- Verify `TrmnlInstallation` row exists with correct UUID and token
- Check `/api/trmnl/markup` is returning 200
- Device may be cached; wait up to 15 minutes for next poll

**Multiple dev servers fail:**
- Next.js file lock in `.next/` prevents concurrent `npm run dev` instances
- Workaround: use `npm run build && next start -p 5174` for agent development
- See [`Agents.md`](./Agents.md) for agent dev environment guidance

**Build or lint failures:**
- Run `npm run lint` to check for code issues
- Run `npm run build` to verify production build
- Both must pass before finishing tasks

## Cross-Session Work

[`TODO.md`](./TODO.md) tracks deferred optimization work and other items that span multiple sessions. Check it when starting new work, and update it (or remove items) as work lands.

## Design Rationale (read before "simplifying")

[`DesignDecisions.md`](./DesignDecisions.md) records *why* several non-obvious,
load-bearing decisions were made — the cross-instance Tesla claim pattern,
append-only tariff versioning, the loose-pending TRMNL flow, and the
relative-flow battery provenance model (no SOC / no genesis seed). Read the
relevant section before refactoring any of those areas so a well-meaning cleanup
doesn't reintroduce a bug that was already paid for.

## Useful References

- [`DesignDecisions.md`](./DesignDecisions.md): Why load-bearing design decisions were made (read before refactoring those areas)
- [`docs/dev-database-copy.md`](./docs/dev-database-copy.md): Prod -> dev copy, its dev marker, scrub and prune
- [`Agents.md`](./Agents.md): Architecture, conventions, development practices, agent environment
- [`Authentication.md`](./Authentication.md): Auth flows, JWT, Trmnl integration details
- [`GOALS.md`](./GOALS.md): Energy optimization strategy and success metrics
- [`TODO.md`](./TODO.md): Cross-session deferred work
- [Tesla Fleet API Docs](https://developer.tesla.com/docs/fleet-api)
- [TRMNL Framework v2 Docs](https://trmnl.com/framework/docs/)
