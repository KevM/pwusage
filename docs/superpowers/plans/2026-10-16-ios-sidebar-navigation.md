# iOS Sidebar Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single scrolling dashboard with a native `TabView` (`.sidebarAdaptable`) of four tabs — Home, Bill, Smart Shift, Settings — that is a sidebar on iPad/Mac and a tab bar on iPhone.

**Architecture:** `PWUsageAppModel` owns the selected `AppTab` (persisting only user picks). A new root `AppTabView` hosts one `NavigationStack` per tab, the Battery Saver sheet, and the sidebar site header. `DashboardView` becomes the Home tab's content with a two-column layout when wide; Tariffs/About move from sheets to pages pushed from a new `SettingsView`.

**Tech Stack:** SwiftUI (iOS 18 deployment target, Xcode 27), Swift Testing, XcodeGen (`./generate.sh`, run by `./run-tests.sh`).

**Spec:** `docs/superpowers/specs/2026-10-16-ios-sidebar-navigation-design.md`. Copy rules: `docs/voice-and-terms.md`.

## Global Constraints

- Deployment target stays iOS 18.0; no `#available` branches needed (`Tab`, `.sidebarAdaptable`, `.tabViewSidebarHeader`, `.defaultAdaptableTabBarPlacement` are iOS 18+).
- Tabs in order: Home `house`, Bill `receipt`, Smart Shift `bolt.badge.clock`, Settings `gearshape`. Battery Saver symbol `bolt.shield`.
- User-facing names this rework touches: "Smart Shift" (was Load Timing), "Battery Saver" (was Battery Hold), "Rate Plans" (was Tariffs). All other copy is out of scope (separate copy plan).
- Swift type/file names, `pwusage://battery-hold`, control kinds stay unchanged.
- Navigation uses `navigationDestination(for:)` only; one `NavigationStack` per tab.
- Layout decisions use size class plus measured width, never device idiom.
- The deep-link reset (`batteryHoldNavigationID`) is applied per tab content, never to the `TabView` (keeps sidebar shown/collapsed state).
- New files use kebab-case names (repo convention).
- `git status` on `main` has unrelated staged changes (`.gitignore`, `cmd/ios-app/.gitignore`); never `git add -A` or commit them. Stage explicit paths only. Never push.
- iOS tests: `cd cmd/ios-app && ./run-tests.sh [SuiteFile]` (e.g. `./run-tests.sh PWUsageAppModelTests`).

## Review Focus

1. Battery Saver deep link while the iPad sidebar is collapsed → sidebar stays collapsed, Smart Shift shows with the Battery Saver sheet (manual check, Task 7).
2. Deep link on a launch whose saved tab is Bill → Smart Shift + sheet now; next launch reopens Bill (test in Task 2).
3. Narrow iPad Split View or accessibility text size → Home falls back to one column with all four cards (test in Task 4, manual in Task 9).
4. Switching site from the sidebar header or Settings while on Smart Shift → no stale Battery Saver sheet for the old site (existing `selectSite` clears `presentedSheet`; test in Task 2).
5. Sign Out from Settings → next sign-in lands on Home, not Settings (test in Task 2).

---

### Task 1: `AppTab` and branch setup

**Files:**
- Create: `cmd/ios-app/PWUsage/Navigation/app-tab.swift`
- Test: `cmd/ios-app/PWUsageTests/app-tab-tests.swift`

**Interfaces:**
- Produces: `enum AppTab: String, CaseIterable, Identifiable, Hashable { case home, bill, smartShift, settings }` with `var id: String { rawValue }`, `var title: String`, `var systemImage: String`. Foundation + no SwiftUI import (portable).

- [x] **Step 1: Branch and commit the design docs**

```bash
git switch -c feat/ios-sidebar-navigation
git add docs/superpowers/specs/2026-10-16-ios-sidebar-navigation-design.md docs/superpowers/specs/2026-10-16-smart-shift-battery-saver-copy-design.md docs/superpowers/specs/2026-10-16-multiplatform-readiness-audit.md docs/superpowers/plans/2026-10-16-ios-sidebar-navigation.md docs/superpowers/plans/2026-10-16-smart-shift-battery-saver-copy.md docs/voice-and-terms.md Agents.md TODO.md
git commit -m "docs: sidebar navigation, copy and multiplatform designs"
```

- [x] **Step 2: Write the failing test** (`@Suite("App Tab Tests")`)

```swift
@Test("Tabs keep their order, titles and symbols")
func tabsMatchDesign() {
    #expect(AppTab.allCases == [.home, .bill, .smartShift, .settings])
    #expect(AppTab.allCases.map(\.title) == ["Home", "Bill", "Smart Shift", "Settings"])
    #expect(AppTab.allCases.map(\.systemImage) == ["house", "receipt", "bolt.badge.clock", "gearshape"])
    #expect(AppTab(rawValue: "smartShift") == .smartShift)
}
```

- [x] **Step 3: Run it to verify it fails** — `./run-tests.sh app-tab-tests` → FAIL, `AppTab` not found.
- [x] **Step 4: Implement `AppTab`** in `app-tab.swift`.
- [x] **Step 5: Run it to verify it passes** — same command → PASS.
- [x] **Step 6: Commit** — `git add cmd/ios-app/PWUsage/Navigation/app-tab.swift cmd/ios-app/PWUsageTests/app-tab-tests.swift && git commit -m "feat(ios): add AppTab for sidebar navigation"`

---

### Task 2: Selected tab on the app model

**Files:**
- Modify: `cmd/ios-app/PWUsage/PWUsageApp.swift` (`PWUsageAppModel`: init ~168-211, `resolveBatteryHoldNavigation` ~390-402, `signOut` ~409-428, `invalidateSession` ~434-451)
- Test: `cmd/ios-app/PWUsageTests/PWUsageAppModelTests.swift`

**Interfaces:**
- Consumes: `AppTab` (Task 1).
- Produces on `PWUsageAppModel`: `@Published private(set) var selectedTab: AppTab`; `func selectTab(_ tab: AppTab)` (sets and persists); `static let selectedTabDefaultsKey = "pwusage.selectedTab"`.

Rules: init reads the saved raw value, falling back to `.home` when missing or unknown. `selectTab` writes the key. `resolveBatteryHoldNavigation` sets `selectedTab = .smartShift` without writing the key, in the same branch that sets `batteryHoldNavigationID`. `signOut` and `invalidateSession` remove the key and set `.home`.

- [x] **Step 1: Write the failing tests**

```swift
@Test("A picked tab is restored on the next launch")
func pickedTabPersists() async throws {
    let defaults = makeDefaults()
    let api = ApplicationAPISpy(sites: [Self.site("site-1")])
    let model = try makeModel(api: api, userDefaults: defaults)
    #expect(model.selectedTab == .home)
    model.selectTab(.bill)
    let relaunched = try makeModel(api: api, userDefaults: defaults)
    #expect(relaunched.selectedTab == .bill)
}

@Test("An unknown saved tab falls back to Home")
func unknownSavedTabFallsBack() throws {
    let defaults = makeDefaults()
    defaults.set("loadTiming", forKey: PWUsageAppModel.selectedTabDefaultsKey)
    let model = try makeModel(api: ApplicationAPISpy(sites: [Self.site("site-1")]), userDefaults: defaults)
    #expect(model.selectedTab == .home)
}

@Test("A Battery Saver launch shows Smart Shift without changing the saved tab")
func controlLaunchSelectsSmartShiftOnce() async throws {
    let defaults = makeDefaults()
    let api = ApplicationAPISpy(sites: [Self.site("site-1")])
    let model = try makeModel(api: api, userDefaults: defaults)
    await model.bootstrap()
    model.selectTab(.bill)
    await model.openBatteryHold(siteID: "site-1")
    #expect(model.selectedTab == .smartShift)
    #expect(model.coordinator?.isBatteryHoldSheetPresented == true)
    #expect(defaults.string(forKey: PWUsageAppModel.selectedTabDefaultsKey) == "bill",
            "A control launch is a one-visit detour, like the saved site.")
}

@Test("A failed Battery Saver launch leaves the tab alone")
func removedSiteKeepsTab() async throws {
    let api = ApplicationAPISpy(sites: [Self.site("site-1")])
    let model = try makeModel(api: api)
    await model.bootstrap()
    model.selectTab(.bill)
    await model.openBatteryHold(siteID: "removed")
    #expect(model.selectedTab == .bill)
}

@Test("Switching site closes the Battery Saver sheet")
func siteSwitchClosesSheet() async throws {
    let api = ApplicationAPISpy(sites: [Self.site("site-1"), Self.site("site-2")])
    let model = try makeModel(api: api)
    await model.bootstrap()
    await model.openBatteryHold(siteID: "site-1")
    model.selectSite(Self.site("site-2"))
    #expect(model.coordinator?.isBatteryHoldSheetPresented == false)
}

@Test("Signing out returns the next session to Home")
func signOutResetsTab() async throws {
    let defaults = makeDefaults()
    let api = ApplicationAPISpy(sites: [Self.site("site-1")])
    let model = try makeModel(api: api, userDefaults: defaults)
    await model.bootstrap()
    model.selectTab(.settings)
    await model.signOut()
    #expect(model.selectedTab == .home)
    #expect(defaults.string(forKey: PWUsageAppModel.selectedTabDefaultsKey) == nil)
}
```

- [x] **Step 2: Run to verify they fail** — `./run-tests.sh PWUsageAppModelTests` → FAIL (`selectedTab` missing).
- [x] **Step 3: Implement** `selectedTab`, `selectTab(_:)`, the key, and the four rule sites above.
- [x] **Step 4: Run to verify they pass** — same command → all PWUsageAppModelTests PASS.
- [x] **Step 5: Commit** — `feat(ios): track the selected tab on the app model`

---

### Task 3: Dashboard sheet narrows to Battery Saver

**Files:**
- Modify: `cmd/ios-app/PWUsage/State/DashboardCoordinator.swift:125-133` (`DashboardSheet`)
- Modify: `cmd/ios-app/PWUsageTests/PWUsageAppModelTests.swift` (`controlLaunchDismissesCompetingDashboardSheet`, `dashboardSheetsAreMutuallyExclusive`)

**Interfaces:**
- Produces: `enum DashboardSheet { case batteryHold }` (other cases removed; `presentedSheet` / `isBatteryHoldSheetPresented` unchanged). Rate Plans and About become pushed pages in Task 6.

- [x] **Step 1: Update the tests first**
  - `controlLaunchDismissesCompetingDashboardSheet`: replace `presentedSheet = .tariffs` with `model.isSitePickerPresented = true`; assert `model.isSitePickerPresented == false` after the failed `openBatteryHold`, keeping the existing `presentedSheet == nil` assertion.
  - `dashboardSheetsAreMutuallyExclusive` → rename `batteryHoldSheetBindingRoundTrips`: `isBatteryHoldSheetPresented = true` gives `.batteryHold`; `= false` gives `nil`. Drop the `.about`/`.tariffs` lines.
- [x] **Step 2: Remove `.tariffs` and `.about`**; update the doc comment to say the dashboard owns one sheet but keeps the value so an external launch can clear it. Temporarily delete the two matching `case` branches and the Tariffs toolbar button / About menu item in `DashboardView` so the target builds (Task 5 rewrites that file).
- [x] **Step 3: Run** — `./run-tests.sh PWUsageAppModelTests` → PASS.
- [x] **Step 4: Commit** — `refactor(ios): dashboard owns only the Battery Saver sheet`

---

### Task 4: Home layout decision

**Files:**
- Modify: `cmd/ios-app/PWUsage/Views/DashboardPresentation.swift` (stays Foundation-only)
- Test: `cmd/ios-app/PWUsageTests/DashboardPresentationTests.swift`

**Interfaces:**
- Produces: `static func homeUsesTwoColumns(width: Double, isRegularWidth: Bool, isAccessibilitySize: Bool) -> Bool` and `static let homeTwoColumnMinimumWidth: Double = 700` on `DashboardPresentation`. True only when all of: regular width, width ≥ 700, not an accessibility size.

- [x] **Step 1: Write the failing test**

```swift
@Test("Home uses two columns only when wide, regular and not at accessibility sizes",
      arguments: [
        (700.0, true, false, true), (699.0, true, false, false),
        (1100.0, false, false, false), (1100.0, true, true, false),
      ])
func homeColumns(width: Double, regular: Bool, accessibility: Bool, expected: Bool) {
    #expect(DashboardPresentation.homeUsesTwoColumns(
        width: width, isRegularWidth: regular, isAccessibilitySize: accessibility) == expected)
}
```

- [x] **Step 2: Run to verify it fails** — `./run-tests.sh DashboardPresentationTests` → FAIL.
- [x] **Step 3: Implement.**
- [x] **Step 4: Run to verify it passes.**
- [x] **Step 5: Commit** — `feat(ios): decide when Home uses two columns`

---

### Task 5: Home tab content

**Files:**
- Modify: `cmd/ios-app/PWUsage/Views/DashboardView.swift`
- Modify: `cmd/ios-app/PWUsage/Views/SectionTheme.swift`
- Modify: `cmd/ios-app/PWUsage/Views/DashboardPreviews.swift:130-200`

**Interfaces:**
- Consumes: `AppTab`, `DashboardPresentation.homeUsesTwoColumns` (Tasks 1, 4).
- Produces: `DashboardView(coordinator: DashboardCoordinator, site: MobileSite, onOpenTab: (AppTab) -> Void, onRefresh: (() async -> Void)? = nil)` — no `NavigationStack`, toolbar, sheet, or `navigationDestination` inside; `.navigationTitle(site.name)` stays (the host stack shows it). `SectionTheme.groupedBackground` and `SectionTheme.secondaryGroupedBackground` (`Color`) replace every `Color(uiColor: .systemGroupedBackground / .secondarySystemGroupedBackground)` in `DashboardView`, `BillView` and `LoadTimingView`.

- [x] **Step 1: Strip navigation chrome** — remove the `NavigationStack`, `.sheet`, `.toolbar`, both `navigationDestination`s and the private `BillDestination` / `LoadTimingDestination` types; drop `onChooseSite` and `onSignOut` parameters.
- [x] **Step 2: Cards switch tabs** — the Current Bill and Smart Shift cards become `Button { onOpenTab(.bill) }` / `Button { onOpenTab(.smartShift) }` with the same card label, `.buttonStyle(.plain)`, `.hoverEffect()`. Section heading "Load Timing" → "Smart Shift". Hints: "Opens the Bill tab" / "Opens Smart Shift".
- [x] **Step 3: Two-column layout** — read width with `onGeometryChange(for: Double.self)`, `horizontalSizeClass == .regular`, and `dynamicTypeSize.isAccessibilitySize`; when `homeUsesTwoColumns` is true lay out `Grid` rows [Live power | Today so far], [Current Bill | Smart Shift] with banners full-width above, and raise the content `maxWidth` from 760 to 1100. Otherwise keep today's single `VStack` unchanged.
- [x] **Step 4: Portable tokens and modifiers** — add the two `SectionTheme` statics, defined cross-platform: `#if canImport(UIKit) && !os(tvOS)` → `Color(uiColor: .systemGroupedBackground / .secondarySystemGroupedBackground)`, `#elseif canImport(AppKit)` → `Color(nsColor: .windowBackgroundColor / .controlBackgroundColor)`, `#else` → `Color.clear` / `Color.secondary.opacity(0.1)`. Replace the UIKit colour uses in the three files. Add `extension View { func inlineNavigationTitle() -> some View; func pointerHoverEffect() -> some View }` in `cmd/ios-app/PWUsage/Views/portable-modifiers.swift`, wrapping `navigationBarTitleDisplayMode(.inline)` and `hoverEffect()` under `#if os(iOS)` (identity elsewhere), and use them in the views this plan touches (`DashboardView`, `BillView`, `LoadTimingView`, `SettingsView`, `TariffSheet`, `AboutSheet`).
- [x] **Step 5: Previews** — `DashboardPreviews.swift`: wrap `DashboardView(... onOpenTab: { _ in })` in `NavigationStack`; add an iPad landscape preview (`#Preview(traits: .landscapeLeft)` on an iPad-sized fixed layout) to show two columns.
- [x] **Step 6: Build** — `./run-tests.sh DashboardPresentationTests` (builds the app target) → PASS. The app root still calls the old initializer; update `PWUsageRootView` to `DashboardView(coordinator:site:onOpenTab: { model.selectTab($0) }, onRefresh:)` wrapped in a `NavigationStack` as a temporary host until Task 7.
- [x] **Step 7: Commit** — `feat(ios): Home tab content with wide two-column layout`

---

### Task 6: Settings tab with Rate Plans and About pages

**Files:**
- Create: `cmd/ios-app/PWUsage/Views/settings-view.swift`
- Modify: `cmd/ios-app/PWUsage/Views/TariffSheet.swift`, `cmd/ios-app/PWUsage/Views/about-sheet.swift`

**Interfaces:**
- Produces: `SettingsView(site: MobileSite, coordinator: DashboardCoordinator, onChooseSite: () -> Void, onSignOut: () -> Void)`; private `enum SettingsDestination: Hashable { case ratePlans, about }`. `TariffSheet` and `AboutSheet` keep their names and initializers but lose their own `NavigationStack`, `@Environment(\.dismiss)` and Done button, so they render as pushed pages; `TariffSheet` title becomes "Rate Plans".

- [ ] **Step 1: Make the two pages pushable** — remove stack/Done from both; keep `TariffSheet`'s `.refreshable`, `.task(id: scenePhase)` loop and `.id(site.id)` behaviour (apply `.id(site.id)` at the push site). Update their `#Preview`s to wrap in `NavigationStack`.
- [ ] **Step 2: Build `SettingsView`** — `List` with sections:
  - **Site**: a button row showing `site.name` and `site.utility` with a chevron, action `onChooseSite` (opens the existing root site-picker sheet).
  - **Rate Plans** → `NavigationLink(value: .ratePlans)`, label `Label("Rate Plans", systemImage: "list.bullet.rectangle")`; **About** → `.about`, `Label("About", systemImage: "info.circle")`.
  - **Sign Out**: `Button("Sign Out", role: .destructive)` presenting `confirmationDialog("Sign out of pwusage?", ...)` with "Sign Out" (destructive, calls `onSignOut`) and "Cancel"; attach the dialog to the button.
  - `navigationTitle("Settings")`; `navigationDestination(for: SettingsDestination.self)` → `TariffSheet(site:load: { try await coordinator.fetchTariffs() }).id(site.id)` / `AboutSheet()`.
- [ ] **Step 3: Preview** — `#Preview` in `NavigationStack` with a fixture site.
- [ ] **Step 4: Build** — `./run-tests.sh TariffSheetTests` → PASS.
- [ ] **Step 5: Commit** — `feat(ios): Settings tab with Rate Plans, About and Sign Out`

---

### Task 7: Root `AppTabView`

**Files:**
- Create: `cmd/ios-app/PWUsage/Navigation/app-tab-view.swift`
- Modify: `cmd/ios-app/PWUsage/PWUsageApp.swift` (`PWUsageRootView` `.signedIn` branch ~591-611)
- Modify: `cmd/ios-app/PWUsage/Views/LoadTimingView.swift:388-404` (title, trailing toolbar placement)

**Interfaces:**
- Consumes: `AppTab`, `model.selectedTab` / `selectTab`, `DashboardView`, `SettingsView`, `BillView`, `LoadTimingView`, `BatteryHoldSheet`.
- Produces: `AppTabView(model: PWUsageAppModel, coordinator: DashboardCoordinator, site: MobileSite)`.

- [ ] **Step 1: Build `AppTabView`**
  - `TabView(selection:)` bound with a custom binding whose setter calls `model.selectTab` (the tab-selection side-effect pattern), `ForEach(AppTab.allCases)` → `Tab(tab.title, systemImage: tab.systemImage, value: tab)`.
  - Each tab: `NavigationStack { content }.id(model.batteryHoldNavigationID)` — Home: `DashboardView(coordinator:site:onOpenTab: model.selectTab, onRefresh: { await model.refreshDashboard() })`; Bill: `BillView`; Smart Shift: `LoadTimingView(coordinator:site:)`; Settings: `SettingsView(site:coordinator:onChooseSite: model.openSitePicker, onSignOut: { Task { await model.signOut() } })`.
  - `.tabViewStyle(.sidebarAdaptable)`, `.defaultAdaptableTabBarPlacement(.sidebar)`.
  - `.tabViewSidebarHeader`: site name; when `model.sites.count > 1`, a `Menu` listing sites (checkmark on current) calling `model.selectSite`.
  - `.sheet(item: $coordinator.presentedSheet)` → `.batteryHold`: `BatteryHoldSheet(coordinator:site:)`.
- [ ] **Step 2: Wire the root** — replace the temporary Task 5 host with `AppTabView(...)`; move `.environment(\.reconnectTesla, …)` onto it; keep the site-picker `.sheet` on the root; remove the old `.id(model.batteryHoldNavigationID)` from the root view.
- [ ] **Step 3: Smart Shift page** — `LoadTimingView` `.navigationTitle("Smart Shift")`; trailing `ToolbarItemGroup(placement: .topBarTrailing)` → `.primaryAction` (leading sun button unchanged).
- [ ] **Step 4: Run the full suite** — `./run-tests.sh` → PASS.
- [ ] **Step 5: Manual check (Review Focus 1)** — iPad simulator: collapse the sidebar, open `pwusage://battery-hold?site=<id>` with `xcrun simctl openurl booted ...`; sidebar stays collapsed, Smart Shift selected, sheet up. Switch Home ↔ Smart Shift with a breakpoint in `LoadTimingView.refreshBatteryHoldWhileVisible`: the loop stops when Smart Shift is hidden and restarts on return.
- [ ] **Step 6: Commit** — `feat(ios): sidebar-adaptable tab navigation`

---

### Task 8: Battery Saver label, title and symbol

**Files:**
- Modify: `cmd/ios-app/PWUsage/Views/battery-hold-presentation.swift:97-110`, `battery-hold-toolbar-label.swift`, `battery-hold-sheet.swift:53,76`
- Test: `cmd/ios-app/PWUsageTests/battery-hold-coordinator-tests.swift` (and any test asserting these strings)

Exact copy:
- `toolbarAccessibilityLabel`: unknown → "Battery Saver, status unknown"; active → "Battery Saver on, saving your Powerwall at \(reserve). Open Battery Saver."; idle → "Battery Saver. Open Battery Saver."
- `toolbarLabel`: "Battery Saver" / "Battery Saver On".
- Sheet `navigationTitle("Battery Saver")`; unavailable title "Battery Saver Unavailable".
- Toolbar glyph `Image(systemName: "bolt.shield")`.

- [ ] **Step 1: Update string tests first** — add `#expect(BatteryHoldPresentation.toolbarLabel(state: BatteryHoldState(), at: now) == "Battery Saver")` and the active-state accessibility label assertion next to the existing `contains("unknown")` test; run `./run-tests.sh battery-hold-coordinator-tests` → FAIL.
- [ ] **Step 2: Apply the copy and glyph.**
- [ ] **Step 3: Run** `./run-tests.sh` → PASS (fix any other test asserting "Battery Hold" in these three strings).
- [ ] **Step 4: Commit** — `feat(ios): rename Battery Hold surfaces in navigation to Battery Saver`

---

### Task 9: Verification

- [ ] **Step 1:** `cd cmd/ios-app && ./run-tests.sh` → all PASS.
- [ ] **Step 2: Simulator checks** (iOS Simulator tool, screenshots):
  - iPad landscape, sidebar shown: four entries with symbols, site header, Home in two columns with no scrolling needed for all four cards.
  - iPad portrait and Split View narrow: Home single column; tab bar at top when collapsed.
  - iPhone: four-tab bottom bar; Home single column; Settings → Rate Plans and About push; Sign Out asks to confirm.
  - Largest accessibility text size on iPad: Home single column (Review Focus 3).
  - Battery Saver link on cold and warm launch with saved tab Bill: lands on Smart Shift + sheet; relaunch shows Bill (Review Focus 2).
- [ ] **Step 3:** Record anything not verified for the hand-off; do not push.
