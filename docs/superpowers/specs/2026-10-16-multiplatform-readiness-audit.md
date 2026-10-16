# iOS app: multiplatform (macOS + tvOS) readiness audit

Date: 2026-10-16 · Scope: `cmd/ios-app` (PWUsage, Shared, PWUsageWidgets, `project.yml`) · Read-only; no code changed.
Companion to the "Platform portability" section of `2026-10-16-ios-sidebar-navigation-design.md`.

## Verdict

The non-UI layers are in good shape; the cost is concentrated in a small, well-bounded set of iOS-only seams.

- **macOS (native SwiftUI):** roughly 1.5–3 weeks to a usable app. About 90% of the code is reusable. The work is a colour shim, four modifier wrappers, an auth presentation anchor, window and menu polish, and a widget bundle split.
- **tvOS:** roughly 4–6 weeks for a read-only, 10-foot dashboard. The cost is the sign-in flow (needs backend work), focus-driven layout, persistence rules, and cutting features (forecast key entry, battery hold control, Live Activities).
- **Do now, opportunistically:** the colour shim, `AppTab`/semantic toolbar placements (already in the nav spec), moving `PWUsageAppModel` and `PWUsageApplicationAPI` out of the `@main` file, and the auth anchor/pasteboard seams (all ≤ half a day each). These make the later port mechanical.

## How this was verified

Beyond grepping, I type-checked copies of the sources in the scratchpad (nothing in the repo changed) against the real Xcode 27 SDKs: `macosx27.0` and `appletvos27.0`.

1. **Foundation-layer files compile unchanged.** The 31 files in Models, Networking, Configuration, `LoadProfileStore`, `DashboardCache`, `SolarForecastStore`, `DashboardCoordinator`, `battery-hold-activity-coordinator`, `SolcastCredentialStore` and the Shared snapshot/mode/attributes files type-check on both SDKs. Exceptions:
   - `PWUsageAPI.swift:209` references `PWUsageApplicationAPI`, which is declared in the `@main` file (`PWUsageApp.swift:8`).
   - tvOS has no `WidgetKit` (`DashboardCache.swift:3`) and no `ActivityKit` (`Shared/battery-hold-activity-attributes.swift:1`).
   - After stripping those imports and stubbing the protocol, both SDKs report zero errors.
2. **One-line API probes** against macOS 26 and tvOS 26 targets, results below. Probe sources are in the scratchpad.
3. **Whole-target typecheck is not meaningful** (the compiler stops at the first missing module), so the per-API tables below are the authoritative inventory. Counts come from grep over `PWUsage`, `Shared`, `PWUsageWidgets`, tests excluded.

| API (probe) | macOS | tvOS |
|---|---|---|
| `Color(uiColor: .systemGroupedBackground)` and every other UIKit semantic colour | ✗ (UIKit absent; use `NSColor`) | ✗ (the system-grouped family is unavailable even with `import UIKit`) |
| `.toolbar { ToolbarItem(placement: .topBarTrailing/.topBarLeading) }` | ✗ | ✓ |
| `.navigationBarTitleDisplayMode(.inline)` | ✗ | ✗ |
| `.hoverEffect()` | ✗ | ✓ (acts as a focus effect) |
| `.textInputAutocapitalization(.never)` | ✗ | ✓ |
| `Stepper` | ✓ | ✗ |
| `.presentationDetents`, `.presentationDragIndicator` | ✓ (no effect) | ✓ |
| `.refreshable`, `.pickerStyle(.segmented/.menu)`, `.confirmationDialog`, `.textContentType`, `.onOpenURL`, `.sensoryFeedback`, `TabView.tabViewStyle(.sidebarAdaptable)` | ✓ | ✓ |
| `ActivityKit` module | ✓ importable | ✗ |
| `ControlWidget` / `ControlCenter.reloadControls` | ✓ macOS 26+ (`ControlCenter` is flagged "only available in macOS 26.0") | ✗ |
| `WidgetKit` | ✓ | ✗ |
| `ASWebAuthenticationSession(url:callback:)` | ✓ | initialiser exists, but `presentationContextProvider`, `prefersEphemeralWebBrowserSession` and `cancel()` are `API_UNAVAILABLE(tvos)` |

## Per-folder inventory

### Models (`PWUsage/Models`, 16 files)

- **Compile as-is on macOS and tvOS.** Every file imports Foundation only.
- The only coupling is `battery-hold-activity-content.swift`, an extension on `BatteryHoldActivityAttributes.ContentState`. That type sits in Shared behind `import ActivityKit` (`Shared/battery-hold-activity-attributes.swift:1`, `:11`, with `ContentState` at `:28`).
- **tvOS fix:** move `ContentState` (a plain `Codable, Hashable` struct) out of the `ActivityAttributes` type, or wrap the `ActivityAttributes` conformance in `#if canImport(ActivityKit)`. Models and the coordinator then compile on tvOS without ActivityKit.

### Networking (`PWUsage/Networking`)

- **Compile as-is** (modulo the `PWUsageApplicationAPI` location noted above).
- `PWUsageAPI` keeps the session in `HTTPCookieStorage.shared` (`PWUsageAPI.swift:32-37`) and deletes the `site_auth` cookie on logout (`:158-162`). This works on macOS.
- On tvOS the app has no durable local storage, and cookie persistence across launches there is **not verified**. Treat it as unreliable and see the tvOS sign-in section.
- `SolcastClient` uses an ephemeral session (`SolcastClient.swift:11-19`) and is portable.

### Configuration

- **Compiles as-is.** `AppConfiguration.fromBundle` (`AppConfiguration.swift:70`) reads `PWUSAGE_API_ORIGIN` from Info.plist, so each new target must carry the same Info.plist keys. In XcodeGen, share them via a settings group or template.

### Authentication

| File | Issue | Evidence |
|---|---|---|
| `MobileAuthService.swift` | `import UIKit` | `:5` |
| | Presentation anchor via `UIApplication.shared.connectedScenes` / `UIWindowScene` / `isKeyWindow` | `:208-212` |
| | `prefersEphemeralWebBrowserSession` / `presentationContextProvider` (unavailable on tvOS) | `:160-161`, `:9-10` |
| `SolcastCredentialStore.swift` | Keychain generic-password, `kSecAttrSynchronizable: false`, `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` | `:43-52` |

- **The auth logic is already abstracted:** `MobileAuthWebSession` and `SessionFactory` are injected (`:7-15`, `:29`). The PKCE, state validation, generation guards and `parseCallback` code is pure and portable.
- **macOS fix:** `#if os(macOS)` → `NSApplication.shared.keyWindow ?? ASPresentationAnchor()` in `presentationAnchor`.
- **macOS keychain:** the `SecItem` code needs `kSecUseDataProtectionKeychain: true` on macOS to behave like the iOS keychain (otherwise it uses the legacy file keychain with prompts). This is a one-line, platform-conditional add to each query dictionary. A small `keychainBase` helper would be better.
- **tvOS:** `ASWebAuthenticationSession` cannot be the sign-in mechanism (below). `SolcastCredentialStore` itself would work, but the Solcast key-entry UI is a poor fit for a TV; see Views.

### State

| File | Platform coupling |
|---|---|
| `DashboardCoordinator.swift`, `LoadProfileStore.swift` | Foundation + Combine. Portable. |
| `SolarForecastStore.swift` | `CryptoKit` portable. Persists to **Application Support** (`:716`). Fine on macOS. tvOS apps can only write to Caches/tmp, so this would fail. Needs a storage-location abstraction (it already takes a `FileManager`). |
| `DashboardCache.swift` | Writes to `Caches` (`:34`), which is the right place for tvOS too. Uses `.completeFileProtectionUnlessOpen` (`:101`). That option is a no-op on macOS, but the write still succeeds. **Hard WidgetKit dependency:** `import WidgetKit` (`:3`) and `WidgetCenter.shared.reloadTimelines` (`:73-74`). Fails to build on tvOS. |
| `battery-hold-activity-host.swift` | The whole file is ActivityKit (`:1`, `:9-25`). `BatteryHoldActivityHost` is already a protocol, so this is the right seam: compile the host only on iOS. |
| `battery-hold-activity-coordinator.swift` | Portable (CryptoKit/Observation/OSLog), tested through the host protocol. |
| `PWUsageAppModel` (`PWUsageApp.swift:123-570`) | Portable logic, but it lives in the `@main` file together with `UIKit` usage. Move it to `State/`. |

- **User defaults and tvOS:** `LoadProfileStore` and the account scope use `UserDefaults` (`LoadProfileStore.swift:32-34`, `PWUsageApp.swift:147`). That is fine on macOS. On tvOS, UserDefaults is small and not guaranteed to persist, so the load-profile feature has to be dropped or server-backed there.
- **Widget reload seam:** `WidgetCenter.shared.reloadTimelines` is the only WidgetKit call outside the widget extension, plus `ControlCenter.shared.reloadControls` at `PWUsageApp.swift:26`. Hide both behind a tiny `WidgetReloading` protocol (default iOS/macOS implementation, no-op on tvOS).

### Views (`PWUsage/Views`, 26 files)

SwiftUI-only except the items below. Five files are Foundation-only presentation helpers (`DashboardPresentation`, `LoadTimingForecastPresentation`, `battery-hold-presentation`, `SolarForecastSettingsStatus`, `battery-hold-preview-api`) and compile everywhere.

| Issue | Count / where | macOS | tvOS |
|---|---|---|---|
| `Color(uiColor:)` | 24 uses, 14 files. Views: `DashboardView.swift:44,358,499,513`, `BillView.swift:31,65,146`, `SignInView.swift:66`, `LoadTimingView.swift:376,881,1023`, `PWUsageApp.swift:586,706`, `SectionTheme.swift:15,20`. Shared: `today-energy-presentation.swift:149`, `energy-metric-tile.swift:43`, `battery-hold-activity-views.swift:71`. Widgets: `today-energy-widget.swift:34`, `today-energy-metric-widget.swift:69`, `battery-hold-live-activity.swift:93`, plus 2 preview files. | ✗ | ✗ |
| `.topBarLeading/.topBarTrailing` | `DashboardView.swift:59,65`, `LoadTimingView.swift:391,395,885`, `LoadProfilesSheet.swift:41` | ✗ | ✓ |
| `.navigationBarTitleDisplayMode(.inline)` | 11 uses, 9 files (`DashboardView.swift:46`, `BillView.swift:43`, `TariffSheet.swift:70`, `SitePickerView.swift:37`, `about-sheet.swift:28`, `LoadTimingView.swift:389,883`, `LoadProfilesSheet.swift:39,298`, `SolarForecastSettingsSheet.swift:152`, `battery-hold-sheet.swift:77`) | ✗ | ✗ |
| `.hoverEffect()` | `DashboardView.swift:237,313`, `SitePickerView.swift:32`, `SignInView.swift:49` | ✗ | ✓ (focus) |
| `.textInputAutocapitalization(.never)` | `SolarForecastSettingsSheet.swift:27,100,104` | ✗ | ✓ |
| `Stepper` | `battery-hold-setup-section.swift:56`, `LoadProfilesSheet.swift:272-286,320` | ✓ | ✗ |
| `UIPasteboard.general` | `PWUsageApp.swift:77` (+ `import UIKit` `:5`) | ✗ | ✗ |
| `UIWindowScene.sizeRestrictions` | `PWUsageApp.swift:666-668` (already inside `#if canImport(UIKit)`, but it still needs an `#else` arm or a SwiftUI-native replacement) | n/a | n/a |
| `.refreshable` | 5 uses (`DashboardView.swift:40`, `BillView.swift:38`, `TariffSheet.swift:74`, `LoadTimingView.swift:383`, `battery-hold-sheet.swift:83`) | compiles; pull-to-refresh has no gesture, use ⌘R (already in `PWUsageCommands`) | compiles, no gesture; use a Refresh button or timed refresh |
| `.sheet` + `.presentationDetents` | `PWUsageApp.swift:604-609`, `LoadTimingView.swift:890-891` | sheets work; detents are ignored | sheets work as full-screen modals |
| `NavigationStack` inside each sheet/screen | 9 files | fine | fine |
| Fixed font sizes | `.font(.system(size:))` at `DashboardView.swift:116`, `SignInView.swift:16`, `PWUsageApp.swift:696`, `LoadTimingView.swift:975` | fine | too small for 10-foot; TV needs its own type scale |
| Custom `Layout` (`PowerFlowLayout`) and `GeometryReader` gauge | `DashboardView.swift:424`, `Shared/battery-gauge.swift:96` | portable | portable |
| `ViewThatFits`, `dynamicTypeSize` branches | `TariffSheet.swift:99`, `LoadProfilesSheet.swift:321`, `DashboardView.swift:320,378` | portable | portable (Dynamic Type is limited on tvOS) |
| `.sheet`/`.alert`/`.confirmationDialog` | several | fine | alerts and dialogs are focus-driven; fine |

Beyond compile errors, what needs rethinking:

- **Layout assumes a single phone-width column.** Dashboard, Bill and Load Timing are `ScrollView` + cards, with sign-in capped at `maxWidth: 500` (`SignInView.swift:64`). On macOS, add a readable max width or a two-column dashboard; the nav rework's sidebar helps. The custom `PowerFlowLayout` is the reusable piece.
- **`LoadTimingView.swift` is 1,025 lines** with six `View` structs, and `DashboardView.swift` is 546 lines. They are portable but mix screen and component code. Splitting out the components makes it cheap to compose a TV or Mac variant.
- **Toolbar content is positional** (`topBarLeading/Trailing`). The nav spec already proposes semantic placements (`.primaryAction`, `.confirmationAction`, `.cancellationAction`); doing that removes all 6 `topBar*` uses.

### Shared (`Shared/`, 13 files, compiled into both app and widgets)

| File | Notes |
|---|---|
| `today-energy-snapshot.swift`, `battery-hold-control-site.swift` | App-group container reads/writes (`:111`/`:124`, `:31`/`:42`). macOS requires an App Group entitlement; the group id format differs (`<TeamID>.group…` or `group.…` with a matching profile). **Verify when the macOS target is created.** `.completeFileProtectionUntilFirstUserAuthentication` is ignored on macOS. tvOS has no widgets; an app group would only matter for a Top Shelf extension. |
| `battery-hold-activity-attributes.swift`, `battery-hold-activity-views.swift`, `battery-hold-activity-presentation.swift` | ActivityKit/WidgetKit (`.activityBackgroundTint` at `battery-hold-activity-views.swift:71`). iOS only in practice. |
| `battery-hold-navigation.swift` | `AppIntents`. `OpenIntent` is available on macOS. Not on tvOS (the intent is a Control Center target). |
| `battery-gauge.swift`, `energy-metric-tile.swift`, `today-energy-presentation.swift`, `today-energy-widget-layout.swift`, `today-energy-single-metric-content.swift` | SwiftUI. Portable except `Color(uiColor:)` (`energy-metric-tile.swift:43`, `today-energy-presentation.swift:149`) and `import WidgetKit` in the layout file. |
| `battery-hold-mode.swift`, `today-energy-metric.swift` | Plain types. Portable. |

Shared mixes pure types, SwiftUI components and ActivityKit/AppIntents. Folder-level separation (`Shared/Core`, `Shared/UI`, `Shared/iOSOnly`) would make the target membership obvious.

### PWUsageWidgets

- The extension is `@main TodayEnergyWidgetBundle` with `TodayEnergyWidget`, `TodayEnergyMetricWidget`, `BatteryHoldControl` and `BatteryHoldLiveActivity` (`today-energy-widget.swift:50-57`).
- **macOS:** the two home-screen widgets are the natural fit (desktop and Notification Centre), but they need the colour shim. The Live Activity (iPhone-mirrored on Mac) and Control Center control need `#if os(iOS)` in the bundle. `ControlWidget` is in the macOS SDK, but the app target must be macOS 26+ to use `ControlCenter`.
- **tvOS:** no WidgetKit. The widget analogue is a **Top Shelf extension** (TVServices) reading the same `TodayEnergySnapshot`. Optional.

### Info.plist and entitlements (`project.yml`)

| Setting | Line | Impact |
|---|---|---|
| `platform: iOS`, `deploymentTarget iOS 18.0` | `:4`, `:16`, `:75`, `:104` | Switch to `supportedDestinations`, or add targets. |
| `NSSupportsLiveActivities` | `:29` | iOS only. |
| `UIApplicationSceneManifest`, `UISupportedInterfaceOrientations*`, `UILaunchScreen` | `:33-44` | UIKit-only keys. Harmless but meaningless on macOS/tvOS; split per platform. |
| `UISupportsTrueScreenSizeOnMac: true` | `:45` | The app already runs on Apple Silicon Macs as an iPad app ("Designed for iPad"). |
| `aps-environment` entitlement | `:58` | tvOS and macOS use different push entitlement keys. Only needed for Live Activity APNs, which don't ship there, so omit it for those targets. |
| `com.apple.security.application-groups` | `:56`, `:89` | See Shared. |
| `CFBundleURLTypes pwusage://` | `:46-50` | Works on macOS. tvOS supports URL schemes too, but nothing opens the app there. |

## tvOS-specific blockers

1. **Sign-in has no equivalent today.** `ASWebAuthenticationSession`'s presentation context, ephemeral-session and `cancel()` APIs are unavailable on tvOS, and there is no browser. `GET /login` (`next-app/src/app/login/route.ts`) redirects through Tesla's OAuth to a custom-scheme callback, and `POST /api/mobile/session` exchanges `{attemptId, code, verifier, state}` for the `site_auth` cookie (`next-app/src/app/api/mobile/session/route.ts`). Neither works without a browser on the device.
   - **Recommended: device-code flow with QR, reusing the existing handoff.**
     - Server work (about 3–5 days, the bulk of the tvOS effort):
       - `POST /api/mobile/device` creates a device attempt (device code, short user code, PKCE challenge/state), as an extension of the `MobileLoginHandoff` table and `createMobileLoginHandoff` / `consumeMobileLoginHandoff` in `lib/mobile-login-handoff.ts`.
       - `GET /login/device?code=…` is opened from the QR code on a phone or laptop. It runs the existing Tesla login and approval, and `/auth/tesla-callback` branches to "approved the TV attempt" instead of a `pwusage://` redirect.
       - `POST /api/mobile/device/poll` returns the handoff `code` once approved. The TV then calls the existing `/api/mobile/session` with its PKCE verifier.
     - The TV shows a QR plus a short code and polls every few seconds. It reuses `MobileAuthService`'s PKCE and exchange pieces; only the "obtain callback" step differs. That step is already injected via `SessionFactory`, so this is a new implementation of the same seam.
   - **Alternative: sign in with the companion iPhone app.** Share a keychain item (access group, `kSecAttrSynchronizable: true`) between iOS and tvOS. This is zero-touch for existing users, but it contradicts the current "this device only" credential policy (`SolcastCredentialStore.swift:46,50`) and the cookie-only session design, so it needs a security decision. Not recommended as the first step.
   - **Session storage on tvOS:** store the `site_auth` value in the Keychain and re-inject it as an `HTTPCookie` (or an `Authorization` header) at launch instead of relying on `HTTPCookieStorage.shared` persistence. The server issues it as an HTTP-only cookie today, so a small token-returning variant of the exchange response is the clean option.
2. **Focus-based layout.** Current cards are `NavigationLink`/`Button` with `.buttonStyle(.plain)` and `.hoverEffect()` (`DashboardView.swift:237,313`). On tvOS, use `.buttonStyle(.card)` or a focus effect, add `@FocusState` and `.focusSection()` for the Dashboard → Bill → Load Timing hierarchy, and size to 10-foot type. Cards that are not actions should stay non-focusable. Plan a dedicated TV dashboard (power flow, battery, today's cost, bill) rather than reusing the phone scroll screens.
3. **No Live Activities, Control Center or WidgetKit.** Exclude `ActivityKitBatteryHoldHost`, `BatteryHoldControl`, `BatteryHoldLiveActivity` and the `WidgetCenter` call. With `BatteryHoldActivityHost` and the proposed `WidgetReloading` protocol, `BatteryHoldActivityCoordinator` can run on tvOS with a null host, or simply not be wired.
4. **Features that don't translate:**
   - Solcast API-key entry (`SolarForecastSettingsSheet.swift:27,100,104`): TV text entry is poor. Make forecast configuration iPhone/Mac-only and sync server-side, or show forecast read-only.
   - `Stepper` (unavailable) in `LoadProfilesSheet.swift` and `battery-hold-setup-section.swift:56`. Battery hold start/stop on TV should be deferred; a read-only status is acceptable.
   - `.refreshable` has no gesture, so use periodic refresh. Foreground polling already exists (`scenePhaseChanged`), and the Trmnl/TV poll cadence rules in `CLAUDE.md` apply: keep Tesla calls cached and server-side.
5. **Persistence:** only Caches/tmp are writable on tvOS. `DashboardCache` already uses Caches; `SolarForecastStore` (Application Support, `:716`) and `LoadProfileStore` (UserDefaults) do not fit.

## macOS: Catalyst vs native

| Option | Effort | Pros | Cons |
|---|---|---|---|
| **Designed for iPad on Mac** (status quo; `UISupportsTrueScreenSizeOnMac`, `project.yml:45`) | 0 | Already works; `.commands` and `.hoverEffect` already appear to be written with it in mind. | No Mac-native widgets or menu bar; Live Activity and Control Center not applicable; iPad window behaviour and fixed 380×520 minimum via `UIWindowScene` (`PWUsageApp.swift:665-668`). |
| **Mac Catalyst** | 2–4 days | Keeps UIKit imports, `Color(uiColor:)`, `.topBar*`, `UIPasteboard`, `ASWebAuthenticationSession` with `UIWindowScene` anchor unchanged. One-flag in XcodeGen (`SUPPORTS_MACCATALYST`). | Catalyst idiom, not native; still no ActivityKit; sandbox and app-group entitlements to verify; a dead end if native Mac features (menu bar extra) are wanted. |
| **Native macOS SwiftUI** | 1.5–3 weeks | Best Mac behaviour: `MenuBarExtra` for live power flow (an excellent fit for this app), `Settings` scene, `Window`/`WindowGroup` sizing, desktop widgets, real toolbars. Reuses ~90% of code. | Needs the colour shim, toolbar placement wrappers, title-mode wrapper, auth anchor, keychain flag, pasteboard, widget bundle split. |

**Recommendation:** go native macOS from a shared core (below). Don't invest in Catalyst except as a fast stopgap, since the work done for native (colour shim, semantic placements) is the same work that also benefits iPadOS.

Mac specifics:

- **Menu commands:** `PWUsageCommands` (`PWUsageApp.swift:89-121`) already defines ⌘R Refresh, ⌘K Switch Site and Sign Out via `.commands`. It works on macOS as written. `CommandMenu("View")` may clash with the system View menu on Mac, so rename or use `CommandGroup(after: .toolbar)`.
- **Window sizing:** replace `configureWindowSizeRestrictions` (`PWUsageApp.swift:665-672`, called at `:628` and `:660`) with `.defaultSize` plus `.windowResizability(.contentMinSize)` and a `.frame(minWidth: 380, minHeight: 520)` on the root, for all platforms. This removes the `UIKit` import for that purpose.
- **Sheets:** `.sheet` with detents behaves as a plain sheet; the Load Profiles and Solar Forecast flows are better as `Settings` or inspector panels on Mac.
- **Single window:** `UIApplicationSupportsMultipleScenes: false` (`project.yml:34`) maps to `Window` rather than `WindowGroup` if one window is wanted.

## Recommended structure

**Shared Swift package + thin app targets, then multiplatform targets in XcodeGen.**

1. **`PWUsageCore` Swift package** (local, `Package.swift`, platforms iOS 18 / macOS 15 / tvOS 18): Models, Networking, Configuration, `DashboardCoordinator`, `LoadProfileStore`, `SolarForecastStore` (with injected storage location), `*Presentation` helpers, `MobileAuthService` core, `BatteryHoldActivityCoordinator`, `TodayEnergySnapshot`.
   - It compiles today on macOS and tvOS (verified above once the ActivityKit/WidgetKit/UIKit coupling is removed).
   - Tests for these (`DashboardCoordinatorTests`, `MobileAuthServiceTests`, `PWUsageAPITests`, etc.) can run with `swift test` on the host in seconds instead of needing a simulator.
   - **Caveat:** the package needs `public` access control on its API surface. The current code is all `internal` in one module, so this is the main mechanical cost of the extraction (about 3–5 days). Doing it as a folder reorganisation first (no package yet) makes the final move cheaper.
2. **`PWUsageUI`** (optional second target or folder): shared SwiftUI components (`PowerFlowLayout`, battery gauge, tiles, `SectionTheme`, `AppTab`) with the colour shim and semantic modifiers.
3. **App targets in `project.yml`:** `PWUsage` (iOS, existing) → add `supportedDestinations: [iOS, macOS]` (XcodeGen 2.46.0 is installed; `supportedDestinations` is supported in current releases) for one multiplatform target, or a separate `PWUsageMac` and `PWUsageTV`. Prefer separate targets for tvOS: its UI, sign-in and storage differ enough that `#if os(tvOS)` inside shared views becomes noise. For macOS, one multiplatform iOS+macOS target is realistic once the shims exist.
4. **Widgets:** keep `PWUsageWidgets` for iOS. Add a macOS widget extension reusing the same widget files without the Live Activity and Control. Alternatively, `#if os(iOS)` those two entries in the bundle.
5. **Tests:** the existing `PWUsageTests` target stays iOS-hosted for view and widget tests (`LoadTimingViewTests`, `today-energy-widget-tests`); core tests move to the package.

### Ordered refactors

Sizes are rough engineering days. **Opportunistic** means safe to do alongside the navigation rework or any nearby edit.

| # | Refactor | Size | Opportunistic? |
|---|---|---|---|
| 1 | **Colour shim:** add `Color.groupedBackground`, `.secondaryGroupedBackground`, `.tertiaryGroupedBackground`, `.secondaryBackground` (`#if canImport(UIKit)` / `AppKit`; tvOS gets its own values) and replace the 24 `Color(uiColor:)` uses. Mostly a mechanical edit. `SectionTheme.swift` already centralises two of them. | 0.5 d | **Yes** (do with the nav rework; it touches the same views) |
| 2 | Move `PWUsageAppModel` and `PWUsageApplicationAPI` out of `PWUsageApp.swift` into `State/`. The `@main` file becomes UI and scene wiring only. | 0.5 d | **Yes** |
| 3 | Semantic toolbar placements (`.primaryAction`, `.cancellationAction`, `.confirmationAction`) instead of `.topBar*`; an `inlineTitle()` wrapper for `navigationBarTitleDisplayMode`; `.hoverEffect()` wrapper. Already in the nav spec. | 0.5 d | **Yes** |
| 4 | Auth seams: `presentationAnchor` and the `UIPasteboard` / `UIWindowScene` uses go behind small `#if` helpers or injected closures; `kSecUseDataProtectionKeychain` helper. | 0.5 d | **Yes** |
| 5 | `AppTab` enum (title, symbol, identity) outside the iOS root view (nav spec). | 0.25 d | **Yes** (already planned) |
| 6 | `WidgetReloading` protocol for `WidgetCenter` / `ControlCenter` calls (`DashboardCache.swift:73-74`, `PWUsageApp.swift:26`); no-op default on tvOS. | 0.5 d | **Yes** |
| 7 | Split `BatteryHoldActivityAttributes.ContentState` from `ActivityAttributes` (or `#if canImport(ActivityKit)`); isolate `ActivityKitBatteryHoldHost`. | 0.5–1 d | Yes |
| 8 | Window sizing via SwiftUI (`defaultSize`, `windowResizability`) replacing `UIWindowScene.sizeRestrictions`. | 0.25 d | Yes |
| 9 | Storage abstraction: inject the base directory into `SolarForecastStore`; define a `PersistentStore` for the UserDefaults-backed stores. | 1 d | Later |
| 10 | Reorganise `Shared/` into Core/UI/iOSOnly folders; split `LoadTimingView.swift` (1,025 lines) and `DashboardView.swift` components. | 1–2 d | Later |
| 11 | Extract `PWUsageCore` Swift package (public API, test migration). | 3–5 d | Do when starting the Mac or tvOS target |
| 12 | Native macOS target: Mac window/scenes, menu bar extra, widget extension, entitlements, app group verification. | 5–10 d | Product decision |
| 13 | Backend device-code login (`/api/mobile/device`, `/login/device`, poll, callback branch) plus tvOS token storage. | 3–5 d (server) + 2 d (client) | Do first for tvOS |
| 14 | tvOS app: TV dashboard, focus, 10-foot type scale, Top Shelf (optional). | 10–15 d | Product decision |

Items 1–8 total about three days and unblock nearly all compile problems. Items 11–14 are the actual ports and should be scheduled only once a Mac or TV product decision is made.

## Risks and unknowns

- Cookie persistence on tvOS, macOS App Group id format, and macOS 26 requirements for `ControlCenter` were checked against SDK headers and probes only, not on devices. Treat them as "verify at port time".
- The whole-target compile errors on the real SDKs were not enumerated (the compiler stops at the first missing module). The per-API table above is the reliable inventory; expect a short list of leftovers when the first macOS build runs.
- `Package.swift` and public access control are the largest hidden cost of the package route. Consider deferring it and starting with a shared folder inside the app target.
