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

## First-release behavior

- The native dashboard shows live solar, home, battery, and grid power; today’s energy totals; the active tariff; and the current bill estimate.
- The bill screen uses the dashboard’s shared response. Opening it does not trigger another request.
- The app restores a prior `site_auth` cookie by requesting `/api/sites` once at launch. It opens the secure pwusage sign-in flow only when that cookie is rejected or missing. Selected site is remembered on this device.
- One app-owned coordinator requests live data at most every five minutes and the bill at most every 30 minutes while the app is foregrounded. It stops timers in the background and makes a due bill request after the live request, so a stale-history refresh is reflected in the bill.
- When the stored energy sample is over 30 minutes old, the mobile live endpoint asks the server to refresh it before responding. A per-site import lock limits these attempts to once every 30 minutes, and only a successful import rereads the energy buckets. Normal polls add no database read.
- A recent last-known battery charge may be shown with its source age; values older than two hours remain unknown (`--`). Source timestamps stay attached to readings. Missing energy data, expired sessions, and temporary server/network failures have separate states.
- The app is read-only. It has no battery controls, background refresh, widgets, or notifications.

SwiftUI previews under `PWUsage/Views/DashboardPreviews.swift` use fixed, local sample payloads for normal readings, no energy samples, stale source timestamps, an unavailable server, sign-in, and bill detail. The previews do not contact pwusage or a database.

The previews compiled as part of the simulator build, but they were not visually inspected in this run because the Mac UI session was locked.

Native sign-in requires the server’s mobile handoff migration to be deployed. Production deployment and real-device cookie renewal/logout checks remain release gates; they are intentionally outside this implementation task.
