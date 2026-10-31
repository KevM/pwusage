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
- **Load-bearing design decisions**: See [`DesignDecisions.md`](./DesignDecisions.md) for *why* the cross-instance Tesla claim pattern, append-only tariff versioning, the loose-pending TRMNL flow, and the no-SOC/no-genesis battery provenance model exist. Read the relevant section before "simplifying" any of those — each looks reducible but is load-bearing.

## Authentication & Security

Authentication and authorization documentation is consolidated in [`Authentication.md`](./Authentication.md).

## Conventions
- **Files**: Use `kebab-case` for filenames.
- **Components**: Functional components, stored in `src/components`.
- **Scripts**: Standalone maintenance scripts in `scripts/`, runnable via `npx tsx scripts/script-name.ts`.
    - **Environment Variables**: Scripts must explicitly load the `.env` file using `dotenv` or similar at the very beginning to ensure correct configuration when run from the CLI.
- **Cron Jobs**: Vercel Cron Jobs configured in `vercel.json` and implemented in `src/app/api/cron/*`.
- **User-facing copy**: Follow [`docs/voice-and-terms.md`](./docs/voice-and-terms.md) for voice and the word list (Smart Shift, Battery Saver, job, export cushion) in every app, widget, web and TRMNL string.

## Development
- **Linting**: `npm run lint` must pass.
- **Typing**: STRICTLY avoid the `any` type. Explicitly define interfaces or types for all variables and function parameters.
- **Build**: `npm run build` must pass before finishing tasks.
- **Migrations**: SQL migrations in `cmd/next-app/db-migrations/`.
  - **IMPORTANT**: To avoid timestamp/version conflicts, NEVER create migration files manually. Always use the migration generator script to create new SQL migrations:
    ```bash
    # Run from cmd/next-app
    npm run db:migration:create <migration_name>
    ```
  - When pushing to PRs a GitHub Action will test any migrations against a backup of production to ensure they can be applied. Note: This does cause Trmnl device installations in the dev database to become invalid. 
  - **Row Level Security (RLS)**: Whenever a new table is created, you **MUST** enable Row Level Security (RLS) and restrict public/anonymous/authenticated access while granting all permissions to the `service_role` role.
    - **Automatic Template**: The migration generator script (`npm run db:migration:create`) automatically prepends RLS boilerplate code as comments at the top of every generated SQL file. Be sure to uncomment and customize this template whenever creating new tables.
    - **Boilerplate Example**:
      ```sql
      ALTER TABLE "MyNewTable" ENABLE ROW LEVEL SECURITY;
      REVOKE ALL ON "MyNewTable" FROM PUBLIC;
      REVOKE ALL ON "MyNewTable" FROM anon;
      REVOKE ALL ON "MyNewTable" FROM authenticated;
      GRANT ALL ON "MyNewTable" TO service_role;
      -- If using serial/sequence/BIGSERIAL:
      GRANT ALL ON SEQUENCE "MyNewTable_id_seq" TO service_role;
      ```

## Repo Layout (Important)
- Primary active app under development is in `cmd/next-app` (App Router code is under `cmd/next-app/src`).
- Do not assume a top-level `src/`.
- If a task says “Next.js code”, start in `cmd/next-app` unless explicitly told otherwise.
- Native iOS app and its tests are in `cmd/ios-app`.

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

## iOS Device Signing
- Preserve `DEVELOPMENT_TEAM: 6HQGHHRK87` in `cmd/ios-app/project.yml`. The user explicitly wants this committed setting for device deployment.
- Do not remove it, move it to an untracked local override, or require manual signing setup unless the user explicitly requests that change. It is an intentional project preference, not a security finding.

## iOS Test Runs & Code Quality
- **Swift API Design Guidelines & Swifty Naming Conventions**:
  - **Clarity at Call Site**: Call sites must read like fluent English prose (e.g. `cache.store(item, for: key)` NOT `cache.storeItemWithKey(item, key)`).
  - **Omit Needless Words**: Do not repeat type names or enclosing context (e.g. `site.refresh()`, `battery.level`, NOT `site.refreshSite()`, `battery.batteryLevel`).
  - **No `get` Prefixes for Getters**: Use noun phrases or properties (`user.profile`, `fetchMetrics()` if async/throwing, NOT `user.getProfile()`).
  - **Boolean Naming**: Read as assertions about receiver (`isEmpty`, `isRefreshing`, `hasData`, `animated: true`, NOT `empty`, `refreshFlag`).
  - **Mutating vs Non-Mutating**: Imperative verbs for mutating side effects (`sort()`, `reverse()`); `-ed` / `-ing` or nouns for non-mutating (`sorted()`, `reversed()`).
  - **No Force Unwrapping**: Strict prohibition of `!` (force-unwrap or force-try `try!`). Always use `guard let`, `if let`, nil-coalescing `??`, or throw.
- **Strict Linting & Pre-commit Verification**:
  - Always run `cmd/ios-app/format.sh` after any Swift edits.
  - Always run `swiftlint lint cmd/ios-app --strict --baseline .swiftlint-baseline.json` from repo root. Never introduce new SwiftLint warnings or errors.
  - SwiftLint Budgets: Line length ≤ 120 chars; file length ≤ 400 (warn)/500 (err); type body ≤ 350 (warn)/450 (err); function body ≤ 50 (warn)/100 (err); cyclomatic complexity ≤ 10 (warn)/20 (err).
- **Test Execution**: For every native iOS test run, use `cmd/ios-app/run-tests.sh` (or `./run-tests.sh` from that directory). Do not invoke `xcodebuild test` directly. The script generates the Xcode project, selects an available iPhone simulator, disables parallel test execution, and stops a run after 10 minutes.
- **Quick vs full**: while iterating, use `./run-tests.sh --quick`, the everyday sniff test. It skips the multi-minute suites listed in `cmd/ios-app/quick-test-skips.txt` (detector fixture parity) and combines with filters, e.g. `./run-tests.sh --quick AppConfigurationTests`. Plain `./run-tests.sh` runs every default suite as a Debug build. Run it once before opening or updating a PR, and whenever you change code covered by a skipped suite, such as `Models/Solar/LayoutDetection`. Add a suite to the skip file only when it takes more than about 30 s in Debug. CI runs `./run-tests.sh --full`. That run builds optimized (`-O`, still `@testable`) and also runs the opt-in year-fixture parity suite. Use it locally to reproduce a CI-only failure.
- Set `PWUSAGE_SIMULATOR_ID` to target a specific simulator, or `PWUSAGE_TEST_TIMEOUT_SECONDS` to change the deadline. A failed or timed-out run prints the retained test-artifact path.
- If a run times out, inspect the retained artifacts and simulator state before changing app code. Avoid overlapping test runs.
- **Framework**: All iOS tests must use Swift Testing (`SwiftTest` via `import Testing`, `@Suite`, `@Test`, `#expect`, `#require`). Do not use legacy `XCTest`.
- **Targeting Specific Tests**: Target individual suites/fixtures (e.g., `./run-tests.sh AppConfigurationTests`) or specific test methods (e.g., `./run-tests.sh AppConfigurationTests/defaultsToProductionAPIOrigin`). The script automatically normalizes the target prefix and method parentheses. `./run-tests.sh PWUsageTests` runs the whole bundle. A run that executes zero tests (for example a misspelled suite) exits non-zero even though `xcodebuild` prints `TEST SUCCEEDED`. After changing the script, run `./test-run-tests.sh`.
- **Waiting in tests**: Never assert after a fixed `Task.sleep`. Use `eventually` for a state that must be reached and `staysTrue` for one that must not change, both in `PWUsageTests/test-waits.swift`.

## Communication Style
- **Task Management**: Use `task.md` to track huge chunks of work.
- **Verification**: Always verify builds, lint, and run tests before finishing tasks.
- **Git Commits**: Automatically commit verified changes at the end of completed tasks using clear, conventional commit messages.
- **Pull Requests**: Create pull requests as drafts initially unless the user requests otherwise. iOS CI runs on a self-hosted macOS runner (`self-hosted`) when PRs are ready for review or manually via `workflow_dispatch`. Tests can also be run locally with `./run-tests.sh`.
- **Persona**: Helpful, competent software engineer pair programmer.
