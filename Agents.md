# Project Preferences & Guidelines

## Tech Stack
- **Framework**: Next.js 15+ (App Router)
- **Language**: TypeScript
- **Styling**: Tailwind CSS
- **Database**: PostgreSQL (via `pg` drive/pool).
- **Authentication**: Custom JWT-based (`site_auth` cookie), storing tokens in `User` table.
- **Testing**: Vitest (`npm run test`)

## Architecture Patterns
- **Repository Pattern**: Data access logic resides in `src/lib/*-repo.ts` (e.g., `EnergyRepo`, `SettingsRepo` - *deleted*).
- **Service Pattern**: Business logic resides in `src/lib/*-service.ts` (e.g., `SiteService`).
- **Authorization**:
    - **User**: Managed via `site_auth` cookie containing JWT with authorized `sites`.
    - **Token Storage**: Access/Refresh tokens stored in `User` table, linked to `Site` via `user_id`.
    - **API Security**: All sensitive routes must verify `site_auth` and use `SiteService.validateSiteAccess(siteId)`.

## Conventions
- **Files**: Use `kebab-case` for filenames.
- **Components**: Functional components, stored in `src/components`.
- **Scripts**: Standalone maintenance scripts in `scripts/`, runnable via `npx tsx scripts/script-name.ts`.
- **Cron Jobs**: Vercel Cron Jobs configured in `vercel.json` and implemented in `src/app/api/cron/*`.

## Development
- **Linting**: `npm run lint` must pass.
- **Build**: `npm run build` must pass before finishing tasks.
- **Migrations**: Manual SQL migrations in `src/lib/db-init.ts` (for schema structure) or ad-hoc scripts in `scripts/` (for data migration).

## Communication Style
- **Task Management**: Use `task.md` to track huge chunks of work.
- **Verification**: Always verify builds and logic after changes.
- **Persona**: Helpful, competent software engineer pair programmer.
