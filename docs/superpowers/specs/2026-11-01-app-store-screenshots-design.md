# App Store screenshot automation — design

## Intent

pwusage is about to ship on the App Store for iPhone and iPad (the iPad build is
also how it reaches the Mac, as "Designed for iPad"). App Store Connect needs
listing screenshots for both device families, and they go stale every time the
UI changes. One local command should regenerate the whole set from demo data so
refreshing the listing is cheap and never exposes a real home's data.

## Goals

- One command on the developer's Mac, `bundle exec fastlane ios screenshots`,
  captures the full set for both devices.
- iPhone: five portrait shots, in this listing order:
  1. Home, top of the view.
  2. Home, scrolled to "Today so far": the live top bar pinned, with the Current
     bill and Smart Shift summary cards visible.
  3. Current bill tab.
  4. Smart Shift tab.
  5. Settings tab.
- iPad: four **landscape** shots — Home (one shot; the regular-width two-column
  grid already shows Live, Today, Bill and Smart Shift together), Current bill,
  Smart Shift, Settings. The user chose this; landscape also reads like a Mac
  window, and the Mac ("Designed for iPad") listing reuses these images.
- Devices: iPhone 6.9" (iPhone 17 Pro Max, 1320×2868) and iPad 13"
  (iPad Pro 13-inch (M5)). Both are required by App Store Connect for a
  universal app.
- Light mode, clean status bar (9:41, full signal, full battery).
- Demo data only — the shared preview fixtures (`DashboardPreviewAPI`,
  `MultiSitePreviewAPI`, `PWUsageAppModel.preview`), no sign-in, no network.
- Output to `cmd/ios-app/fastlane/screenshots/`, git-ignored, laid out the way
  `deliver` expects.
- A separate `upload_screenshots` lane that uploads only those files to App
  Store Connect (no binary, no metadata, replacing existing screenshots), so it
  can later be folded into the release lane with one call.

## Non-goals

- Device frames, captions or marketing backgrounds (maybe later).
- Dark mode, other locales, other device sizes.
- Running capture on CI or as part of every release.
- Visual regression testing.

## Anti-goals

- Any real user, site, token or energy data in a screenshot.
- Demo-mode code reachable in a Release/App Store build.
- Screenshot mode causing side effects on the Simulator or a server: no Tesla
  or pwusage API calls, no Live Activity starts, no background task
  registration effects that matter, no keychain/credential writes that leak
  into a normal Debug run afterwards.
- Flaky captures: a shot that lands mid-animation, mid-load, or scrolled to the
  wrong spot. The UI test should wait on content, not sleep.

## Prerequisite change (do first)

Home's summary cards use different SF Symbols than the tabs they open. Make the
cards use the tab symbols, sourced from `AppTab` so they cannot drift again:

- Current bill card: `dollarsign.circle.fill` → `AppTab.bill.systemImage`
  (`receipt`) — `PWUsage/Views/Home/dashboard-view.swift:181`.
- Smart Shift card: `clock.arrow.circlepath` → `AppTab.smartShift.systemImage`
  (`bolt.badge.clock`) — `dashboard-view.swift:234`.

The user chose the tab icons. Whether the card uses a `.fill` variant is the
builder's call, matching the card's existing visual weight.

## How it is built (decided)

- **Approach:** drive the real app in the Simulator with a UI test and
  fastlane `snapshot` (`capture_screenshots`), not in-process rendering — the
  listing needs real status bar and navigation chrome. `snapshot` also
  provides the status bar override and the `deliver` folder layout.
- **New UI test target** (e.g. `PWUsageScreenshots`) defined in `project.yml`
  (the project is XcodeGen-generated via `generate.sh`), with a scheme or
  scheme test plan that `snapshot` runs. It must not run as part of the
  existing unit test scheme/`run-tests.sh` or the release lane's test step.
- **Demo launch:** the UI test launches the app with a launch argument
  (e.g. `-PWUsageScreenshotMode`). In a DEBUG build the app's launch path
  recognises it and builds a `PWUsageAppModel` on the preview fixtures instead
  of the real API, skipping startup maintenance and other side-effecting setup.
  The flag and the fixtures stay inside `#if DEBUG`, so Release is unaffected.
- **Lanes:** `screenshots` (capture) and `upload_screenshots` (deliver,
  screenshots only, `overwrite_screenshots`, `skip_binary_upload`,
  `skip_metadata`, existing ASC API key via `connect_key`). Both refuse to run
  on CI, like `prepare_signing`.
- Add `cmd/ios-app/fastlane/screenshots/` to the root `.gitignore`.

## Left to the builder

- Exact launch-argument name, and where in `PWUsageApp.prepareLaunch` the
  branch lives.
- Whether the existing preview fixtures already render all five screens
  convincingly (Bill, Smart Shift with a forecast verdict, Settings with a
  plausible site/solar setup) or need a dedicated "showcase" fixture. Shots
  should look like a healthy, real-looking home on a sunny day, with nothing
  empty, stale, errored or "Connect Solcast"-style prompting.
- How the UI test reaches each screen (tab bar on iPhone vs sidebar/tab
  presentation on iPad), how it sets landscape on iPad, and how it scrolls to
  "Today so far" deterministically on iPhone only (accessibility identifiers
  are fine to add).
- Fixed clock/time for the demo data if needed so charts look full and
  consistent run to run.
- Snapfile contents (devices, `clear_previous_screenshots`, `override_status_bar`,
  `skip_open_summary`, language `en-US`).
- A short "Screenshots" section in `cmd/ios-app/README.md` with the two
  commands.
- iOS CI lint rules apply: `swiftformat --lint` and `swiftlint --strict` clean,
  zero compiler warnings, existing tests still pass.

## Update: iPhone Duo and CI

App Store Connect now has an `APP_IPHONE_DUO` screenshot set (2007×2853 or
2853×2007 for the inner display; 1398×2034 for the folded cover). The Duo needs
its own capture path because the pose is a Device Hub control with no
`simctl`/`devicectl` command, and `snapshot` shuts every simulator down and
boots it folded. The lane uses `baguette hinge --pose open`, which dispatches
the same vendor HID event from inside the guest and needs no GUI or
accessibility permission, then runs `testDuoShots` against the lit inner
display. `SnapshotHelper` picks the screen whose size matches the app window, so
the capture follows the lit panel; the flatten step removes its alpha and scales
the one-pixel rounding to the accepted size. A manual
`.github/workflows/ios-screenshots.yml` workflow runs the lane on GitHub Actions
and uploads the images as artifacts. This supersedes the original local-only and
iPhone/iPad-only scope.
