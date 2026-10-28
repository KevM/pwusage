# iOS Architecture

## Folder contract
- `App/` — App entry point, commands, application API, root view, and `PWUsageAppModel`.
- `Navigation/` — Tab definitions and `AppTabView`.
- `Views/<Feature>/` — Feature screens, sheets, and feature-specific views.
- `Views/Shared/` — Cross-feature primitives (`CardContainer`, `SectionTheme`, `portable-modifiers`, `clipboard`, `AvailabilityBanner`, `EmptyCard`, `LoadingCard`, `EmptyStateScreen`).
- `State/<Feature>/` — Feature coordinators/stores/actors.
- `Models/<Feature>/` — Feature value types/contracts.
- `Networking/` — API clients and network policy.
- `Authentication/` — Auth service and session handling.
- `Shared/` — Cross-target code shared by app and widget.
- `PWUsageWidgets/` — Widget extension.
- `PWUsageTests/<Feature>/` — Feature tests; `PWUsageTests/Support/` holds shared doubles/clocks.

## Ownership
- A file belongs to the feature whose screen or lifecycle consumes it.
- Cross-target code lives in `Shared`.
- `Models` holds value types only.
- `State` holds coordinators, stores, and actors.
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
- Tests: `cd cmd/ios-app && ./run-tests.sh` (or `./run-tests.sh <Suite>`)
- Format: `swiftformat cmd/ios-app --config .swiftformat` or `./cmd/ios-app/format.sh`
- Lint: `swiftlint lint --strict --baseline .swiftlint-baseline.json` (remove `--baseline` once zero)
- Dead code scan: `cd cmd/ios-app && ./periphery.sh`
