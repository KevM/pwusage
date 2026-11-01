# iOS Demo Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Release-shipped, read-only demo of the app on an anonymized sample home, entered from the sign-in screen, so App Review (no Tesla account) can use the app.

**Architecture:** A second, in-memory `PWUsageAppModel` (flagged `isDemo`) backed by a network-free `DemoAPI` whose fixtures are built relative to the real "now". The app holds it in a `DemoModeController`; while it exists the root view renders it instead of the real model, which is never touched. The DEBUG screenshot run becomes a second caller of the same factory.

**Tech Stack:** Swift 6, SwiftUI, Swift Testing, XcodeGen (`project.yml` picks up new files under `PWUsage/` automatically; run `./generate.sh`).

**Spec:** `docs/superpowers/specs/2026-11-01-ios-demo-mode-design.md`

**Base:** stacked on PR #273 (`ios-app-store-screenshots`). Rebase onto `main` once it merges; nothing here depends on unmerged work beyond #273.

## Global Constraints

- Demo code ships in Release: nothing under `PWUsage/Demo/` is wrapped in `#if DEBUG`. The `-PWUsageScreenshotMode` launch argument (`ScreenshotLaunch`) stays DEBUG-only.
- Demo mode makes **no network calls** (PWUsage server, Tesla, APNs, CloudKit) and writes nothing outside its own `UserDefaults` suite `pwusage.demo` and a temp folder.
- Never write to `BatteryHoldControlSiteStore`, `.standard` defaults, the persistent `DashboardCache`, or CloudKit from demo.
- Demo is never persisted: relaunch always lands on sign-in.
- No Harrison identifiers in shipped code: not the name "Harrison", not site ID `2252268092126997`, no coordinates, no utility "We Energies".
- Copy (exact): sign-in button **"Try the demo"**; bar **"In Demo Mode"**; sheet body **"You're looking at a sample home, not your own."**; sheet buttons **"Sign in with Tesla"** / **"Keep exploring"**; Settings row **"Exit Demo"**.
- Demo rates (exact): On-peak buy **0.31**, sell **0.04**; Off-peak buy **0.10**, sell **0.03**. Site **"Cedar House"**, utility **"Hill Country Electric"**, timezone **America/Chicago**.
- iOS CI: `swiftformat --lint` and `swiftlint --strict` clean, **zero compiler warnings**. Tests via `cd cmd/ios-app && PWUSAGE_TEST_TIMEOUT_SECONDS=240 ./run-tests.sh --quick [-only-testing:PWUsageTests/<Suite>]`.

## Review Focus

1. **External launch while in demo** (Control Center control, App Intent, `pwusage://` URL, `/continue` QR, notification tap): must show the demo sheet and never navigate to or load a real site. → Task 5 test `externalNavigationShowsDemoSheet`.
2. **Leaving the demo restores the exact sign-in state** (including an expired-session message): the real model's `screenState` and `signInMessage` are unchanged. → Task 4 test `exitRestoresRealSignInState`.
3. **Opening the demo at an odd hour** (Sunday 23:30 Chicago): On-peak is still active and waiting is still cheaper. → Task 1 test `peakIsActiveAtAnyHour`.
4. **A simulated hold left running** past its end time: the card returns to idle on the next refresh. → Task 2 test `holdExpiresOnItsOwn`.
5. **Relaunch after a demo session**: no demo state survives; the `pwusage.demo` suite is empty after exit. → Task 4 test `exitLeavesNoDemoState`.

---

### Task 1: Demo fixtures (Release)

**Files:**
- Create: `cmd/ios-app/PWUsage/Demo/demo-fixtures.swift`
- Create: `cmd/ios-app/PWUsage/Demo/demo-forecast-store.swift`
- Test: `cmd/ios-app/PWUsageTests/DemoFixturesTests.swift`

**Interfaces:**
- Produces:
  - `enum DemoFixtures` with `static let site: MobileSite` (id `"demo-home"`, `"Cedar House"`, `"Hill Country Electric"`), `static let timeZone = TimeZone(identifier: "America/Chicago")!`
  - `static func live(asOf: Date) throws -> MobileLiveResponse`
  - `static func bill(asOf: Date) throws -> MobileBillResponse` (includes `loadTiming` and `outlook`)
  - `static func planningContext(asOf: Date) -> MobileLoadPlanningContextResponse`
  - `static func tariffs() throws -> MobileTariffsResponse`
  - `actor DemoForecastStore: SolarForecastManaging` with `init(now: Date)` — same behavior as `PreviewForecastStore(mode: .combinedArrays, now:)` in `PWUsage/Views/Solar/solar-forecast-previews.swift:30`.

Build JSON the way `DashboardPreviewAPI` does (`PWUsage/Views/Home/dashboard-previews.swift:33-118`) and decode with `MobileContractDecoder.make()`; keep its two load-bearing rules: floor `asOf` to whole seconds, and start `tariffTimeline` exactly at the balance source instant with fractional-second ISO timestamps.

Scenario values (Harrison-shaped):
- `cycleEnd` = start of the local day (Chicago) of `asOf` + 10 days; `cycleStart` = `cycleEnd` − 1 month.
- `tariffTimeline`: On-peak (0.31/0.04) from source instant to `asOf + 3h`, then alternating Off-peak (0.10/0.03) 12h / On-peak 12h for 7 days. Active period On-peak; `nextCheaper` Off-peak at 0.10, phrase `"in 3 hours"`.
- On-peak cycle balance negative (net buyer → marginal cost 0.31, basis `buy`); Off-peak balance positive (marginal 0.10 or sell-based 0.03 — either keeps waiting cheaper).
- Live: solar ~3.9 kW, home ~1.4 kW, battery charging, SOC 64, `activeTariff` "Residential · Time of use".
- Bill: about $118 so far across On-peak, Off-peak and solar-credit periods; `outlook.points` daily from `cycleStart` to `asOf`, `observedThrough` = source instant, `complete: false`, so the Bill tab shows a forecast to cycle end.
- Planning context: 48 slots with an evening-peaked household shape (higher 17:00–21:00), 14 usable days.

- [ ] **Step 1: Write failing tests** in `DemoFixturesTests` (`@Suite("Demo fixtures")`, `@MainActor`):
  - `decodesAll`: all four builders succeed for `asOf = .now`.
  - `cycleHasTenDaysLeft`: `Calendar(chicago).dateComponents([.day], from: startOfDay(asOf), to: bill.currentBill.cycleEnd).day == 10`.
  - `peakIsActiveAtAnyHour`: for `asOf` = 2026-11-01 23:30 America/Chicago (a Sunday) and 2026-11-03 14:00, the timeline segment containing `asOf` has `name == "On-peak"`, `buyRate == 0.31`, and `loadTiming.nextCheaper?.marginalCost == 0.10`.
  - `waitingIsCheaper`: active period marginal cost (0.31) > `nextCheaper` marginal cost.
  - `outlookForecastsToCycleEnd`: `bill.outlook != nil`, `observedThrough <= asOf`, `complete == false`.
  - `isAnonymized`: encode all four responses to JSON; the text contains none of `"Harrison"`, `"2252268092126997"`, `"We energies"` (case-insensitive), `"latitude"`, `"longitude"`.
- [ ] **Step 2: Run** `./run-tests.sh --quick -only-testing:PWUsageTests/DemoFixturesTests` — expect compile failure (`DemoFixtures` undefined).
- [ ] **Step 3: Implement** `DemoFixtures` and `DemoForecastStore` per the values above (`./generate.sh` first so XcodeGen adds the folder).
- [ ] **Step 4: Run** the same command — expect PASS.
- [ ] **Step 5: Commit** `feat(ios): Release demo fixtures modeled on a Time-of-Use home`.

### Task 2: `DemoAPI` with an in-memory battery hold

**Files:**
- Create: `cmd/ios-app/PWUsage/Demo/demo-api.swift`
- Test: `cmd/ios-app/PWUsageTests/DemoAPITests.swift`

**Interfaces:**
- Consumes: `DemoFixtures` (Task 1).
- Produces: `@MainActor final class DemoAPI: PWUsageApplicationAPI, MobileBatteryHoldDataAPI, MobileTariffDataAPI` with `init(now: @escaping () -> Date = Date.init)` and `let launchedAt: Date` (= `floor(now())` − 120 s, the screenshot run's rule so minute timelines never read "in the future"). `fetchSolarHistory` returns `.disabled`; `exchangeSession`, `logout`, `clearSiteAuthCookie` are no-ops; `fetchSites` returns `[DemoFixtures.site]`.

Hold semantics (mirror `BatteryHoldPreviewAPI.sendBatteryHoldCommand`, `PWUsage/Views/BatteryHold/battery-hold-preview-api.swift:39-55`): `.park(choice)` creates an active hold (original reserve 20, target `choice.reserveChoice ?? 80`), `safetyExpiresAt = now + (timer ? durationHours : 8) h`; `.restore` clears it; `.dismiss` clears the notice. `fetchBatteryHold` returns no hold once `now() >= safetyExpiresAt`.

- [ ] **Step 1: Write failing tests** (`@Suite("Demo API")`, injected clock `var clock = Date(...)`, `DemoAPI(now: { clock })`):
  - `servesDemoSite`: `fetchSites() == [DemoFixtures.site]`; `fetchBill(siteID:)` site name `"Cedar House"`.
  - `parkStartsHold`: `.park(timer, 2h)` → `fetchBatteryHold().hold?.status == .active`, expires at `clock + 2h`.
  - `restoreEndsHold`: after `.restore`, `fetchBatteryHold().hold == nil`.
  - `holdExpiresOnItsOwn`: park 1 h, set `clock += 3601`, `fetchBatteryHold().hold == nil`.
  - `autoHoldLastsEightHours`: `.park(auto)` expires at `clock + 8h`.
- [ ] **Step 2: Run** `./run-tests.sh --quick -only-testing:PWUsageTests/DemoAPITests` — expect FAIL.
- [ ] **Step 3: Implement** `DemoAPI`.
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** `feat(ios): network-free demo API with a simulated battery hold`.

### Task 3: `DemoSession` factory; screenshot run reuses it

**Files:**
- Create: `cmd/ios-app/PWUsage/Demo/demo-session.swift`
- Modify: `cmd/ios-app/PWUsage/App/pwusage-app-model.swift:64-80` (add `isDemo: Bool = false` init parameter → `let isDemo: Bool`)
- Modify: `cmd/ios-app/PWUsage/App/screenshot-launch.swift` (`makeModel()` → `DemoSession.makeModel()`; drop its `API`, `Solar`, `site`; `site` becomes `DemoFixtures.site`)
- Test: `cmd/ios-app/PWUsageTests/DemoSessionTests.swift`; update `cmd/ios-app/PWUsageTests/screenshot-launch-tests.swift`

**Interfaces:**
- Consumes: `DemoAPI`, `DemoFixtures`, `DemoForecastStore`.
- Produces: `enum DemoSession { static let defaultsSuiteName = "pwusage.demo"; @MainActor static func makeModel() -> PWUsageAppModel; static func tearDown() }`. `makeModel` follows `ScreenshotLaunch.makeModel()` (fresh suite cleared first, temp folder cache seeded with the site, solar stores in the temp folder, `SolarLayoutCloudSync(transport: nil)`, coordinator with `timerInterval: nil`, `accountScopeID: "demo-account"`) and passes `isDemo: true`, `controlSiteStore: nil`, `liveActivities: nil`, `forecastService: nil`, and a `AppConfiguration` that doesn't require DEBUG (use the bundle's configuration; the API never reaches it). `tearDown()` removes the suite's persistent domain and the temp folder.

- [ ] **Step 1: Write failing tests** (`@Suite("Demo session")`):
  - `signedInOnDemoSite`: `makeModel()` → `screenState == .signedIn`, `isDemo`, `sites == [DemoFixtures.site]`, `selectedTab == .home`, `controlSiteStore == nil`, `liveActivities == nil`.
  - `leavesStandardDefaultsAlone`: snapshot `UserDefaults.standard.dictionaryRepresentation()` keys before/after `makeModel()` + a `refreshAll` → identical.
  - `tearDownEmptiesSuite`: after `makeModel()` then `tearDown()`, `UserDefaults(suiteName: "pwusage.demo")!.dictionaryRepresentation()` has no `PWUsageAppModel.selectedTabDefaultsKey`.
  - Screenshot tests: `ScreenshotLaunch.makeModel().isDemo == true`; site is `DemoFixtures.site`.
- [ ] **Step 2: Run** `./run-tests.sh --quick -only-testing:PWUsageTests/DemoSessionTests -only-testing:PWUsageTests/ScreenshotLaunchTests` — expect FAIL.
- [ ] **Step 3: Implement** `DemoSession`, the `isDemo` parameter, and the `ScreenshotLaunch` delegation.
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** `feat(ios): demo session factory shared with the screenshot run`.

### Task 4: Enter and exit from the sign-in screen

**Files:**
- Create: `cmd/ios-app/PWUsage/Demo/demo-mode-controller.swift`
- Modify: `cmd/ios-app/PWUsage/App/pwusage-app.swift:101-130` (hold `@StateObject var demo = DemoModeController()`; render `PWUsageRootView` with `demo.model ?? model`; set `.environment(\.demoMode, …)`; `PWUsageCommands(model:)` gets the active model)
- Modify: `cmd/ios-app/PWUsage/App/pwusage-root-view.swift:18-25` (pass `onTryDemo` to the `.signedOut` `SignInView` only — not the expired-session one)
- Modify: `cmd/ios-app/PWUsage/Views/Auth/sign-in-view.swift` (add `var onTryDemo: (() -> Void)? = nil`; a secondary `"Try the demo"` button below the sign-in button, hidden while `isWorking`)
- Test: `cmd/ios-app/PWUsageTests/DemoModeControllerTests.swift`

**Interfaces:**
- Consumes: `DemoSession`.
- Produces:
  - `@MainActor final class DemoModeController: ObservableObject { @Published private(set) var model: PWUsageAppModel?; func start(); func exit() }` — `start` builds `DemoSession.makeModel()` (no-op if already running); `exit` drops it and calls `DemoSession.tearDown()`.
  - `struct DemoModeActions { let start: () -> Void; let exit: () -> Void; let exitAndSignIn: () -> Void }` and `EnvironmentValues.demoMode: DemoModeActions?` (nil = not available). `exitAndSignIn` = `exit()` then `Task { await realModel.signIn() }`.

- [ ] **Step 1: Write failing tests** (`@Suite("Demo mode controller")`):
  - `startBuildsDemoModel`: `start()` → `model?.isDemo == true`; calling `start()` again keeps the same instance.
  - `exitLeavesNoDemoState`: `start(); exit()` → `model == nil`; `pwusage.demo` suite has no `selectedTabDefaultsKey`.
  - `exitRestoresRealSignInState`: a real `PWUsageAppModel` built with a stub API in `.signedOut` with `signInMessage = "Your session expired. Sign in to continue."`; `start(); exit()` → real model's `screenState == .signedOut` and `signInMessage` unchanged (the controller never touches it).
- [ ] **Step 2: Run** `./run-tests.sh --quick -only-testing:PWUsageTests/DemoModeControllerTests` — expect FAIL.
- [ ] **Step 3: Implement** the controller, environment value, `PWUsageApp` wiring and the sign-in button.
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** `feat(ios): try the demo from the sign-in screen`.

### Task 5: Demo bar, sheet, Exit Demo, and the external-launch guard

**Files:**
- Create: `cmd/ios-app/PWUsage/Demo/demo-mode-bar.swift` (`DemoModeBar`, `DemoModeSheet`)
- Modify: `cmd/ios-app/PWUsage/Navigation/app-tab-view.swift:29` (`.safeAreaInset(edge: .bottom, spacing: 0) { if model.isDemo { DemoModeBar … } }` on the `TabView`; `.sheet(isPresented: $model.isDemoSheetPresented) { DemoModeSheet }`; Settings gets `onExitDemo` when `model.isDemo`)
- Modify: `cmd/ios-app/PWUsage/Views/Settings/settings-view.swift:45-50` (add `var onExitDemo: (() -> Void)? = nil`; when set, show `Button("Exit Demo")` with no confirmation instead of Sign Out)
- Modify: `cmd/ios-app/PWUsage/App/pwusage-app-model-navigation.swift:31` (`openNavigationURL`: `if isDemo { dismissCompetingPresentations(); isDemoSheetPresented = true; return }` first) and `PWUsageAppModel` (`@Published var isDemoSheetPresented = false`)
- Test: `cmd/ios-app/PWUsageTests/DemoNavigationTests.swift`

**Interfaces:**
- Consumes: `DemoModeActions` via `@Environment(\.demoMode)`; `PWUsageAppModel.isDemo`.
- Produces: `struct DemoModeBar: View { let onTap: () -> Void }` — full-width, `Color.accentColor` fill, white `"In Demo Mode"` centered, `.accessibilityAddTraits(.isButton)`, hint "Shows options for leaving the demo". `struct DemoModeSheet: View { let onSignIn: () -> Void; let onKeepExploring: () -> Void }` with the exact copy from Global Constraints, `.presentationDetents([.medium])`.

- [ ] **Step 1: Write failing tests** (`@Suite("Demo navigation")`, model from `DemoSession.makeModel()`):
  - `externalNavigationShowsDemoSheet`: for `BatteryHoldLink` URL of a real-looking site `"site-123"` and `DashboardLink.url`, `await openNavigationURL(url)` → `isDemoSheetPresented == true`, `pendingBatteryHoldSiteID == nil`, `selectedSiteID == DemoFixtures.site.id`, `batteryHoldNavigationMessage == nil`.
  - `nonDemoNavigationUnchanged`: covered by existing `PWUsageAppModelTests` navigation tests — run them.
- [ ] **Step 2: Run** `./run-tests.sh --quick -only-testing:PWUsageTests/DemoNavigationTests` — expect FAIL.
- [ ] **Step 3: Implement** the guard, bar, sheet and Settings row. Sheet "Sign in with Tesla" calls `demoMode?.exitAndSignIn()`; Settings "Exit Demo" calls `demoMode?.exit()`.
- [ ] **Step 4: Run** `./run-tests.sh --quick -only-testing:PWUsageTests/DemoNavigationTests -only-testing:PWUsageTests/PWUsageAppModelTests` — expect PASS.
- [ ] **Step 5: Commit** `feat(ios): In Demo Mode bar, exit sheet and external-launch guard`.

### Task 6: Verify end to end

- [ ] **Step 1:** `cd cmd/ios-app && ./format.sh` then `swiftformat --lint . && swiftlint --strict` — clean.
- [ ] **Step 2:** `PWUSAGE_TEST_TIMEOUT_SECONDS=600 ./run-tests.sh` (all default suites) — all pass, zero warnings in the build log.
- [ ] **Step 3:** Release build for the simulator; confirm `strings` on the binary contains `"Try the demo"` and does **not** contain `PWUsageScreenshotMode`.
- [ ] **Step 4:** On an iPhone simulator, Release config, signed out: tap **Try the demo** → Home shows Cedar House with the bar; Bill shows ~10 days left and a forecast; Smart Shift's car job recommends waiting with a saving; start a 1-hour hold, switch tabs, stop it; tap the bar → sheet → Keep exploring; Settings → Exit Demo → sign-in screen; open the demo again, kill and relaunch the app → sign-in screen. Screenshot each and attach to the PR.
- [ ] **Step 5:** Same on an iPad simulator (landscape): bar sits at the bottom and doesn't cover the sidebar or content.
- [ ] **Step 6:** `bundle exec fastlane ios screenshots` still produces 9 PNGs; inspect that they show the demo scenario.
- [ ] **Step 7:** Update `cmd/ios-app/README.md` (one paragraph on demo mode) and `TODO.md` (demo v2: hold Live Activity, demo Control Center site). Commit `docs(ios): demo mode`.
- [ ] **Step 8:** After the build ships to TestFlight, replace the Beta App Review notes' sign-in line with: "No Tesla account needed: tap **Try the demo** on the sign-in screen." (`asc testflight review edit --id 6818639504 --notes …`).
