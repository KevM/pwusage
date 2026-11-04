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
`first_where`, `contains_over_filter_count`, `untyped_error_in_catch`, and friends). They were
chosen because they have zero violations today; keep them that way. The default rules, including
`blanket_disable_command`, stay on as well.

Rules deliberately not enabled yet, because they still have existing violations:
`prefer_key_path`, `redundant_self`, `optional_enum_case_matching`, `legacy_objc_type`,
`no_grouping_extension`, `no_extension_access_modifier`, `strict_fileprivate`, `modifier_order` and
`convenience_type`. Fix those violations as a separate tranche, then add the rule — do not add a
baseline to hide them.

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

- Use `cmd/ios-app/run-tests.sh` for every native test run — never `xcodebuild test` directly. The
  script generates the project, picks an available iPhone simulator, disables parallel execution
  and stops a run after 10 minutes.
- **Quick vs full**: while iterating use `./run-tests.sh --quick`, the everyday sniff test. It skips
  the multi-minute suites listed in `cmd/ios-app/quick-test-skips.txt` and accepts filters, e.g.
  `./run-tests.sh --quick AppConfigurationTests`. Plain `./run-tests.sh` runs the default suites as
  a Debug build — once before opening or updating a PR. It runs the multi-minute detector parity
  suite only when your branch (committed or not) changes the detector or its fixtures, so do not
  run that suite by hand for unrelated work; `PWUSAGE_DETECTOR_PARITY=1` forces it and `=0` skips
  it. Add a suite to the skip file only when it
  takes more than about 30 s in Debug. CI runs `./run-tests.sh --full`, which builds optimized
  (`-O`, still `@testable`) and also runs the opt-in year-fixture parity suite; use it locally to
  reproduce a CI-only failure.
- **Targeting**: `./run-tests.sh AppConfigurationTests` runs a suite,
  `./run-tests.sh AppConfigurationTests/defaultsToProductionAPIOrigin` a method, and
  `./run-tests.sh PWUsageTests` the whole bundle. The script normalizes the target prefix and method
  parentheses. A run that executes zero tests (for example a misspelled suite) exits non-zero even
  though `xcodebuild` prints `TEST SUCCEEDED`. After changing the script, run `./test-run-tests.sh`.
- **Tuning**: set `PWUSAGE_SIMULATOR_ID` to target a specific simulator, or
  `PWUSAGE_TEST_TIMEOUT_SECONDS` to change the deadline. A failed or timed-out run prints the
  retained test-artifact path; inspect those artifacts and the simulator state before changing app
  code, and avoid overlapping runs.
- **Framework**: Swift Testing only — `import Testing`, `@Suite`, `@Test`, `#expect`, `#require`.
  Legacy `XCTest` is prohibited.
- **Waiting**: never assert after a fixed `Task.sleep`. Use `eventually` for a state that must be
  reached and `staysTrue` for one that must not change, both in `PWUsageTests/TestWaits.swift`.
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
