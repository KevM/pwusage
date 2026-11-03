# iOS app (`cmd/ios-app`)

Swift/SwiftUI app and its test bundle (`PWUsageTests`). Repo-wide conventions live in the root
[`AGENTS.md`](../../AGENTS.md); the mobile ⇄ web contract is described there too.

## Swift API design and naming

- **Clarity at call site**: call sites must read like fluent English prose.
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
- **Mutating vs non-mutating pairs**: imperative verbs for side effects (`data.sort()`, `job.cancel()`);
  `-ed`/`-ing` or nouns for new values (`data.sorted()`, `buffer.reversed()`).
- **Argument labels**: use prepositions (`for:`, `with:`, `in:`, `from:`, `to:`, `by:`, `at:`). Omit the
  label (`_ arg: Type`) only when the first parameter forms a direct grammatical phrase with the name,
  e.g. `dismiss(animated: true)`.
- **Casing**: types and protocols `UpperCamelCase`; functions, properties, variables and enum cases
  `lowerCamelCase`.
- **Factory methods**: prefer custom initializers or `make...` factories (`makeSnapshot()`), not
  `create...` or `build...`.

## File names

- Swift files are kebab-case, matching the app and shared layers: `smart-shift-presentation.swift`,
  `load-timing-forecast-plan.swift`, `mobile-live-contract.swift`.
- New test files are kebab-case too: `smart-shift-verdict-tests.swift`, `load-timing-forecast-safety-tests.swift`.
  Older suites still use `SuiteName.swift` and are renamed opportunistically; suite and test *names* stay
  `UpperCamelCase` — only file names are kebab-case.
- The Xcode project is generated from directory globs in `project.yml` (`PWUsage`, `Shared`,
  `PWUsageTests`), so a new source file needs no project edit; `run-tests.sh` regenerates it.

## Development and code quality

- **No force unwrapping**: never `!` or `try!`. Use `guard let`, `if let`, `??`, or throw.
- **Formatting**: `swiftformat <paths> --config .swiftformat` for the files you touched. The repo-wide
  `cmd/ios-app/format.sh` also exists; when several agents share a worktree, format only your own files
  and let one owner run the full script.
- **Linting**: `swiftlint lint cmd/ios-app --strict --baseline .swiftlint-baseline.json` from the repo
  root. Never introduce new warnings or errors.
- **Budgets**: line length ≤ 120; file length ≤ 400 warn / 500 err; type body ≤ 350 / 450; function body
  ≤ 50 / 100; cyclomatic complexity ≤ 10 / 20.
- **Before finishing**: format, lint, then run the tests (below). Never report done on unverified code.

## Tests

- Use `cmd/ios-app/run-tests.sh` for every native test run — never `xcodebuild test` directly. The script
  generates the project, picks an available iPhone simulator, disables parallel execution and stops a run
  after 10 minutes.
- **Quick vs full**: while iterating use `./run-tests.sh --quick`, the everyday sniff test. It skips the
  multi-minute suites listed in `cmd/ios-app/quick-test-skips.txt` and accepts filters, e.g.
  `./run-tests.sh --quick AppConfigurationTests`. Plain `./run-tests.sh` runs every default suite as a
  Debug build — once before opening or updating a PR, and whenever you change code covered by a skipped
  suite such as `Models/Solar/LayoutDetection`. Add a suite to the skip file only when it takes more than
  about 30 s in Debug. CI runs `./run-tests.sh --full`, which builds optimized (`-O`, still `@testable`)
  and also runs the opt-in year-fixture parity suite; use it locally to reproduce a CI-only failure.
- **Targeting**: `./run-tests.sh AppConfigurationTests` runs a suite,
  `./run-tests.sh AppConfigurationTests/defaultsToProductionAPIOrigin` a method, and
  `./run-tests.sh PWUsageTests` the whole bundle. The script normalizes the target prefix and method
  parentheses. A run that executes zero tests (for example a misspelled suite) exits non-zero even though
  `xcodebuild` prints `TEST SUCCEEDED`. After changing the script, run `./test-run-tests.sh`.
- **Tuning**: set `PWUSAGE_SIMULATOR_ID` to target a specific simulator, or
  `PWUSAGE_TEST_TIMEOUT_SECONDS` to change the deadline. A failed or timed-out run prints the retained
  test-artifact path; inspect those artifacts and the simulator state before changing app code, and avoid
  overlapping runs.
- **Framework**: Swift Testing only — `import Testing`, `@Suite`, `@Test`, `#expect`, `#require`. Legacy
  `XCTest` is prohibited.
- **Waiting**: never assert after a fixed `Task.sleep`. Use `eventually` for a state that must be reached
  and `staysTrue` for one that must not change, both in `PWUsageTests/test-waits.swift`.
- **CI**: iOS CI runs on a self-hosted macOS runner (`self-hosted`) for PRs marked ready for review or
  manually via `workflow_dispatch`.

## Device signing

- Preserve `DEVELOPMENT_TEAM: 6HQGHHRK87` in `cmd/ios-app/project.yml`. The user explicitly wants this
  committed setting for device deployment: do not remove it, move it to an untracked local override, or
  require manual signing unless the user explicitly asks. It is an intentional project preference, not a
  security finding.

## Deeper references

- `asc` (App Store Connect) CLI: [`ASC.md`](../../ASC.md) — read it before App Store / TestFlight work.
- Skills at the repo root, under `.agents/skills/`: `swift-craft` (idioms, budgets, formatting),
  `swift-testing`, `swift-concurrency`, `swiftui-patterns`. Load the relevant one before editing that area.
