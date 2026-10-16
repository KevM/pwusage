# iOS Sidebar Navigation Design

## Intent

On iPad (and on Mac, where the app runs as "Designed for iPad") the app is one
long scrolling dashboard. Live power and Today sit inline; Bill and Load Timing
are pushed from cards at the bottom; Tariffs, About, Switch Site and Sign Out
hide behind toolbar buttons and a "…" menu. Getting to Load Timing means
scrolling past everything else first.

The user wants the app to fit large-screen paradigms: a native sidebar with one
entry per area, so a single tap reaches any area, and a Home screen that uses the
width instead of making you scroll. Apple's HIG for sidebars recommends exactly
this shape — a `sidebarAdaptable` tab view that is a sidebar on iPad/Mac and a
tab bar on iPhone — so the same structure is adopted on every device.

## Goals

- One native `TabView` with `.tabViewStyle(.sidebarAdaptable)` and four
  top-level tabs, in this order: **Home**, **Bill**, **Smart Shift**,
  **Settings**.
- iPad / Mac: sidebar shown by default on launch
  (`.defaultAdaptableTabBarPlacement(.sidebar)`), collapsible into the floating
  top tab bar with the system toggle / edge swipe.
- iPhone: a four-tab bottom tab bar. (User confirmed iPhone changes too.)
- Home fits on one screen when wide: no scrolling needed to see Live power,
  Today, Bill and Smart Shift at once on a typical iPad landscape window.
- Every feature reachable today stays reachable at every window size
  (SwiftUI Pro `design.md`: don't gate features to regular size class).

## Non-goals

- A dedicated Mac (Catalyst / AppKit) target. Mac gets the sidebar via
  "Designed for iPad" for free.
- Sidebar customization (reordering / hiding tabs via `TabViewCustomization`).
- Redesigning the Bill or Smart Shift page contents.
- iPhone Duo-specific work (vertical bars, fold geometry). It gets whatever the
  native component provides; nothing more.
- Raising the iOS 18 deployment target.

## Anti-goals (failure even if it "works")

- A hand-built sidebar (`HStack` columns or a custom `List` in
  `NavigationSplitView`) instead of the system component — loses the
  tab-bar ↔ sidebar morph, iPhone tab bar, and Mac behaviour.
- Critical actions at the bottom of the sidebar (HIG: a moved window can hide
  the bottom edge). Sign Out does not go in a sidebar footer.
- Battery Hold deep links (Control Center control, Live Activity) regressing:
  they must still land on the hold sheet for the right site, with the existing
  loading overlay, alerts and site-verification behaviour intact.
- Extra Tesla / API traffic from tabs: Smart Shift's appear-driven fetches and
  its 60 s Battery Hold polling must still run only while Smart Shift is
  actually visible, as they do today when it is pushed.

## Constraints

- Deployment target iOS 18.0, Xcode 27, SwiftUI only. `Tab`, `TabSection`,
  `.sidebarAdaptable`, `.tabViewSidebarHeader`, `.defaultAdaptableTabBarPlacement`
  are all iOS 18+, so no availability branches are needed.
- `navigationDestination(for:)` only; never mix with
  `NavigationLink(destination:)`. One `NavigationStack` per tab, each
  registering its own destinations.
- Layout decisions use size class / available width, never device idiom.
- Window minimum size stays 380×520 (`configureWindowSizeRestrictions`).
- Existing `PWUsageAppModelTests` / battery-hold navigation tests encode the
  deep-link contract; update them to the new shape, don't delete coverage.

## Structure (decided)

### Tabs

| Tab | Label | SF Symbol | Root content |
|---|---|---|---|
| Home | "Home" | `house` | Live power + Today + Bill / Smart Shift summary cards |
| Bill | "Bill" | `receipt` | Today's `BillView` |
| Smart Shift | "Smart Shift" | `bolt.badge.clock` | Today's `LoadTimingView`, including its Battery Hold toolbar button |
| Settings | "Settings" | `gearshape` | Site, Rate Plans, About, Sign Out |

Each tab owns its own `NavigationStack`. Icons use the app accent colour (HIG);
no fixed per-icon colours unless they carry meaning.

### Naming (user decisions)

- "Load Timing" is renamed **Smart Shift** (`bolt.badge.clock`).
- "Battery Hold" is renamed **Battery Saver** (`bolt.shield`).
- This rework renames only the surfaces it touches: tab label, page/sheet
  titles, Home card heading, and the Battery Saver toolbar label. The wider copy
  rewrite (body text, empty/error states, VoiceOver hints, load-profile wording,
  widgets, Control Center control, Live Activity, web app, TRMNL) is a
  separate copy project with its own word list.
- The iOS app is unreleased, so its identifiers may be renamed (user
  decision): `pwusage://battery-hold` and the control kind. That belongs to the
  separate rename/copy project
  (`2026-10-16-smart-shift-battery-saver-copy-design.md`), not
  this rework, which keeps today's identifiers so its diff stays about
  navigation. Web API routes, cron paths and database tables keep their
  `battery-hold` / `load-timing` names (user has no strong preference; renaming
  them costs a production migration for no visible gain).

### Home

- Same content as today's dashboard top: availability banners, Live power,
  Today so far, and the Current Bill and Smart Shift summary cards.
- **Wide**: two-column arrangement — Live power | Today on the first row,
  Bill card | Smart Shift card on the second — so it fits without scrolling on
  iPad landscape with the sidebar showing. **Narrow** (iPhone, compact iPad
  windows, accessibility text sizes): today's single column, unchanged.
- Tapping the Bill or Smart Shift summary card **switches to that tab**
  (my call) rather than pushing a duplicate page inside Home. The cards keep
  their chevron/hover affordance and accessibility hints (reworded to
  "Opens the Bill tab" style if needed).
- Home's toolbar loses the Tariffs (now Rate Plans) button and "…" menu (moved to Settings).
- Pull-to-refresh behaves as today (`model.refreshDashboard()`).

### Smart Shift and Battery Hold

Battery Hold stays part of Smart Shift (user decision): the status button in
Smart Shift's toolbar opens the existing `BatteryHoldSheet`. Smart Shift's own
sheets (load profiles, solar forecast settings, run details) are unchanged.

External routes (Control Center control, Live Activity, `pwusage://battery-hold`)
keep the full existing flow in `PWUsageAppModel` (pending site, site recheck,
overlay, alerts, `batteryHoldNavigationID` rebuild) and additionally **select
the Smart Shift tab** before presenting the hold sheet.

### Settings

A grouped `List` in its own `NavigationStack`:

- **Site** section: current site; tapping it lets you switch (the existing
  `SitePickerView` content — pushed or inline is the builder's call). Shown even
  with one site, so iPhone users can see which site they're on.
- **Rate Plans** (was Tariffs): pushes the rate plan content (today's `TariffSheet` body, without its
  own `NavigationStack` / Done button when shown inside Settings).
- **About**: pushes the About content (same treatment).
- **Sign Out**: destructive row at the end; confirm before signing out
  (my call — it's now one tap away rather than inside a menu).

### iPad sidebar header

`.tabViewSidebarHeader` shows the current site name as a compact site switcher
(my call). It is a convenience only; Settings remains the canonical place, since
the header is invisible when the sidebar is collapsed and on iPhone.

### Selection and state

- The selected tab is owned above the `TabView` so deep links can set it
  (e.g. on `PWUsageAppModel`, or root view state the model can drive). Persist
  the last tab the **user** picked across launches; first launch opens Home
  (my call). A deep link's switch to Smart Shift is a one-visit detour and is
  not persisted, mirroring how a control launch already leaves the saved
  default site alone (`installAuthorizedSites`,
  `controlLaunchKeepsSavedDashboardDefault`). Sign-out clears the saved tab.
  (My call.)
- Sheets that must appear regardless of tab (the Battery Hold sheet driven by
  `coordinator.presentedSheet`, the site picker if it remains a sheet) attach to
  the root `TabView`, not to one tab's view, so `dismissCompetingPresentations`
  still clears them.
- `DashboardSheet.tariffs` / `.about` go away once those become Settings pages;
  `.batteryHold` remains.
- The `.environment(\.reconnectTesla, …)` injection moves from `DashboardView`
  to the root `TabView`.
- The deep-link reset (`.id(batteryHoldNavigationID)`) must **not** rebuild the
  `TabView` itself: that would discard the user's sidebar shown/collapsed state
  and re-apply `.defaultAdaptableTabBarPlacement(.sidebar)`, popping a collapsed
  sidebar back open on every Control Center / Live Activity launch. Apply the
  reset to each tab's content (or reset explicit per-tab navigation paths and
  Smart Shift's local sheets) so old paths and modals are still dropped while
  the sidebar state survives. (My call.)

## Platform portability (cheap now, not a port)

A future native macOS or tvOS app should be able to reuse this structure
without a navigation rewrite. Models, networking, `DashboardCoordinator`
(Combine `ObservableObject`) and the `*Presentation` helpers (Foundation-only)
are already platform-neutral; the iOS-specific parts are concentrated in the
views and `MobileAuthService`. Within the files this rework touches anyway:

- Define the tabs as one `AppTab` enum (identity, title, SF Symbol) separate
  from the iOS root view, so another platform's root can reuse it.
- Tab root views don't assume they are pushed or in a sheet (no embedded
  `NavigationStack` / Done button in reusable content; the host adds those).
- Prefer semantic toolbar placements (`.primaryAction`, `.confirmationAction`,
  `.cancellationAction`) over `.topBarLeading` / `.topBarTrailing` where the
  meaning is the same.
- Route the `Color(uiColor: .systemGroupedBackground)` /
  `.secondarySystemGroupedBackground` backgrounds in touched views through
  `SectionTheme` (or one shared colour token) instead of repeating UIKit colours.

Out of scope: adding macOS/tvOS targets, `#if os(...)` branches, a tvOS sign-in
flow (`ASWebAuthenticationSession` is unavailable there), focus-based TV
layouts, or extracting a shared Swift package.

## Left to the builder

- Exact width threshold / mechanism for Home's two-column switch (size class
  plus measured width; must also collapse at accessibility Dynamic Type sizes).
- File layout (e.g. split `DashboardView` into a Home view and a root
  tab container), names, and how `TariffSheet` / `AboutSheet` share content
  between sheet and pushed use (or simply stop being sheets).
- Whether `BillView` / `LoadTimingView` need any title/toolbar tweaks to read
  well as tab roots (they currently assume being pushed).
- Sidebar header styling.
- Verifying `TabView` appearance semantics: confirm `.task` on Smart Shift is
  cancelled when switching away and restarted when returning, so polling only
  runs while visible.

## Verification

- `./run-tests.sh` passes, with updated deep-link tests asserting the Load
  Timing tab is selected and the hold sheet presented.
- Manual / simulator checks: iPad landscape and portrait (sidebar shown,
  collapsed, Split View narrow), iPhone, largest accessibility text size, and a
  Battery Hold deep link from cold and warm launch.
