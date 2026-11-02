# Site History Onboarding Implementation Plan

**Goal:** Load useful site history without blocking the user and extend the search when detector feedback shows that more solar evidence may help.

**Architecture:** A persisted, account-and-site-scoped iOS coordinator owns a cursor and requests short, fixed site-local date slices from an authorized JSON proxy. It advances only after a whole slice is confirmed complete; retrying a slice is idempotent through the existing importer coverage audit. The phone syncs solar samples and uses detector feedback to decide whether to continue. The Settings row is permanent and the tab accessory is temporary.

**Tech Stack:** SwiftUI, Swift concurrency, BackgroundTasks, Swift Testing, Next.js route handlers, TypeScript, Vitest, PostgreSQL.

**Design:** `docs/plans/2026-11-02-history-onboarding-design.md`. Apply the project Swift craft, concurrency, testing and SwiftUI skills; consult the background-processing skill before scheduling work. Avoid unrelated tariff or ROI work.

---

### Task 1: Establish coverage and proxy contract

**Inspect:** `cmd/next-app/src/app/api/sync/route.ts`, `cmd/next-app/src/lib/importer/index.ts`, `cmd/next-app/src/lib/importer/import-planner.ts`, `cmd/next-app/src/lib/prototypes/compact-history-store.ts`, `cmd/next-app/src/lib/site-repo.ts`, and `Authentication.md`.

1. Trace mobile session authentication, per-site lock behavior, settled/open/empty statuses, installation and `history_backfill_from` bounds, request cost and existing range order. Document whether `/api/sync` can report completed coverage after cancellation and work within iOS background deadlines.
2. Add focused tests for a new mobile JSON route: authorized and unauthorized sites, invalid site-local dates, ranges over three days or beyond one year, installation and known-empty boundaries, already-covered/settled-empty slices, partial budget, busy lock and upstream failures. Run the focused Vitest file and confirm new contract tests fail before implementation.
3. Add a mobile JSON operation that calls `ensureDataForRange` with a short time budget and at most three windows. Report only whole-slice `complete`, `partial`, `busy` or actionable failure; do not expose importer progress strings or add per-day progress storage. Preserve existing import and gap-heal semantics. The phone derives checked days from confirmed slices and available solar days from solar-history sync.
4. Run the focused server tests and confirm they pass. Verify retries do not refetch settled days, and document request/time caps and SOE cost.

### Task 2: Detector readiness and feedback

**Modify:** `cmd/ios-app/PWUsage/Models/Solar/LayoutDetection/solar-layout-detector.swift` and, if needed, `solar-layout-detector-support.swift`; tests under `cmd/ios-app/PWUsageTests/`.

1. Add Swift Testing cases for the 42-producing-day boundary, site-local day/DST handling, no production, sufficient evidence, and low-evidence causes. Run the targeted suite with `cmd/ios-app/run-tests.sh --quick <suite>` and confirm the new expectations fail.
2. Extract an inexpensive shared readiness assessment using the exact existing detector semantics. Classify results as usable, potentially helped by more history, or requiring a different action. Audit `few-clear-days` early exits before defining retry behavior; preserve detector parity and do not equate any low-confidence result with insufficient history.
3. Test that the detector and onboarding use the same readiness rule. Run the relevant targeted tests and the full default iOS suite because layout detection is covered by skipped fixture parity tests.

### Task 3: On-device job and server client

**Create:** `cmd/ios-app/PWUsage/State/Solar/site-history-onboarding.swift` and focused tests `cmd/ios-app/PWUsageTests/site-history-onboarding-tests.swift` (adjust names to repository conventions).
**Modify:** `cmd/ios-app/PWUsage/Networking/PWUsageAPI.swift` and related API models, `cmd/ios-app/PWUsage/State/Solar/solar-history-store.swift`, and `solar-layout-detection-runner.swift` as required.

1. Test a deterministic job using injected clock, proxy and detector: recent 14 days first; newest-first continuation; 90-day checkpoint; stop on usable layout, installation/known-empty boundary, or one year; bounded reassessment when more evidence may help; no solar dependency for initial recent history.
2. Test one persisted oldest-confirmed-slice cursor on relaunch, response loss and partial results, lock contention, retry/backoff and rate limits, authentication pause, cancellation and expiration, account/site isolation, multiple-device overlap and empty days. Assert the cursor never advances without whole-slice confirmation and that retry requests the same slice.
3. Implement the minimal state machine and persistent cursor, with explicit queued/running/paused/completed outcomes and retry timing. Use site-local calendar operations rather than fixed 24-hour arithmetic. Derive checked-day progress from confirmed slices and available solar days from the existing history store; do not persist a second per-day ledger.
4. Sync new solar data at bounded checkpoints; trigger detector runs on material history changes without waiting for the normal 30-day low-confidence cadence. Deduplicate existing sync/detection tasks and preserve their scope and location generation checks. Run targeted tests and verify all cases pass.

### Task 4: Lifecycle and background opportunities

**Inspect/modify:** `cmd/ios-app/PWUsage/App/pwusage-app.swift`, `cmd/ios-app/PWUsage/App/pwusage-app-model.swift`, `cmd/ios-app/PWUsage/State/Solar/background-solar-forecast-refresh.swift`, `background-solar-layout-detection.swift`, and `cmd/ios-app/project.yml` as appropriate.

1. Test job startup for new and existing eligible sites, foreground resume, background expiration/rescheduling, sign-out, account/site switches, and demo mode. Verify an inactive site cannot leak its status into another scope.
2. Integrate with the existing background task lifecycle where appropriate; select a task type and budget based on actual work. Cancel promptly on expiration and persist confirmed progress. Do not depend on iOS granting a scheduled run or force refresh of Smart Shift/bill.
3. Run the targeted lifecycle tests. Check manual foreground/background behavior on a simulator using `cmd/ios-app/run-tests.sh` for tests.

### Task 5: Settings and tab-bar experience

**Modify:** `cmd/ios-app/PWUsage/Navigation/app-tab-view.swift`, `cmd/ios-app/PWUsage/Views/Settings/settings-view.swift`; create a focused Site history detail view and presentation tests in corresponding `Views/Settings` and `PWUsageTests` directories.

1. Test status presentation for active, complete, paused, auth action, limited history, missing location and one-year limit; ensure checked and available counts are distinct and accessible.
2. Add the permanent Site history row and detail view. Add the iOS 26 bottom accessory only while the selected site's job is active; tapping selects Settings and navigates to history. Handle compact accessory placement, sidebar, demo mode, Dynamic Type and VoiceOver. Keep wording aligned with `docs/voice-and-terms.md`.
3. Verify Smart Shift and expected bill refresh only on their existing selected-tab paths; no import-driven eager refresh. Run targeted UI/presentation tests and inspect the relevant screens on a simulator.

### Task 6: End-to-end and required checks

1. Exercise a new site with controlled 90-day history, a case needing more than 90 days, insufficient/empty data, auth loss/recovery, app restart, and concurrent gap healing. Verify request counts, coverage and detector outcomes. Confirm no unsupported promise of background completion.
2. After Swift edits run `cmd/ios-app/format.sh`, then `swiftlint lint cmd/ios-app --strict --baseline .swiftlint-baseline.json` from repo root. Run `cmd/ios-app/run-tests.sh` once for all default suites; use `--full` if reproducing CI-only behavior.
3. From `cmd/next-app`, run `npm run lint`, `npm run test`, and `npm run build`. Address failures and report any environment blockers with evidence.
4. Review the final diff, preserve unrelated changes, and commit verified work with a conventional message. Use the migration generator and RLS requirements if a migration proves necessary.

### Task 7: Reversible Dev setup for real-device testing

**Create:** paired setup and restore scripts under `cmd/next-app/scripts/`, with usage documented alongside them. Use the existing `assert-dev-database.sql` positive Dev marker; never infer safety from a hostname or environment variable alone.

1. Design setup to require an explicit site ID, verify its displayed identity, and save a site-scoped, lossless snapshot of the relevant archive records, summaries and any additional state affected by the reset before deleting anything. Record database identity, schema version, row counts and integrity checks in the snapshot. Do not overwrite an existing backup. Preserve site, credentials, tariff configuration and unrelated sites. Account for active imports and gap-heal writes; prevent or detect concurrent changes rather than silently losing them.
2. Design restore to validate the Dev marker, snapshot identity and compatibility, and restore transactionally. Explicitly handle history newly imported during the test: preview conflicts and require an intentional choice to replace test data or retain it; never silently overwrite newer records. Verify restored counts and checksums and make failure leave the database recoverable. Test both scripts against a disposable database, including refusal on non-Dev, wrong site, missing/corrupt snapshot, conflicts and interrupted restore.
3. Provide a separate Debug-only way to reset or isolate the phone's onboarding and solar-history state for the selected site. This must not clear real account data or affect Release builds. The user can then observe the real server-proxied import without a simulated Tesla backend.
4. At manual test time, explicitly confirm the app points to Beta/Dev (Debug currently defaults to Prod), run setup only for the chosen Dev site, verify empty coverage, exercise import and resume, then run restore and verify the snapshot. Keep backup files private and out of git. Do not rely on a future PR database refresh as the sole restoration method.
