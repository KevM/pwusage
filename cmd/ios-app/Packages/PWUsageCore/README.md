# PWUsageCore

The pure-Foundation half of the iOS app: value types, wire contracts and their validation, and the
calculations behind them. It builds for iOS and macOS, so its tests run natively on a Mac with no
simulator (`./cmd/ios-app/run-core-tests.sh`). The app and the widget both link it.

Where a new type goes is decided in [`ARCHITECTURE.md`](../../ARCHITECTURE.md#where-code-goes). Each
domain folder under `Sources/PWUsageCore/` has a README that says what it owns and where its app half
lives. A new domain folder gets one too, listed in the target's `exclude` in `Package.swift` so
SwiftPM does not warn about it.

## Conventions

- **Public API is what the app uses.** Mark a type and the members the app reads, calls or builds
  `public`; leave helpers `internal` or `private`. Tests use `@testable import PWUsageCore`.
- **Say `Sendable` explicitly.** A struct is only implicitly `Sendable` inside its own module, so a
  public value type that crosses actors in the app needs the conformance written out.
- **Write the initializer.** Swift's memberwise initializer is never public. When the app, a preview
  or a fixture builds a type, add a `public init` that keeps the same labels and defaults.
- **Copy stays in the app.** When a rule needs user-facing text (a note, a label), take it as a
  parameter or closure, as `SmartShiftEvaluator` does with its forecast note.
- **Platform code stays in the app.** No UIKit, SwiftUI, ActivityKit, WidgetKit, CloudKit, app-group
  containers or `@MainActor` state here. Guard any iOS-only Foundation API with `#if os(iOS)`.
- **Resources stay in the app bundle.** The package declares none, so the widget never carries them.
  Code reads them from `Bundle.main`; tests read the repo copy by path (see
  `Tests/PWUsageCoreTests/Support/CountryBoundariesFixture.swift`).

## Tests

- Tests mirror the source folders: `Tests/PWUsageCoreTests/<Domain>/`.
- JSON fixtures live in `Tests/PWUsageCoreTests/Fixtures/` and load through `Bundle.module`.
- Swift fixtures shared with the simulator suite live in `Tests/PWUsageCoreTests/Support/` and are
  also listed under `PWUsageTests` in `cmd/ios-app/project.yml`, so both suites use one copy.
- `./cmd/ios-app/periphery.sh` finds unused code but cannot see these tests, which run through SwiftPM.
  Mark a declaration only they read with `// periphery:ignore - read by <SuiteName>` above it (and
  above its doc comment).
- A test that needs app state, copy or a platform framework stays in `cmd/ios-app/PWUsageTests`. When
  you move logic here, move its pure tests with it and split any suite that mixes both.
