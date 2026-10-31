# Swift & iOS Guidelines

## Swift API Design Guidelines & Swifty Naming Conventions
- **Clarity at Call Site**: Every method and function call must read fluently like clean English prose.
  - Good: `cache.store(item, for: key)`, `list.insert(element, at: index)`
  - Avoid: `cache.storeItemWithKey(item, key)`, `list.insertElementAtIndex(element, index)`
- **Omit Needless Words**: Do not repeat type names or enclosing context in method and property names.
  - Good: `site.refresh()`, `battery.level`, `view.add(child)`
  - Avoid: `site.refreshSite()`, `battery.batteryLevel`, `view.addChildView(child)`
- **No `get` Prefixes for Getters**: Accessor properties or methods must not start with `get`. Use noun phrases or properties.
  - Good: `user.profile`, `device.status`, `fetchMetrics()` (if async/throwing)
  - Avoid: `user.getProfile()`, `device.getStatus()`
- **Boolean Naming**: Boolean properties and arguments must read as assertions about the receiver.
  - Good: `isEmpty`, `hasData`, `canSave`, `isRefreshing`, `animated: true`
  - Avoid: `empty`, `dataFlag`, `checkSaving()`, `withAnimation: true`
- **Mutating vs Non-Mutating Pairs**:
  - Mutating operations (side effect) are imperative verbs: `data.sort()`, `buffer.reverse()`, `job.cancel()`
  - Non-mutating operations (produce new value) end with `-ed` or `-ing` or are noun phrases: `data.sorted()`, `buffer.reversed()`, `metrics.cancelingActive()`
- **Argument Labels**:
  - Use prepositions (`for:`, `with:`, `in:`, `from:`, `to:`, `by:`, `at:`) to establish grammatical relationships.
  - Omit argument labels (`_ arg: Type`) only when the first parameter forms a direct grammatical phrase with the function name (e.g., `dismiss(animated: true)`, `min(x, y)`).
- **Casing**:
  - Types and protocols: `UpperCamelCase` (`SiteService`, `BatteryStateProvider`).
  - Functions, properties, variables, and enum cases: `lowerCamelCase` (`batteryState`, `.discharging`, `fetchDailyUsage()`).
- **Factory Methods & Initializers**:
  - Prefer custom initializers or factory methods with `make...` (e.g., `makeSnapshot()`), not `create...` or `build...`.

## Swift Idioms & Modern Practices
- **No Force Unwrapping**: Never use `!` (force unwrap) or `try!`. Use `guard let`, `if let`, nil-coalescing (`??`), or propagate errors with `throws`.
- **Exhaustive Modeling**: Prefer Swift `enum` with associated values over multiple booleans and loose optionals for representing component or network states.
- **Modern Concurrency**: Use `async`/`await`, `TaskGroup`, and actors. Avoid legacy closure completion callbacks (`@escaping (Result<T, Error>) -> Void`).
- **Value Types First**: Default to `struct` and `enum`. Use `class` only when reference identity, inheritance, or Objective-C interop is strictly required.

## SwiftLint Budgets & Zero-Violation Rule
- **Enforce Budgets**:
  - Line length: 120 characters max
  - File length: 400 warning / 500 error
  - Type body length: 350 warning / 450 error
  - Function body length: 50 warning / 100 error
  - Cyclomatic complexity: 10 warning / 20 error
- **Opt-in Rules**: Always adhere to `sorted_imports`, `empty_count`, `force_unwrapping`, and `unhandled_throwing_task`.
- **Zero Warnings Tolerance**: Treat all SwiftLint warnings as errors in newly authored or modified code.

## Mandatory iOS Pre-Completion Verification
Before claiming any iOS / Swift task is complete:
1. Format: Run `cmd/ios-app/format.sh` (or `swiftformat cmd/ios-app --config .swiftformat`).
2. Lint: Run `swiftlint lint cmd/ios-app --strict --baseline .swiftlint-baseline.json` from the repository root. All checks must pass with zero new warnings or errors.
3. Test: Run `cmd/ios-app/run-tests.sh` to ensure all tests pass.
4. Testing Framework: All tests must use Swift Testing (`import Testing`, `@Suite`, `@Test`, `#expect`, `#require`). Never use `XCTest`.
