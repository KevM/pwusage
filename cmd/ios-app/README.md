# pwusage for iOS

This directory contains the SwiftUI app source and the XcodeGen specification. The generated `PWUsage.xcodeproj` and target `Info.plist` files are local build inputs and are ignored by git.

## Generate and build

Install XcodeGen 2.46 and Xcode 27, then run:

```sh
./generate.sh
xcodebuild -project PWUsage.xcodeproj -scheme PWUsage -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

Run the native tests with `./run-tests.sh`. Tests use Swift Testing (`import Testing`). It selects an available iPhone simulator and stops the run after 10 minutes if Xcode hangs. Run all tests with `./run-tests.sh`, or target specific suites/tests (e.g. `./run-tests.sh AppConfigurationTests` or `./run-tests.sh AppConfigurationTests/defaultsToProductionAPIOrigin`). Use `PWUSAGE_SIMULATOR_ID=<simulator-udid> ./run-tests.sh` to choose a device or `PWUSAGE_TEST_TIMEOUT_SECONDS=<seconds> ./run-tests.sh` to adjust the deadline. Failed runs retain the result bundle and build files at the printed path.

The app targets iOS 18 and uses `fm.rodeo.pwusage` as a provisional bundle identifier. The project has no signing team configured. For a device build, set `DEVELOPMENT_TEAM` in your local shell (do not commit it) and pass it explicitly as an Xcode build setting:

```sh
xcodebuild -project PWUsage.xcodeproj -scheme PWUsage -destination 'generic/platform=iOS' DEVELOPMENT_TEAM="$DEVELOPMENT_TEAM" build
```

## API origin

Debug builds use `https://pwusagebeta.fm.rodeo` for sign-in and dashboard data. Release builds use `https://pwusage.fm.rodeo`. `AppConfiguration` accepts an injected origin for tests and local development; Release requires HTTPS. To override a Debug build for a local server, set `PWUSAGE_API_ORIGIN` in the Xcode build environment or scheme. Do not commit credentials.

When checking a server-side problem by hand, match the host to the build. A Debug build talks to **beta**, so a `curl` against `pwusage.fm.rodeo` describes production and says nothing about what a Debug build sees. Note that a `401` means the route exists but rejected the unauthenticated request, while a `404` means the route is not deployed at that host. The two are easy to conflate when only one host is checked.

## Server routes the app depends on

Some features are only half-present in the app binary; the other half is a web route that must be deployed. Verify a route exists before blaming the device, the data, or the provider:

```sh
npx tsx scripts/check-mobile-routes-on-base.ts [baseRef]   # from the repository root
```

This exits non-zero when a route the app calls is absent from the base ref. A 404 from `/api/mobile/load-planning-context` means the deployment predates that route, and the app reports it as an out-of-date server rather than as missing household data.

The Solcast enhancement is split this way: the Solcast forecast itself is device-local and works without any server route, but the household profile it is compared against comes from `/api/mobile/load-planning-context`. If that route is missing, the forecast half succeeds while the app still shows no recommendation, because there is no baseline to compare it to.

## First-release behavior

- The native dashboard shows live solar, home, battery, and grid power; today’s energy totals; the active tariff; and the current bill estimate.
- The bill screen uses the dashboard’s shared response. Opening it does not trigger another request.
- The app restores a prior `site_auth` cookie by requesting `/api/sites` once at launch. It opens the secure pwusage sign-in flow only when that cookie is rejected or missing. Selected site is remembered on this device.
- On subsequent launches, the dashboard immediately restores the last successful site, live, and bill responses from a small Codable snapshot in the iOS caches directory, then validates the session and refreshes. Saved data remains visible offline with its original timestamps and a saved-data notice. Pull to refresh retries site validation after an offline launch. Snapshots are separated by API origin and site, pruned when site access changes, and cleared on sign-out or session expiry. iOS may evict this disposable cache.
- One app-owned coordinator requests live data at most every five minutes and the bill on three tiers: at most every 30 minutes on the foreground timer, at most every five minutes when the Load timing screen opens, and always on an explicit pull to refresh. It stops timers in the background, and before the coordinator is dropped on sign-out, and makes a due bill request after the live request, so a stale-history refresh is reflected in the bill.
- When the stored energy sample is over 30 minutes old, the mobile live endpoint asks the server to refresh it before responding. A per-site import lock limits these attempts to once every 30 minutes, and only a successful import rereads the energy buckets. Normal polls add no database read.
- A recent last-known battery charge may be shown with its source age; values older than two hours remain unknown (`--`). Source timestamps stay attached to readings. Missing energy data, expired sessions, and temporary server/network failures have separate states.
- The app is read-only. It has no battery controls, background refresh, widgets, or notifications.

SwiftUI previews under `PWUsage/Views/DashboardPreviews.swift` use fixed, local sample payloads for normal readings, no energy samples, stale source timestamps, an unavailable server, sign-in, and bill detail. The previews do not contact pwusage or a database.

The previews compiled as part of the simulator build, but they were not visually inspected in this run because the Mac UI session was locked.

Native sign-in requires the server’s mobile handoff migration to be deployed. The Solcast enhancement additionally requires `/api/mobile/load-planning-context` to be deployed; see [Server routes the app depends on](#server-routes-the-app-depends-on). Production deployment and real-device cookie renewal/logout checks remain release gates; they are intentionally outside this implementation task.

## Diagnosing an unavailable forecast

The Load timing screen shows one small note when the optional forecast cannot be used, and the note names the actual blocker rather than blaming the forecast in general. A "could not reach your server" note points at sign-in or connectivity; an "app build is newer than the server" note points at a deployment gap; notes naming household history describe the server’s 14-day window, which is a server-side data question rather than a device or Solcast one.

To investigate a household-data problem, query the real database rather than trusting a note:

```sh
cd cmd/next-app && npx tsx scripts/load-planning-context-capture.ts <siteId>
```

This runs the same query and the same profile builder as the route and prints the diagnostics the route hides: row counts, per-day coverage against the 90 percent gate, off-grid timestamps, and non-finite values. It prints no site name, no credentials, and no per-interval values, so it is safe against production data.
