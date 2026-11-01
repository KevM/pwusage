# App Store Screenshots Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One local command captures the App Store listing screenshots for iPhone 6.9" and iPad 13" from demo data, plus a separate lane to upload them.

**Architecture:** A DEBUG-only launch argument makes the app build a signed-in `PWUsageAppModel` on the existing preview fixtures instead of the real API. A new XCUITest target, run by fastlane `snapshot` through its own scheme, launches the app with that argument, navigates to each screen and calls `snapshot(...)`. Fastlane lanes wrap capture and a screenshots-only `deliver` upload.

**Tech Stack:** SwiftUI, XCTest UI tests, XcodeGen (`project.yml` → `generate.sh`), fastlane 2.24x (`snapshot`/`capture_screenshots`, `deliver`/`upload_to_app_store`).

**Spec:** `docs/superpowers/specs/2026-11-01-app-store-screenshots-design.md`

## Global Constraints

- iPhone device: `iPhone 17 Pro Max` (6.9", 1320×2868), portrait. iPad device: `iPad Pro 13-inch (M5)`, landscape.
- iPhone shots, in order: `01-home`, `02-home-today`, `03-bill`, `04-smart-shift`, `05-settings`. iPad shots: `01-home`, `03-bill`, `04-smart-shift`, `05-settings`.
- Light mode, status bar overridden (9:41, full signal/battery), language `en-US`.
- Demo data only; no network, no sign-in, no Live Activity starts.
- Screenshot-mode code compiles only under `#if DEBUG`; Release must not contain it.
- Output dir `cmd/ios-app/fastlane/screenshots/`, git-ignored.
- Lanes `screenshots` and `upload_screenshots` refuse to run on CI (`UI.user_error!` when `is_ci`, like `prepare_signing`).
- The new UI-test target is NOT part of the `PWUsage` scheme (so `run-tests.sh` and the release lane don't run it).
- iOS CI lint: `swiftformat --lint cmd/ios-app --config .swiftformat` and `swiftlint lint cmd/ios-app --strict --baseline .swiftlint-baseline.json` (both from repo root) clean; zero compiler warnings; `./run-tests.sh --quick` passes.
- Run `./generate.sh` after every `project.yml` change and commit the regenerated `PWUsage.xcodeproj`.

## Review Focus

1. **Shot taken before data loads** — screenshot shows a spinner or "Bill estimate is loading". Expect: the UI test waits for real content (bill amount, Today tiles) before each `snapshot`. Pinned by `waitForExistence` on identifiers in Task 3.
2. **Placeholder/prompt content in a shot** — "Demo utility", "Connect Solcast", "Energy data unavailable", empty Smart Shift. Expect: a healthy-looking home. Pinned by the unit test on the showcase site name/utility in Task 2 and the per-image inspection step in Task 4.
3. **Screenshot mode leaking into normal runs** — after a capture run, a normal Debug launch of the same simulator shows demo data or a selected-tab change. Expect: none; screenshot mode uses its own temp cache and a throwaway `UserDefaults` suite. Pinned by the Task 2 test that the model never writes to `.standard`.
4. **iPad orientation/layout** — iPad shot in portrait or with the one-column layout. Expect: landscape, two-column Home. Pinned by Task 4's dimension check (2752×2064).
5. **Wrong scroll position for `02-home-today`** — Today section partly off screen or live bar not pinned. Expect: Today header near the top, live bar showing. Pinned by Task 3's assertion that the Today section is hittable and the Live card isn't, plus Task 4 inspection.

---

### Task 1: Home cards use the tab icons

**Files:**
- Modify: `cmd/ios-app/PWUsage/Views/Home/dashboard-view.swift:181` and `:234`

**Interfaces:**
- Consumes: `AppTab.bill.systemImage` (`"receipt"`), `AppTab.smartShift.systemImage` (`"bolt.badge.clock"`) from `PWUsage/Navigation/app-tab.swift`.
- Produces: nothing new.

No unit test: this swaps two symbol literals for the `AppTab` source of truth; there is no logic to pin.

- [ ] **Step 1:** Replace `Image(systemName: "dollarsign.circle.fill")` with `Image(systemName: AppTab.bill.systemImage)` and `Image(systemName: "clock.arrow.circlepath")` with `Image(systemName: AppTab.smartShift.systemImage)`. Keep the existing font/colour/frame modifiers. Use `.symbolVariant(.fill)` on both only if it renders (check in the Xcode preview "Dashboard · Normal"); otherwise leave them unfilled.
- [ ] **Step 2:** Run `./run-tests.sh --quick` from `cmd/ios-app`. Expected: pass, no warnings.
- [ ] **Step 3:** Run both lint commands from the repo root. Expected: clean.
- [ ] **Step 4: Commit** — `fix(ios): Home summary cards use their tab icons`

---

### Task 2: DEBUG screenshot launch mode

**Files:**
- Create: `cmd/ios-app/PWUsage/App/screenshot-launch.swift` (whole file inside `#if DEBUG`)
- Modify: `cmd/ios-app/PWUsage/App/pwusage-app.swift` (`prepareLaunch`, top of the function)
- Test: `cmd/ios-app/PWUsageTests/screenshot-launch-tests.swift` (whole file inside `#if DEBUG`, like `PreviewFixtureTests` relies on the DEBUG fixtures)

**Interfaces:**
- Consumes: `DashboardPreviewAPI`, `MultiSitePreviewAPI`, `PWUsageAppModel.preview(api:tab:)` from `PWUsage/Views/Home/dashboard-previews.swift`.
- Produces:
  - `enum ScreenshotLaunch` with `static let argument = "-PWUsageScreenshotMode"`, `static func isRequested(in arguments: [String]) -> Bool`, `@MainActor static func makeModel() -> PWUsageAppModel`, `static let site: MobileSite`.
  - `ScreenshotLaunch.site` = `MobileSite(id: "preview-home", name: "Cedar House", utility: "Hill Country Electric")` (fictional utility; no "Demo" text on screen).
  - Accessibility identifier consumed by Task 3: none here.

- [ ] **Step 1: Write the failing tests** (`@MainActor @Suite("Screenshot launch")`):

```swift
@Test("Only the screenshot argument turns the mode on")
func detectsArgument() {
    #expect(ScreenshotLaunch.isRequested(in: ["app", "-PWUsageScreenshotMode"]))
    #expect(!ScreenshotLaunch.isRequested(in: ["app"]))
    #expect(!ScreenshotLaunch.isRequested(in: ["app", "-PWUsageScreenshotModeX"]))
}

@Test("The screenshot model is signed in on one realistic site, on Home")
func showcaseModel() async throws {
    let model = ScreenshotLaunch.makeModel()
    #expect(model.screenState == .signedIn)
    #expect(model.selectedTab == .home)
    #expect(model.sites == [ScreenshotLaunch.site])
    #expect(!ScreenshotLaunch.site.utility.localizedCaseInsensitiveContains("demo"))
    let coordinator = try #require(model.coordinator)
    coordinator.scenePhaseChanged(isActive: true)
    coordinator.authenticationRestored()
    await coordinator.refreshAll(trigger: .userGesture)
    #expect(coordinator.live.response?.site.name == "Cedar House")
    #expect(coordinator.bill.response?.currentBill.estimatedCost == 146.82)
}

@Test("The screenshot model never touches standard defaults")
func isolatedDefaults() {
    let key = PWUsageAppModel.selectedTabDefaultsKey
    let before = UserDefaults.standard.string(forKey: key)
    let model = ScreenshotLaunch.makeModel()
    model.selectedTab = .settings
    #expect(UserDefaults.standard.string(forKey: key) == before)
}
```

Adjust property names (`coordinator`, `bill.response`, `selectedTabDefaultsKey` visibility) to what `PreviewFixtureTests.multiSitePreviewModelLoadsEachSite` already uses; keep the assertions.

- [ ] **Step 2:** `./run-tests.sh --quick` — Expected: FAIL, `ScreenshotLaunch` not found.
- [ ] **Step 3: Implement `ScreenshotLaunch`.** `makeModel()` returns `PWUsageAppModel.preview(api: MultiSitePreviewAPI(sites: [site]), tab: .home)` — that helper already uses a throwaway defaults suite and temp cache. `isRequested` is an exact `contains(argument)`.
- [ ] **Step 4: Wire launch.** First statement of `PWUsageApp.prepareLaunch()`:

```swift
#if DEBUG
    if ScreenshotLaunch.isRequested(in: ProcessInfo.processInfo.arguments) {
        return .ready(ScreenshotLaunch.makeModel())
    }
#endif
```

This skips `AppLaunchMaintenance` (credential sweep, cookie clear) and the Live Activity coordinator (`liveActivities` stays nil). Check `PWUsageRootView`'s `.environment(model.liveActivities)` compiles/behaves with nil — the preview path already does this; if not, mirror whatever the `#Preview`s in `app-tab-view.swift` do.
- [ ] **Step 5:** `./run-tests.sh --quick` — Expected: PASS.
- [ ] **Step 6:** Release still builds without the mode: `xcodebuild -project PWUsage.xcodeproj -scheme PWUsage -configuration Release -destination 'generic/platform=iOS Simulator' build CODE_SIGNING_ALLOWED=NO | tail -3` — Expected: `BUILD SUCCEEDED`, and `grep -c PWUsageScreenshotMode` on the built binary under DerivedData is `0`.
- [ ] **Step 7:** Lint (both). Clean.
- [ ] **Step 8: Commit** — `feat(ios): DEBUG screenshot launch mode on demo data`

---

### Task 3: Screenshot UI test target

**Files:**
- Modify: `cmd/ios-app/project.yml` — new target + new scheme
- Create: `cmd/ios-app/PWUsageScreenshots/AppStoreScreenshots.swift`
- Create: `cmd/ios-app/PWUsageScreenshots/SnapshotHelper.swift` (generated by fastlane, see Step 2)
- Modify: `cmd/ios-app/PWUsage/Views/Home/dashboard-view.swift` — accessibility identifiers
- Modify: `.swiftlint.yml` (`excluded:` add `cmd/ios-app/PWUsageScreenshots/SnapshotHelper.swift`) and `.swiftformat` (`--exclude` the same path) — vendored file
- Regenerate: `cmd/ios-app/PWUsage.xcodeproj`

**Interfaces:**
- Consumes: `ScreenshotLaunch.argument` value `"-PWUsageScreenshotMode"` (UI tests can't import the app; repeat the string literal).
- Produces:
  - Target `PWUsageScreenshots` (`type: bundle.ui-testing`, `platform: iOS`, `PRODUCT_BUNDLE_IDENTIFIER: fm.rodeo.pwusage.screenshots`, `CODE_SIGN_STYLE: Automatic`, dependency on `PWUsage`, `TEST_TARGET_NAME: PWUsage`).
  - Scheme `PWUsageScreenshots` (build `PWUsage`, test target `PWUsageScreenshots`). The `PWUsage` scheme's `test.targets` stays `[PWUsageTests]`.
  - Identifiers in `dashboard-view.swift`: `home.live` on the Live section, `home.today` on the Today section, `home.bill.amount` on the bill amount `Text`.
  - Test methods (fastlane runs the class): `testIPhoneShots()`, `testIPadShots()` — each `XCTSkip`s on the other idiom.

- [ ] **Step 1:** Add target and scheme to `project.yml`; `./generate.sh`; confirm `xcodebuild -list -project PWUsage.xcodeproj` shows scheme `PWUsageScreenshots`.
- [ ] **Step 2:** From `cmd/ios-app`, `bundle exec fastlane snapshot init` writes `fastlane/SnapshotHelper.swift` and a sample `Snapfile`; move the helper to `PWUsageScreenshots/SnapshotHelper.swift`, delete the sample Snapfile (Task 4 writes the real one). Add the lint excludes.
- [ ] **Step 3: Add identifiers** on the three views listed above.
- [ ] **Step 4: Write the UI test.** `setUp`: `continueAfterFailure = false`; on iPad set `XCUIDevice.shared.orientation = .landscapeLeft` before launch; `app.launchArguments += ["-PWUsageScreenshotMode"]`; `setupSnapshot(app)`; `app.launch()`. Wait `app.staticTexts["home.bill.amount"].waitForExistence(timeout: 15)` before the first shot. Navigate tabs by label (`"Bill"`, `"Smart Shift"`, `"Settings"`) — on iPad landscape the tab may be in a top tab bar or sidebar; find it with `app.buttons[label]` falling back to `app.tabBars.buttons[label]`. Before each tab shot, wait for one known element on that screen (pick a stable text the preview fixture renders, e.g. the bill total `"$146.82"`).
  iPhone `02-home-today`: swipe up on the scroll view until `app.otherElements["home.today"]` (or `.descendants(matching: .any)["home.today"]`) is hittable and `home.live` is not hittable; cap at 6 swipes and `XCTFail` otherwise. Use slow `press(forDuration:thenDragTo:)` drags if `swipeUp` overshoots.
  Names exactly as Global Constraints. Scroll back is unnecessary — the next shot is a different tab.
- [ ] **Step 5: Run it on iPhone**: `xcodebuild test -project PWUsage.xcodeproj -scheme PWUsageScreenshots -destination 'platform=iOS Simulator,name=iPhone 17 Pro Max' | tail -5` — Expected: `TEST SUCCEEDED` (helper no-ops `snapshot` outside fastlane but still runs navigation and waits).
- [ ] **Step 6: Run it on iPad**: same with `name=iPad Pro 13-inch (M5)`. Expected: `TEST SUCCEEDED`.
- [ ] **Step 7:** `./run-tests.sh --quick` still runs only `PWUsageTests` and passes; lint clean.
- [ ] **Step 8: Commit** — `test(ios): App Store screenshot UI test target`

---

### Task 4: Fastlane lanes, capture, and inspection

**Files:**
- Create: `cmd/ios-app/fastlane/Snapfile`
- Modify: `cmd/ios-app/fastlane/Fastfile` — lanes `screenshots`, `upload_screenshots`
- Modify: `.gitignore` (root) — add `cmd/ios-app/fastlane/screenshots/` and `cmd/ios-app/fastlane/test_output/`
- Modify: `cmd/ios-app/README.md` — short "App Store screenshots" section
- Possibly modify: `cmd/ios-app/PWUsage/App/screenshot-launch.swift` / fixtures if inspection finds bad content

**Interfaces:**
- Consumes: scheme `PWUsageScreenshots` (Task 3), `connect_key` private lane (existing).
- Produces: `bundle exec fastlane ios screenshots`, `bundle exec fastlane ios upload_screenshots`.

- [ ] **Step 1: Snapfile**: `project("./PWUsage.xcodeproj")`, `scheme("PWUsageScreenshots")`, `devices(["iPhone 17 Pro Max", "iPad Pro 13-inch (M5)"])`, `languages(["en-US"])`, `output_directory("./fastlane/screenshots")`, `clear_previous_screenshots(true)`, `override_status_bar(true)`, `dark_mode(false)`, `skip_open_summary(true)`, `concurrent_simulators(false)`, `stop_after_first_error(true)`.
- [ ] **Step 2: Lanes** in the `platform :ios` block. `screenshots`: CI guard, `sh(File.join(PWUSAGE_ROOT, "generate.sh"))`, `capture_screenshots`. `upload_screenshots`: CI guard, `upload_to_app_store(api_key: connect_key, app_identifier: PWUSAGE_BUNDLE_ID, screenshots_path: File.join(PWUSAGE_ROOT, "fastlane", "screenshots"), overwrite_screenshots: true, skip_binary_upload: true, skip_metadata: true, skip_app_version_update: true, submit_for_review: false, force: true, precheck_include_in_app_purchases: false, run_precheck_before_submit: false)`. Do not call it from `archive`/release lanes.
- [ ] **Step 3: Capture**: `cd cmd/ios-app && bundle exec fastlane ios screenshots`. Expected: lane succeeds; `fastlane/screenshots/en-US/` holds 9 PNGs.
- [ ] **Step 4: Check dimensions**: `sips -g pixelWidth -g pixelHeight fastlane/screenshots/en-US/*.png`. Expected: iPhone files 1320×2868; iPad files 2752×2064 (landscape). Any other size → fix device/orientation.
- [ ] **Step 5: Inspect every image** (open with Read). Each must show: Cedar House, filled data, no spinner, no "Demo", no "Connect Solcast"/"unavailable"/empty states, the new Home card icons, clean status bar. `02-home-today` shows the pinned live bar with Today, Current bill and Smart Shift cards. If a screen shows a prompt or empty state because the preview model has no forecast service or load-planning context, extend the screenshot model (Task 2 file) with the minimum fixture to make it render healthy — e.g. a seeded forecast — keep it `#if DEBUG`, add a unit test for the new fixture property, re-run Steps 3–5.
- [ ] **Step 6: Upload lane sanity** (no upload): `bundle exec fastlane lanes` lists both lanes. Upload itself is verified by the user later.
- [ ] **Step 7: README section** — the two commands, where output lands, that capture runs locally on demo data, and that `upload_screenshots` replaces the listing's screenshots.
- [ ] **Step 8:** `./run-tests.sh --quick`, both lints, `git status` shows no files under `fastlane/screenshots/`.
- [ ] **Step 9: Commit** — `feat(ios): fastlane lanes to capture and upload App Store screenshots`
