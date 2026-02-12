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

## Authentication & Security

### 1. Site Authorization (`site_auth`)
- **Mechanism**: JWT stored in an HTTP-only cookie named `site_auth`.
- **Payload**: Contains the authenticated `sub` (User ID), `roles` (e.g., admin), and the list of authorized `sites` (legacy claim, moving towards validation via User ID).
- **Purpose**: Identifies the currently logged-in user and their active session. **This is NOT the Tesla Access Token.**

### 2. Tesla Token Storage
- **Storage**: Tesla `access_token` and `refresh_token` are stored securely in the `User` database table, keyed by the User ID.
- **Retrieval**: To make Tesla API calls:
    1.  Validate `site_auth` JWT to get the `userId`.
    2.  Query `EnergyRepo.getUserTokens(userId)` to get the actual `access_token`.
    3.  Initialize `TeslaClient` with this token.
- **Security**: The raw Tesla `access_token` is **NEVER** exposed in cookies or client-side storage to prevent theft.

### 3. Trmnl Integration Auth
- **Primary**: Authenticated via a unique Trmnl `uuid` and `token` (Trmnl-specific secret).
- **Re-Authentication Fallback**: If the Trmnl secret is missing (e.g., re-scanning QR code):
    1.  App verifies the user has a valid `site_auth` session.
    2.  App retrieves the user's Tesla `access_token` from the DB.
    3.  App verifies against the Tesla API that the user owns the site linked to the Trmnl UUID.
    4.  If owned, access is granted to update the integration.


## Conventions
- **Files**: Use `kebab-case` for filenames.
- **Components**: Functional components, stored in `src/components`.
- **Scripts**: Standalone maintenance scripts in `scripts/`, runnable via `npx tsx scripts/script-name.ts`.
    - **Environment Variables**: Scripts must explicitly load the `.env` file using `dotenv` or similar at the very beginning to ensure correct configuration when run from the CLI.
- **Cron Jobs**: Vercel Cron Jobs configured in `vercel.json` and implemented in `src/app/api/cron/*`.

## Database Timezone Handling

## Development
- **Linting**: `npm run lint` must pass.
- **Typing**: STRICTLY avoid the `any` type. Explicitly define interfaces or types for all variables and function parameters.
- **Build**: `npm run build` must pass before finishing tasks.
- **Migrations**: SQL migrations in `cmd/next-app/db-migrations/`. Create a new `.sql` file with a timestamp prefix for schema changes.

## Communication Style
- **Task Management**: Use `task.md` to track huge chunks of work.
- **Verification**: Always verify builds, lint, and run tests before finishing tasks.
- **Persona**: Helpful, competent software engineer pair programmer.
