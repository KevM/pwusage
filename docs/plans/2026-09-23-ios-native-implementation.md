# Native iPhone Dashboard Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the first read-only SwiftUI pwusage app for live site status and the current bill, using the existing server APIs and `site_auth` cookie.

**Architecture:** The Next.js server retains Tesla access, authorization, and billing. One app-wide coordinator owns all foreground requests: live at most every five minutes, bill at most every 30 minutes, and no background polling. XcodeGen's `project.yml` is the source for the iOS project; the generated `.xcodeproj` is ignored.

**Tech Stack:** XcodeGen 2.46, Xcode 27, Swift 6, SwiftUI, `ASWebAuthenticationSession`, `URLSession`, XCTest, Next.js 16/Vitest for a small bill-contract addition.

---

## Context and boundaries

- Work on the existing `codex/ios-foundation` branch in `/Users/kevm/github/pwusage/.worktrees/ios-foundation`. Its Next.js test baseline is 785 passing and one opt-in database trace skipped.
- Follow the peer `/Users/kevm/github/sleepdaddy/project.yml` structure for XcodeGen. Use provisional `fm.rodeo.pwusage` bundle ID, with `DEVELOPMENT_TEAM` supplied externally for later device signing. Simulator builds set `CODE_SIGNING_ALLOWED=NO`. Do not copy SleepDaddy's app name, HealthKit entitlements, document types, or release settings.
- The login callback is exactly `pwusage://auth/callback` (host `auth`, path `/callback`). `/api/mobile/session` requires `Content-Type: application/json` and issues `site_auth` in the HTTP response. Use a persistent default `URLSession` cookie store for the exchange and subsequent API calls.
- The generated `MobileLoginHandoff` migration was validated inside a rollback transaction but is unapplied. Native login against a deployed server requires that migration to be applied there. Do not deploy or apply it to production during this plan.
- The development egress route trace is a JSON-row byte proxy, not PostgreSQL wire bytes. A populated late-cycle snapshot modeled about 13.7 MB/month per phone at one foreground hour/day and 329.6 MB at 24 hours/day. Each phone adds requests. Keep the actual database egress acceptance gate open.
- First-release exclusions: controls, background polling, widgets, notifications, offline promises, full charts, and App Store distribution.

### Task 1: Add current-bill period rows without another database query

**Files:**
- Modify: `cmd/next-app/src/app/api/mobile/bill-summary/route.ts`
- Modify: `cmd/next-app/src/app/api/mobile/bill-summary/route.test.ts`
- Modify: `cmd/next-app/src/lib/mobile-dashboard-contract.ts`
- Modify: `cmd/next-app/src/lib/mobile-dashboard-contract.test.ts`

**Steps:**
1. Write a failing route test with two `getUsageByTOU` rows in different TOU periods. Assert the response has a compact `periods` array with tariff/period name, signed net-grid kWh, and cost; assert sum of period costs equals `currentBill.estimatedCost`. Keep the existing nullable total when no usage exists.
2. Add `MobileBillPeriod` to the TypeScript contract and map the already-loaded `usage` array to `periods`. Preserve historical tariff names/rates already resolved by `getUsageByTOU`; do not call another repo method or put tariff JSON/raw energy rows in the response.
3. Run the focused tests, then the full Next tests, lint, and build. Rerun the guarded route egress trace on the same populated dev snapshot; its SQL query count/result rows must be unchanged because only the HTTP response shape changed. Commit a conventional server-contract change.

### Task 2: Scaffold the XcodeGen app and test target

**Files:**
- Create: `cmd/ios-app/project.yml`, `cmd/ios-app/generate.sh`, `cmd/ios-app/README.md`
- Create: `cmd/ios-app/PWUsage/PWUsageApp.swift`, `cmd/ios-app/PWUsage/Configuration/AppConfiguration.swift`
- Create: `cmd/ios-app/PWUsageTests/AppConfigurationTests.swift`
- Modify: `.gitignore`

**Steps:**
1. Adapt SleepDaddy's `project.yml` to an iOS 18+ `PWUsage` application and `PWUsageTests` unit-test target with a shared `PWUsage` scheme, Swift 6, and generated `Info.plist`. Register only the `pwusage` URL scheme. Keep generated `.xcodeproj` and Info.plists ignored.
2. Put the API origin in one configuration value. The default release origin is `https://pwusage.fm.rodeo`; tests inject a URL, and local debug configuration may override it without committing credentials. Reject a malformed or non-HTTPS release origin. The provisional bundle ID is `fm.rodeo.pwusage`; signing team comes from `DEVELOPMENT_TEAM` when set.
3. Add a minimal app entry point and configuration unit test. Run `xcodegen generate`, then `xcodebuild -project PWUsage.xcodeproj -scheme PWUsage -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build`. If CoreSimulator is restricted, retry the simulator commands through the approved host execution path. Commit source/spec/README/ignore changes, not generated output.

### Task 3: Decode contracts and use one cookie-aware API client

**Files:**
- Create: `cmd/ios-app/PWUsage/Models/MobileContracts.swift`
- Create: `cmd/ios-app/PWUsage/Networking/PWUsageAPI.swift`
- Create: `cmd/ios-app/PWUsageTests/MobileContractsTests.swift`, `cmd/ios-app/PWUsageTests/PWUsageAPITests.swift`

**Steps:**
1. Add fixture-backed decoding tests for `/api/sites`, the v1 mobile live response, and the v1 bill response. Represent nullable SoC, tariff, bill cost, and source timestamps faithfully. Reject unsupported contract versions and a bill returned for another site. Parse ISO timestamps with fractional seconds; preserve the original source time rather than request time.
2. Implement a single injected `URLSession` transport with a default configuration using the shared `HTTPCookieStorage`, automatic cookie handling, and no bearer token. Add typed methods for site list, live, bill, session exchange, and logout. Build URLs with `URLComponents` and encode `siteId` as a query item.
3. Test 401 as a sign-in-required result, 5xx as a recoverable data error, a same-site bill response, and a `Set-Cookie` exchange followed by a cookie-bearing API request using a local `URLProtocol` stub. Do not repeatedly fetch `/api/sites` during dashboard navigation.
4. Run iOS unit tests on an available iPhone simulator and a generic simulator build. Commit.

### Task 4: Implement the one-time native sign-in flow

**Files:**
- Create: `cmd/ios-app/PWUsage/Authentication/MobileAuthService.swift`
- Create: `cmd/ios-app/PWUsageTests/MobileAuthServiceTests.swift`
- Modify: `cmd/ios-app/PWUsage/PWUsageApp.swift`

**Steps:**
1. Test a generated 43–128 character base64url PKCE verifier, SHA-256 challenge, and random app state; test callback URLs for exact scheme/host/path, matching state, required code/attempt, error and cancellation paths. Never accept a JWT or Tesla token from the callback URL.
2. Retain one `ASWebAuthenticationSession` with `.customScheme("pwusage")`. Start it at `/login?mobile_challenge=...&mobile_state=...`, compare returned state, and POST `{attemptId, code, verifier, state}` as JSON through the same cookie-aware `URLSession` used by the API client. Do not assume browser cookies transfer to `URLSession`.
3. On logout, POST `/logout` using that session, then remove the app host's `site_auth` cookie from the cookie store even if the server request fails. Do not persist the JWT separately or log the code/verifier/cookie.
4. Test the exchange result, callback validation, cancellation, logout cleanup, and sign-in-required response. Build and run simulator tests; record actual login and relaunch behavior as a device/deployed-server gate until the migration is deployed. Commit.

### Task 5: Enforce one foreground polling coordinator

**Files:**
- Create: `cmd/ios-app/PWUsage/State/DashboardCoordinator.swift`
- Create: `cmd/ios-app/PWUsageTests/DashboardCoordinatorTests.swift`

**Steps:**
1. With an injected clock and fake API, test initial foreground load, a five-minute live interval, a 30-minute bill interval, foreground return, background suspension, duplicate scene/timer events, in-flight deduplication, site switch, 401, and 5xx. Define the first request at t=0; a continuously foreground 60-minute window has 12 live and 2 bill requests in `[0,60m)`.
2. Implement one app-owned coordinator that shares its latest responses across screens. Track last attempt/success separately per endpoint; failures must not create rapid retries. Cancel/suspend timers in the background; on foreground return fetch each endpoint only if due, never one request per missed interval. A site change may fetch immediately, then resets that site's cadence.
3. Preserve the last successful response with its actual source timestamps during a recoverable failure, but mark it unavailable/stale. A 401 stops polling and presents sign-in. Navigation must not create another coordinator or poller.
4. Run simulator unit tests and build. Commit.

### Task 6: Build the native read-only screens and verify the flow

**Files:**
- Create: `cmd/ios-app/PWUsage/Views/DashboardView.swift`, `cmd/ios-app/PWUsage/Views/BillView.swift`, `cmd/ios-app/PWUsage/Views/SignInView.swift`, `cmd/ios-app/PWUsage/Views/SitePickerView.swift`
- Modify: `cmd/ios-app/PWUsage/PWUsageApp.swift`, `cmd/ios-app/README.md`
- Add focused presentation tests only for calculations or state transitions that can fail independently of SwiftUI layout.

**Steps:**
1. Build a native dashboard with battery state/direction, solar/home/grid power, active tariff, today-so-far energy, current bill estimate, site-local date, and explicit source freshness. Match website signs: negative battery power means charging; positive grid power means importing. Unknown SoC is `--`, not zero. Missing tariffs/no energy and 401 get distinct empty/sign-in states. Use Dynamic Type and VoiceOver labels for the status tiles.
2. Build a current-bill screen with cycle dates, period rows, currency formatting, calculation timestamp, and energy-data timestamp. Reuse the coordinator's bill response; opening the screen must not force an extra request before the 30-minute interval.
3. Wire site selection from one `/api/sites` bootstrap, sign-in/logout, scene-phase transitions, and the app-wide coordinator. No controls, background tasks, widgets, or notifications.
4. Run XcodeGen, simulator build and tests, launch on an iPhone simulator, and visually inspect normal, empty, stale, and error states using fixtures or a safe debug preview. Run the Next full tests/lint/build after any server edits. Commit.

## Release and measurement gate

Before release or production migration: apply the generated handoff migration in a reviewed deployment, test actual sign-in/callback/cookie persistence/renewal/logout on a physical iPhone, compare bill values with the website/TRMNL, and measure database wire egress with representative production-like traffic including cold serverless instances and existing web/TRMNL use. The native coordinator tests prove request cadence, but they do not prove monthly database egress. Revise cadence or server queries if the measured increment is appreciable against the shared 5 GB cap.
