# Project Preferences & Guidelines

## Tech Stack
- **Framework**: Next.js 15+ (App Router)
- **Language**: TypeScript
- **Styling**: Tailwind CSS
- **Database**: PostgreSQL (via `pg` drive/pool).
- **Authentication**: See [`Authentication.md`](./Authentication.md) for the full auth/authz model and flows.
- **Testing**: Vitest (`npm run test`)

## Architecture Patterns
- **Repository Pattern**: Data access logic resides in `src/lib/*-repo.ts` (e.g., `EnergyRepo`, `SettingsRepo` - *deleted*).
- **Service Pattern**: Business logic resides in `src/lib/*-service.ts` (e.g., `SiteService`).
- **Authorization**: See [`Authentication.md`](./Authentication.md) for route-level authz rules and checks.

## Authentication & Security

Authentication and authorization documentation is consolidated in [`Authentication.md`](./Authentication.md).

## Conventions
- **Files**: Use `kebab-case` for filenames.
- **Components**: Functional components, stored in `src/components`.
- **Scripts**: Standalone maintenance scripts in `scripts/`, runnable via `npx tsx scripts/script-name.ts`.
    - **Environment Variables**: Scripts must explicitly load the `.env` file using `dotenv` or similar at the very beginning to ensure correct configuration when run from the CLI.
- **Cron Jobs**: Vercel Cron Jobs configured in `vercel.json` and implemented in `src/app/api/cron/*`.

## Development
- **Linting**: `npm run lint` must pass.
- **Typing**: STRICTLY avoid the `any` type. Explicitly define interfaces or types for all variables and function parameters.
- **Build**: `npm run build` must pass before finishing tasks.
- **Migrations**: SQL migrations in `cmd/next-app/db-migrations/`. Create a new `.sql` file with a timestamp prefix for schema changes.
  - When pushing to PRs a GitHub Action will test any migrations against a backup of production to ensure they can be applied. Note: This does cause Trmnl device installations in the dev database to become invalid. 

## Repo Layout (Important)
- Primary active app under development is in `cmd/next-app` (App Router code is under `cmd/next-app/src`).
- Do not assume a top-level `src/`.
- If a task says “Next.js code”, start in `cmd/next-app` unless explicitly told otherwise.
- Secondary legacy web project exists at `cmd/web-app` (only use when task references it).

## TRMNL + Tesla API Constraints
- **TRMNL Poll Cadence**: Assume devices poll at most once every 15 minutes.
- **Cost Control**: Tesla Fleet API calls are billable over thresholds, so avoid per-request live/history fetches when they are not needed.
- **Energy History Resolution**: Tesla energy history data is 5-minute resolution and is easiest to retrieve by day. History requrest for less than a day behave weirdly.
- **TRMNL Markup Style** (`/api/trmnl/markup`, `src/lib/trmnl-renderer.ts`):
    - Prefer [TRMNL Framework v2](https://trmnl.com/framework/docs/) markup/classes/utilities for layout, spacing, typography, and table behavior.
    - Avoid custom inline layout/typography CSS when an equivalent Framework v2 primitive exists.
    - Use custom inline styles only when Framework v2 does not provide the required primitive.
- **Route Behavior** (`/api/trmnl/markup`):
    - Treat DB data as the blocking source-of-truth for markup responses.
    - Run Tesla refreshes in the background with per-site throttling aligned to poll cadence.
    - Prefer stale-while-refresh for Tesla data; do not block response on Tesla API.
    - Never present battery SoC as fresh when stale; if too old, show unknown (`--`) instead.
    - Include freshness/debug headers (e.g., data/SOC age) when adjusting route behavior.

## Agent Dev Environment
- **Port Collision**: The user typically runs `npm run dev` on port 5173.
- **Agent Port**: A `dev:agent` script is available in `package.json` to run on port 5174.
- **Limitation**: Next.js prevents multiple concurrent `next dev` instances in the same directory via a file lock in `.next/`.
- **Workaround**: To test UI or API changes without stopping the user's server:
    1. Stop the user's server temporarily OR
    2. Use `npm run build && next start -p 5174`.

## Communication Style
- **Task Management**: Use `task.md` to track huge chunks of work.
- **Verification**: Always verify builds, lint, and run tests before finishing tasks.
- **Persona**: Helpful, competent software engineer pair programmer.
