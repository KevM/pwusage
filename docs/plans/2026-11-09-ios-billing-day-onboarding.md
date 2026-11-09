# iOS Billing Day Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ask a new iOS user which day of the month their bill cycles, skip the question if it was already answered (web or iOS), and give iOS a setting to change it later.

**Architecture:** A nullable `Site.billing_start_day_confirmed_at` records that a person chose the day; `billing_start_day` keeps its `DEFAULT 1` and stays non-null. Every write of the day (web setup, web settings, a new mobile endpoint) sets the marker. `/api/sites` exposes `billingDay` and `billingDayConfirmed`; iOS shows a one-time picker sheet for the selected site while it is unconfirmed, and reuses the same picker in Settings.

**Tech Stack:** Next.js route handlers, raw `pg` queries via `SiteRepo`, SQL migrations in `cmd/next-app/db-migrations`, vitest; SwiftUI, Swift Testing, `cmd/ios-app/run-tests.sh`.

**Spec:** The design agreed in conversation (2026-11-09), summarised under Architecture above. There is no separate spec file.

## Global Constraints

- Valid billing day is an integer 1–31, same as `updateBillingStartDay` in `cmd/next-app/src/app/site/[id]/settings/actions.ts`. Short months already clamp in `getCurrentCycleStart`/`getNextCycleStart`, so the picker offers 1–31.
- Do not make `billing_start_day` nullable; callers use `|| 1`.
- Mobile contract changes land on both sides in one PR: `cmd/ios-app/Shared/MobileLiveContract.swift` ↔ `cmd/next-app/src/lib/mobile-dashboard-contract.ts` (only if those files' types change; `MobileSite` lives in `cmd/ios-app/PWUsage/Models/MobileContracts.swift`).
- User-facing copy follows `docs/voice-and-terms.md`: plain, benefit first, calm, no exclamation marks, no "please".
- Migrations are additive and idempotent (`IF NOT EXISTS`), named `YYYYMMDDHHMMSS_name.sql`, newest currently `20261101120000_drop_site_solar_layout.sql`.
- iOS: `swiftformat --lint` and `swiftlint --strict` clean, zero compiler warnings, tests via `cmd/ios-app/run-tests.sh` only.
- TDD: failing test first for each behavior.

## Review Focus

- New iOS against an old server (fields absent from `/api/sites`): treat the site as confirmed so the user is never prompted for something that cannot be saved.
- Old iOS against the new server: extra JSON fields are ignored; nothing else changes.
- User confirms on the web after iOS has already fetched sites: the sheet's POST is idempotent, and a foreground site refetch stops the prompt.
- Billing day 29–31 round-trips through the endpoint and the picker unchanged.
- A site the user cannot access (revoked, or another account's id): POST returns 401, the sheet shows an error and stays retryable, no marker is written.
- Demo mode never shows the sheet and never POSTs.
- A person with several sites is asked per site, when that site is selected, not once per account.
- "Not now" does not mark the site confirmed, does not re-prompt in the same app run, and leaves the site's bill valid with day 1.

---

### Task 1: Confirmation marker in the database and repo

**Files:**
- Create: `cmd/next-app/db-migrations/20261109120000_site_billing_start_day_confirmed.sql`
- Modify: `cmd/next-app/src/lib/site-repo.ts` (`SITE_BASE_COLUMNS` at line 39, the row mapping near line 359, `updateSiteBillingDay` at line 498)
- Modify: `cmd/next-app/src/lib/db-types.ts` (`Site`, line 36)
- Modify: `cmd/next-app/src/lib/user-repo.ts` (column list near line 133)
- Test: `cmd/next-app/src/lib/site-repo.test.ts`

**Interfaces:**
- Produces: `Site.billing_start_day_confirmed_at: Date | null`; `SiteRepo.updateSiteBillingDay(siteId: string, day: number): Promise<void>` now also sets `billing_start_day_confirmed_at = now()`; every `Site` returned by `getSite`/authorized-site queries carries the field.

- [ ] **Step 1: Write failing tests** in `site-repo.test.ts`: `updateSiteBillingDay sets the confirmation timestamp and drops the cache entry` (assert the SQL sets both `billing_start_day` and `billing_start_day_confirmed_at`), and `getSite maps billing_start_day_confirmed_at to null when the column is null and to a Date when set`.
- [ ] **Step 2: Run** `cd cmd/next-app && npx vitest run src/lib/site-repo.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Write the migration.** `ALTER TABLE "Site" ADD COLUMN IF NOT EXISTS billing_start_day_confirmed_at timestamptz;` then backfill `UPDATE "Site" SET billing_start_day_confirmed_at = now() WHERE billing_start_day_confirmed_at IS NULL AND billing_start_day IS NOT NULL AND billing_start_day <> 1;`. Comment why day 1 stays unconfirmed (the default is indistinguishable from a choice), in the style of `20261030150000_site_solar_layout_location_source.sql`.
- [ ] **Step 4: Implement** the column in `SITE_BASE_COLUMNS`, `user-repo.ts`, the `Site` type and row mapping, and extend `updateSiteBillingDay`'s `UPDATE`. Fix any other `Site` fixtures that fail typecheck.
- [ ] **Step 5: Run** `npx vitest run src/lib/site-repo.test.ts src/lib/user-repo.test.ts && npm run typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** `feat: record when a site's billing day was confirmed`.

### Task 2: Expose the marker and add the mobile write endpoint

**Files:**
- Modify: `cmd/next-app/src/app/api/sites/route.ts` (the `result` mapping)
- Create: `cmd/next-app/src/app/api/mobile/billing-day/route.ts`
- Test: `cmd/next-app/src/app/api/sites/route.test.ts` (create if absent), `cmd/next-app/src/app/api/mobile/billing-day/route.test.ts`

**Interfaces:**
- Consumes: `Site.billing_start_day_confirmed_at`, `SiteRepo.updateSiteBillingDay` (Task 1).
- Produces: `GET /api/sites` items become `{ id: string, name: string, utility: string, billingDay: number, billingDayConfirmed: boolean }`. `POST /api/mobile/billing-day` with JSON `{ siteId: string, day: number }` returns `200 { billingDay: number, billingDayConfirmed: true }`; `400` on a missing site id or a day that is not an integer 1–31; `401` when `verifySiteAccess` is false. Posting the day a site already has is valid and sets the marker (this is the "confirm 1" path).

- [ ] **Step 1: Write failing tests.** `/api/sites`: `includes billingDay and billingDayConfirmed` (day 15 with a timestamp → `true`; day 1 with `null` → `false`; a TRMNL-token response includes them too). Endpoint: `rejects unauthorized`, `rejects day 0, 32, 1.5 and "abc"`, `saves day 31 and marks it confirmed`, `confirming the existing day 1 succeeds`.
- [ ] **Step 2: Run** `npx vitest run src/app/api/sites src/app/api/mobile/billing-day`. Expected: FAIL.
- [ ] **Step 3: Implement** both handlers. The route follows the sibling mobile routes: `withRequestContext`, `verifySiteAccess`, `Cache-Control: private, no-store`. Share the 1–31 validation with `updateBillingStartDay` by extracting one exported helper (e.g. `parseBillingDay(value: unknown): number | null` in `cmd/next-app/src/lib/billing-cycle.ts`) and use it in both places.
- [ ] **Step 4: Run** the two test files plus `npx vitest run src/app/site`, then `npm run typecheck && npm run lint`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: mobile billing day endpoint and site fields`.

### Task 3: iOS model and API client

**Files:**
- Modify: `cmd/ios-app/PWUsage/Models/MobileContracts.swift` (`MobileSite`)
- Modify: `cmd/ios-app/PWUsage/Networking/PWUsageAPI.swift` (add `setBillingDay`)
- Test: `cmd/ios-app/PWUsageTests/MobileContractsTests.swift`, plus the existing API client tests (find with `git grep -l "fetchSites" cmd/ios-app/PWUsageTests`)

**Interfaces:**
- Consumes: Task 2 JSON shapes.
- Produces: `MobileSite` gains `let billingDay: Int` and `let billingDayConfirmed: Bool`. A custom `init(from:)` defaults a missing `billingDayConfirmed` to `true` and a missing `billingDay` to `1` (old server ⇒ never prompt). `var needsBillingDayConfirmation: Bool { !billingDayConfirmed }`. `PWUsageAPI.setBillingDay(siteID: String, day: Int) async throws -> MobileSite.BillingDay` where `struct BillingDay: Equatable { let day: Int }` is the decoded response; a non-2xx maps to the existing `PWUsageAPIError` cases.

- [ ] **Step 1: Write failing tests:** `decodes billingDay and billingDayConfirmed`, `missing fields decode as confirmed day 1`, `setBillingDay posts siteId and day and decodes the response`, `setBillingDay surfaces 401 as the unauthorized error`.
- [ ] **Step 2: Run** `cd cmd/ios-app && ./run-tests.sh --quick` (cap with `PWUSAGE_TEST_TIMEOUT_SECONDS`). Expected: new tests FAIL.
- [ ] **Step 3: Implement** the model and client. Update every `MobileSite(...)` construction in app and tests, including `Demo/` fixtures (demo sites are confirmed).
- [ ] **Step 4: Run** `./run-tests.sh --quick`. Expected: PASS, zero warnings.
- [ ] **Step 5: Commit** `feat(ios): billing day on MobileSite and API client`.

### Task 4: Shared picker and the Settings row

**Files:**
- Create: `cmd/ios-app/PWUsage/Views/Settings/BillingDayPicker.swift`
- Modify: `cmd/ios-app/PWUsage/Views/Settings/SettingsView.swift` (new row in the `Section("Site")` area, line ~24)
- Modify: `cmd/ios-app/PWUsage/App/PWUsageAppModel+Sites.swift` (a `saveBillingDay(_:)` action that calls the API, then replaces the site in `sites` and the cache via `cache?.storeSites`, and refreshes the bill)
- Test: `cmd/ios-app/PWUsageTests/BillingDayPickerTests.swift`

**Interfaces:**
- Consumes: `PWUsageAPI.setBillingDay`, `MobileSite.billingDay` (Task 3).
- Produces: `BillingDayPicker(selection: Binding<Int>)` offering 1–31; a pure `BillingDayPresentation.summary(day: Int) -> String` returning `"Day 15"` style text and the ordinal-safe footer `"Your bill starts on this day each month. Months with fewer days start on their last day."` (check wording against the voice doc); `PWUsageAppModel.saveBillingDay(siteID: String, day: Int) async throws`.

- [ ] **Step 1: Write failing tests:** `presentation summary for 1, 22, 31`, `saveBillingDay updates the selected site and marks it confirmed`, `saveBillingDay failure leaves the site unchanged and rethrows`.
- [ ] **Step 2: Run** `./run-tests.sh --quick`. Expected: FAIL.
- [ ] **Step 3: Implement** the picker view, the model action, and the Settings row (a `NavigationLink` or inline `Picker` row labelled "Bill start day" showing the current day; saving calls `saveBillingDay`, shows an inline error on failure). Hidden in demo mode (read-only demo).
- [ ] **Step 4: Run** `./run-tests.sh --quick` and `./lint.sh`. Expected: PASS and clean.
- [ ] **Step 5: Commit** `feat(ios): billing day setting`.

### Task 5: First-run sheet for unconfirmed sites

**Files:**
- Create: `cmd/ios-app/PWUsage/Views/Settings/BillingDayOnboardingSheet.swift`
- Create: `cmd/ios-app/PWUsage/State/BillingDayPromptState.swift`
- Modify: `cmd/ios-app/PWUsage/Navigation/AppTabView.swift` (a third `.sheet`, next to lines 75–88) and `PWUsageAppModel+Sites.swift` (refetch sites on foreground so a web confirmation clears the prompt)
- Test: `cmd/ios-app/PWUsageTests/BillingDayPromptStateTests.swift`

**Interfaces:**
- Consumes: `MobileSite.needsBillingDayConfirmation`, `saveBillingDay`, `BillingDayPicker` (Tasks 3–4).
- Produces: `struct BillingDayPromptState { mutating func shouldPresent(site: MobileSite?, isDemo: Bool, sessionVerified: Bool, otherSheetPresented: Bool) -> Bool; mutating func dismissed(siteID: String) }`. It presents at most once per site per app run and never in demo mode; `dismissed` records "Not now" in memory only (no persistence; the next launch asks again until answered).

- [ ] **Step 1: Write failing tests:** `presents for the selected unconfirmed site`, `does not present for a confirmed site, in demo mode, before the session is verified, or while another sheet is up`, `Not now suppresses that site for the rest of the run but not another site`, `a refetch that returns the site confirmed clears the prompt`.
- [ ] **Step 2: Run** `./run-tests.sh --quick`. Expected: FAIL.
- [ ] **Step 3: Implement** the state type, the sheet (headline asking which day the utility bill starts, picker prefilled with the site's current day, a "Confirm" button, a "Not now" button, a one-line hint to look for "billing period" on a utility bill), the presentation hook in `AppTabView`, and the foreground refetch. Copy follows the voice doc. Confirm calls `saveBillingDay`; an error shows inline and stays retryable.
- [ ] **Step 4: Verify the ordering with history onboarding.** Read `State/Solar/SiteHistoryOnboarding*.swift`: if backfill range or cycle logic depends on `billing_start_day`, hold the history job until the sheet resolves (confirm or Not now); otherwise leave it unblocked. Record the finding in the commit message.
- [ ] **Step 5: Run** `./run-tests.sh --quick`, then a manual pass in the iOS simulator: a fresh unconfirmed site shows the sheet; confirming dismisses it and Settings shows the new day; a confirmed site never prompts.
- [ ] **Step 6: Commit** `feat(ios): ask for the billing day on first run`.

### Task 6: Verification and docs

**Files:**
- Modify: `cmd/ios-app/README.md` (one line on the onboarding step and setting, if it lists onboarding flows)

- [ ] **Step 1: Run web checks:** `cd cmd/next-app && npm run lint && npm run typecheck && npx vitest run && npm run build`. Expected: all pass.
- [ ] **Step 2: Run iOS checks:** `cd cmd/ios-app && ./lint.sh && ./run-tests.sh` (default Debug mode). Expected: all pass, zero warnings.
- [ ] **Step 3: Apply the migration to the Dev database** (marker present, sanity-check counts: sites with day ≠ 1 are confirmed, day 1 are not) and exercise the endpoint with a Harrison-site session, never against live Tesla.
- [ ] **Step 4: Open a draft PR** from this branch; wrap up with the worktree path and the `open …/PWUsage.xcodeproj` command for any on-device checks.

## Notes and risks

- `codex/shared-site-membership` has uncommitted edits to `site-repo.ts` (and `auth-checks.ts`) in the main checkout. Task 1 touches `SITE_BASE_COLUMNS` and `updateSiteBillingDay`; expect a small merge conflict depending on landing order.
- Shared sites (PR #320 direction): the day is site-level, so any member can set it; whoever answers first wins. Acceptable for now.
- `verifySiteAccess` is request-cached; the new route calls it once.
