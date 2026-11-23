# iOS Architecture

## Folder contract
- `App/` — App entry point, commands, application API, root view, and `PWUsageAppModel`.
- `Navigation/` — Tab definitions and `AppTabView`.
- `Views/<Feature>/` — Feature screens, sheets, and feature-specific views.
- `Views/Shared/` — Cross-feature primitives (`CardContainer`, `SectionTheme`, `View+PortableModifiers`, `Clipboard`, `AvailabilityBanner`, `EmptyCard`, `LoadingCard`, `EmptyStateScreen`).
- `State/<Feature>/` — Feature coordinators/stores/actors.
- `Models/<Feature>/` — App-side feature types: presentation, copy and observable editor models. Value types
  and contracts go in `PWUsageCore` (see [Where code goes](#where-code-goes)).
- `Networking/` — API clients and network policy.
- `Authentication/` — Auth service and session handling.
- `Shared/` — Cross-target code shared by app and widget.
- `PWUsageWidgets/` — Widget extension.
- `Packages/PWUsageCore/` — Local Swift Package with the pure-Foundation domains, tested natively on macOS.
  See [its README](Packages/PWUsageCore/README.md) and the domain table below.
- `PWUsageTests/<Feature>/` — Feature tests; `PWUsageTests/Support/` holds shared doubles/clocks.

## File naming
- Swift source files are `UpperCamelCase` and match the primary type (`DashboardCoordinator.swift`).
- Extension-only files use `Type+Feature.swift` (`DashboardCoordinator+Refresh.swift`, `Array+PartitionPoint.swift`).
- Test files use `SuiteNameTests.swift`; test extensions use `SuiteNameTests+Feature.swift`.
- Cohesive grouping, fixture, and support files may use a descriptive `UpperCamelCase` name when no single type owns the file.
- Shell scripts, YAML, Markdown, assets, and JSON fixtures keep their existing kebab-case names.

## Where code goes

Read the `README.md` in a folder before adding to it; the domain READMEs below say what each one owns.

**`PWUsageCore` by default.** Value types, wire contracts and their validation, and pure calculations go
in `Packages/PWUsageCore/Sources/PWUsageCore/<Domain>/`, with tests in
`Packages/PWUsageCore/Tests/PWUsageCoreTests/<Domain>/`. Its tests run on a Mac in seconds.

**The app keeps** what needs the app:

- views, presentation and user-facing copy;
- `@MainActor` and observable state, coordinators and stores;
- persistence that needs the app (app-group containers, file protection, CloudKit) and API transport;
- anything that imports UIKit, SwiftUI, ActivityKit, WidgetKit or another platform framework;
- bundled resources, which core code reads from `Bundle.main`.

**Split mixed code.** Put the rule in core with plain inputs and keep a thin app wrapper that supplies
state or copy: `SmartShiftPresentation.evaluate` passes its forecast note to `SmartShiftEvaluator`, and
`SiteHistoryOnboarding` passes stored progress to `SiteHistoryCheckpoints`. The package's
[conventions](Packages/PWUsageCore/README.md#conventions) cover public API, `Sendable` and initializers.

| Core domain | Owns |
| --- | --- |
| [`BatteryHold`](Packages/PWUsageCore/Sources/PWUsageCore/BatteryHold/README.md) | Battery Saver wire models, commands, reserve plan |
| [`BillPricing`](Packages/PWUsageCore/Sources/PWUsageCore/BillPricing/README.md) | Bill pricing and outlook, rate plan editing, tariff contracts |
| [`LoadTiming`](Packages/PWUsageCore/Sources/PWUsageCore/LoadTiming/README.md) | Smart Shift Jobs, estimator, projection choice, diagnostics |
| [`Savings`](Packages/PWUsageCore/Sources/PWUsageCore/Savings/README.md) | Savings report, scenarios, rate growth, payback |
| [`SharedModels`](Packages/PWUsageCore/Sources/PWUsageCore/SharedModels/README.md) | Live dashboard and other cross-domain contracts, widget snapshot |
| [`SiteCountry`](Packages/PWUsageCore/Sources/PWUsageCore/SiteCountry/README.md) | Site country from the saved home location |
| [`SolarForecast`](Packages/PWUsageCore/Sources/PWUsageCore/SolarForecast/README.md) | Solar forecast providers, service, history, correction |
| [`SolarHealth`](Packages/PWUsageCore/Sources/PWUsageCore/SolarHealth/README.md) | Solar health scoring and the manual layout model |
| [`SolarLayout`](Packages/PWUsageCore/Sources/PWUsageCore/SolarLayout/README.md) | Layout detection, layout record and merge, onboarding checkpoints |

## Ownership
- A file belongs to the feature whose screen or lifecycle consumes it.
- Cross-target code lives in `Shared`.
- `State` holds app coordinators, stores, and actors.
- A declaration belongs in one place; access-level changes are only to promote `private`/`fileprivate` to `internal` for cross-file extensions.

## Dynamic entry points (retained)
- `@main` app entry points, `WidgetBundle`, `Widget`, `ControlWidget`, `AppIntent`, `ActivityAttributes`/Live Activities
- `UIViewControllerRepresentable` delegates
- `#Preview`
- Codable synthesized members
- Protocol witnesses and test doubles

## Budgets (SwiftLint)
- Line length: 120
- File length: 400 warning / 500 error
- Type body length: 350 warning / 450 error
- Function body length: 50 warning / 100 error
- Cyclomatic complexity: 10 warning / 20 error
- Nesting: type 1 / function 2
- Large tuple: 2 warning / 3 error
- Function parameter count: 5 warning / 8 error

## Commands
- Generate project: `cd cmd/ios-app && xcodegen generate`
- Build: `cd cmd/ios-app && xcodebuild -project PWUsage.xcodeproj -scheme PWUsage -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build`
- Core package tests (macOS): `cd cmd/ios-app && ./run-core-tests.sh` (`--debug`, `--full`, `--filter <pattern>`)
- Simulator tests: `cd cmd/ios-app && ./run-tests.sh` (or `./run-tests.sh <Suite>`)
- Format + lint: `./cmd/ios-app/lint.sh` (add `--fix` to apply SwiftFormat first)
- Format only: `swiftformat cmd/ios-app --config .swiftformat` or `./cmd/ios-app/format.sh`
- Lint only: `swiftlint lint cmd/ios-app --strict --no-cache`
- Dead code scan: `cd cmd/ios-app && ./periphery.sh`
