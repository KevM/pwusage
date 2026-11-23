# iOS app (`cmd/ios-app`)

Swift/SwiftUI app, widget extension and test bundle (`PWUsageTests`). Repo-wide conventions live in
the root [`AGENTS.md`](../../AGENTS.md); the mobile ⇄ web contract is described there too.

## Fast path

After any Swift edit, run one command from the repository root:

```bash
./cmd/ios-app/lint.sh        # SwiftFormat check + SwiftLint; safe in sandboxes
./cmd/ios-app/lint.sh --fix  # apply SwiftFormat, then lint
```

`lint.sh` passes `--no-cache` to SwiftLint. A bare `swiftlint` can try to write
`~/Library/Caches`, which agent sandboxes block; it then exits non-zero **after** printing
"Found 0 violations". That false failure is why linting used to take so long. Use the wrapper.

The SwiftLint baseline is empty and the file is gone. There is no "my violation vs legacy debt"
bookkeeping any more: `--strict` must report zero. Never add a baseline entry or a
`swiftlint:disable` comment to get green — fix the code or ask.

## Swift API design and naming

- **Clarity at call site**: call sites read like fluent English prose.
  - Good: `cache.store(item, for: key)`, `list.insert(element, at: index)`
  - Avoid: `cache.storeItemWithKey(item, key)`, `list.insertElementAtIndex(element, index)`
- **Omit needless words**: do not repeat type names or enclosing context.
  - Good: `site.refresh()`, `battery.level`, `view.add(child)`
  - Avoid: `site.refreshSite()`, `battery.batteryLevel`, `view.addChildView(child)`
- **No `get` prefixes for getters**: use noun phrases or properties.
  - Good: `user.profile`, `device.status`, `fetchMetrics()` (when async/throwing)
  - Avoid: `user.getProfile()`, `device.getStatus()`
- **Boolean naming**: read as assertions about the receiver.
  - Good: `isEmpty`, `hasData`, `canSave`, `isRefreshing`, `animated: true`
  - Avoid: `empty`, `dataFlag`, `checkSaving()`, `withAnimation: true`
- **Mutating vs non-mutating pairs**: imperative verbs for side effects (`data.sort()`,
  `job.cancel()`); `-ed`/`-ing` or nouns for new values (`data.sorted()`, `buffer.reversed()`).
- **Argument labels**: use prepositions (`for:`, `with:`, `in:`, `from:`, `to:`, `by:`, `at:`).
  Omit the label (`_ arg: Type`) only when the first parameter forms a direct grammatical phrase
  with the name, for example `dismiss(animated: true)`.
- **Casing**: types and protocols `UpperCamelCase`; functions, properties, variables and enum cases
  `lowerCamelCase`.
- **Factory methods**: prefer custom initializers or `make...` factories (`makeSnapshot()`), not
  `create...` or `build...`.

## Swift idioms (the long run)

- **Value types first**: default to `struct`/`enum`; use `class` for identity, inheritance,
  `ObservableObject` or Objective-C interop.
- **Model states with enums**, not combinations of booleans and optionals. Give associated values
  names when the payload is not obvious.
- **`let` by default**. `var` only when the value actually changes.
- **Early exit with `guard`**; keep the happy path unindented.
- **No force unwrapping and no `try!`**: `guard let`, `if let`, `??`, or `throws`. Do not use
  `try?` to silently discard an error the caller needs.
- **Structured concurrency**: `async`/`await`, `async let`, task groups and actors. No new
  completion-handler APIs or `DispatchQueue.main.async` in app code.
- **Isolation is explicit**: UI state on `@MainActor`; models crossing actor boundaries are
  `Sendable`; use `@Observable` for new observable state and follow the existing
  `ObservableObject` coordinators where they already exist.
- **Opaque vs existential**: `some View`/`some Collection` for concrete returns, `any Protocol` when
  the concrete type must vary. Do not reach for `Any`.
- **Format with `FormatStyle`** for user-facing numbers, currency, dates and durations; do not
  hand-roll separators or date strings.
- **Small view bodies**: extract subviews or `@ViewBuilder` sections before a body gets large. CI
  builds with `-O`, where one oversized SwiftUI expression can fail with
  "the compiler is unable to type-check this expression in reasonable time". Breaking the view up
  is the fix, not adding explicit types until it compiles.
- **File names are `UpperCamelCase`** (`SmartShiftPresentation.swift`) and match the primary type.
  Extension-only files use `Type+Feature.swift` (`DashboardCoordinator+Refresh.swift`); test files
  use `SuiteNameTests.swift`, with `SuiteNameTests+Feature.swift` for extensions. Cohesive
  multi-type files may use a descriptive feature name until they are split. The Xcode project is
  generated from directory globs in `project.yml`, so a new source file needs no project edit;
  `run-tests.sh` regenerates it. Shell scripts, YAML, Markdown, and JSON fixtures stay kebab-case.

## Write lint-clean the first time

Budgets from `.swiftlint.yml`:

| Check | Limit |
| --- | --- |
| Line length | 120 characters |
| File length | 400 warn / 500 error |
| Type body | 350 warn / 450 error |
| Function body | 50 warn / 100 error |
| Cyclomatic complexity | 10 warn / 20 error |
| Nesting | type 1 / function 2 |
| Large tuple | 2 warn / 3 error |
| Function parameters | 5 warn / 8 error |

Common fixes, in the order agents hit them:

- **`line_length`**: wrap at argument commas and keep continuation lines aligned with the existing
  Xcode style. Do not shorten names or copy just to fit; split the expression.
- **`function_body_length`**: extract a private helper or a `@ViewBuilder` section. If the helper
  needs six parameters, group them into a small struct.
- **`type_body_length`**: move a cohesive group into an extension in the same file, or split the
  type into a new UpperCamelCase file.
- **`function_parameter_count`**: pass a small value type instead of a long parameter list.
- **`force_unwrapping` / `force_try`**: `guard let`, `??`, `#require` in tests, or throw. For a
  genuinely impossible state, `preconditionFailure("why")` is acceptable; a bare `!` is not.
- **Naming rules** (`identifier_name`, `type_name`): rename; do not suppress.

`swiftlint --fix` is **not** safe repo-wide. `statement_position` collapses `do`/`catch` into
200-character lines, and `redundant_discardable_let` emits code that fails inside a `ViewBuilder`.
Fix by hand or use `./cmd/ios-app/lint.sh --fix`, which only runs SwiftFormat.

The opt-in rules in `.swiftlint.yml` enforce the collection and state idioms above (`toggle_bool`,
`first_where`, `contains_over_filter_count`, `untyped_error_in_catch`, and friends). Every opt-in
rule passes with zero violations today; keep it that way. Add a rule only when it is clean, and fix
the code rather than removing the rule or adding a baseline. `swiftlint --fix` remains unsafe
repo-wide, but the narrow form (`swiftlint lint --fix --only-rule <rule>`) is how the mechanical
tranche fixes were applied.

## Color

`Color.emphasis` (Cerulean, `Shared/Color+Emphasis.swift`) is the one emphasis color, and the app's
and widgets' accent color. Use it for the thing to look at: a recommendation, a projection, a primary
action. Do not add another tint for emphasis, and do not use purple or indigo. Put `Color.onEmphasis`
on an emphasis fill, and use `.emphasisProminentButton()` for primary buttons, because white is unreadable on
the dark mode fill. Data colors keep their
meaning: solar is orange, Home is blue, battery and banked energy are green, owed energy is orange.
Red is a status color for Smart Shift’s most-expensive mark.

## Formatting and linting

- `./cmd/ios-app/lint.sh` — check SwiftFormat and SwiftLint (recommended).
- `./cmd/ios-app/lint.sh --fix` — apply SwiftFormat, then run SwiftLint.
- `./cmd/ios-app/format.sh` — format-only wrapper; `lint.sh --fix` is the better default.
- CI runs the same `./cmd/ios-app/lint.sh` (it switches SwiftLint to the GitHub reporter under
  Actions), so a clean local run is a clean CI lint. The raw SwiftLint equivalent is
  `swiftlint lint cmd/ios-app --strict --no-cache`; never drop `--no-cache` in a sandbox.

The formatter and linter now agree on trailing commas (`.swiftformat` sets
`--trailing-commas never`). Do not reintroduce trailing commas in multiline collection literals.

## Tests

- **Core package tests (macOS)**: Use `cmd/ios-app/run-core-tests.sh` for pure-Foundation compute
  suites (`SolarLayout`, `SolarHealth`, `SolarForecast`, `BillPricing`, `LoadTiming`) in `Packages/PWUsageCore`. It runs
  `swift test` natively on macOS with zero simulator overhead:
  - `./cmd/ios-app/run-core-tests.sh` — optimized (`-c release`) build, fast everyday loop (~33 s for all default suites).
  - `./cmd/ios-app/run-core-tests.sh --debug` — unoptimized (`-c debug`) build.
  - `./cmd/ios-app/run-core-tests.sh --full` — `-c release` with `PWUSAGE_SOLAR_SLOW_PARITY=1` for opt-in year-fixture and 10-year health suites.
  - Supports Swift Testing filters, e.g. `./cmd/ios-app/run-core-tests.sh --filter BillPricingParityTests`.
- **Simulator tests**: Use `cmd/ios-app/run-tests.sh` for every iOS simulator test run — never `xcodebuild test` directly. The
  script generates the project, picks an available iPhone simulator, disables parallel execution
  and stops a run after 10 minutes.
- **Quick vs full**: while iterating use `./run-tests.sh --quick`, the everyday sniff test. It skips
  any suites listed in `cmd/ios-app/quick-test-skips.txt` and accepts filters, e.g.
  `./run-tests.sh --quick AppConfigurationTests`. Plain `./run-tests.sh` runs the Debug simulator
  suites — once before opening or updating a PR. CI runs `core-tests` (`./run-core-tests.sh`) in
  parallel with `test` (`./run-tests.sh`), so `main` and PRs share one Debug DerivedData cache.
- **Targeting**: `./run-tests.sh AppConfigurationTests` runs a suite,
  `./run-tests.sh AppConfigurationTests/defaultsToProductionAPIOrigin` a method, and
  `./run-tests.sh PWUsageTests` the whole bundle. The script normalizes the target prefix and method
  parentheses. A run that executes zero tests (for example a misspelled suite) exits non-zero even
  though `xcodebuild` prints `TEST SUCCEEDED`. After changing the script, run `./test-run-tests.sh`.
- **Tuning**: set `PWUSAGE_SIMULATOR_ID` to target a specific simulator, or
  `PWUSAGE_TEST_TIMEOUT_SECONDS` to change the deadline, which covers the build and the test run
  together. The simulator boots in the background while the tests build (`build-for-testing`, then
  `test-without-building`), under its own `PWUSAGE_SIMULATOR_BOOT_TIMEOUT_SECONDS` (900 by
  default). A failed or timed-out
  run prints the retained test-artifact path; inspect those artifacts and the simulator state
  before changing app code, and avoid overlapping runs.
- **Framework**: Swift Testing only — `import Testing`, `@Suite`, `@Test`, `#expect`, `#require`.
  Legacy `XCTest` is prohibited.
- **Waiting**: never assert after a fixed `Task.sleep`. Use `eventually` for a state that must be
  reached and `staysTrue` for one that must not change, both in `PWUsageTests/TestWaits.swift`.
- **Fakes**: a fake's `async` protocol methods run off the main actor and can overlap, so an
  `@unchecked Sendable` fake keeps what it records behind a lock. Unguarded appends crashed the
  simulator's test host on CI.
- **CI**: iOS CI runs on a GitHub-hosted macOS runner for PRs marked ready for review or manually
  via `workflow_dispatch`.

## Device signing

- Preserve `DEVELOPMENT_TEAM: 6HQGHHRK87` in `cmd/ios-app/project.yml`. The user explicitly wants
  this committed setting for device deployment: do not remove it, move it to an untracked local
  override, or require manual signing unless the user explicitly asks. It is an intentional project
  preference, not a security finding.

## Deeper references

- `asc` (App Store Connect) CLI: [`ASC.md`](../../ASC.md) — read it before App Store / TestFlight
  work.
- Architecture and folder contract: [`ARCHITECTURE.md`](./ARCHITECTURE.md).
- Open iOS audit findings and their live queue: [`CODE_AUDIT.md`](../../CODE_AUDIT.md) — start at
  the queue, not the historical prose below it.
- Skills at the repo root, under `.agents/skills/`: `swift-craft` (idioms, budgets, formatting),
  `swift-testing`, `swift-concurrency`, `swiftui-patterns`. Load the relevant one before editing
  that area.
