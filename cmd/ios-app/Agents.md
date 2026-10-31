# iOS App Guidelines & Preferences

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
  - Non-mutating operations (produce new value) end with `-ed` or `-ing` or are noun phrases: `data.sorted()`, `buffer.reversed()`
- **Argument Labels**:
  - Use prepositions (`for:`, `with:`, `in:`, `from:`, `to:`, `by:`, `at:`) when arguments represent a role or context.
  - Omit argument labels (`_ arg: Type`) only when the first parameter forms a direct grammatical phrase with the function name (e.g., `dismiss(animated: true)`).
- **Casing**:
  - Types and protocols: `UpperCamelCase` (`SiteService`, `BatteryStateProvider`).
  - Functions, properties, variables, and enum cases: `lowerCamelCase` (`batteryState`, `.discharging`, `fetchDailyUsage()`).

## Development & Code Quality
- **Strict Linting & Formatting**: All Swift code must comply with SwiftLint (`swiftlint lint cmd/ios-app --strict --baseline .swiftlint-baseline.json`) and SwiftFormat (`cmd/ios-app/format.sh`).
- **No Force Unwrapping**: Strict prohibition of `!` (force-unwrap or force-try `try!`). Always handle optionals safely (`guard let`, `if let`, nil-coalescing `??`, or throw).
- **Pre-commit Checks**: Before finalizing any task or pushing changes, always run:
  1. `cmd/ios-app/format.sh`
  2. `swiftlint lint cmd/ios-app --strict --baseline .swiftlint-baseline.json` (from repo root)
  3. The full `./run-tests.sh` locally. While iterating, `./run-tests.sh --quick` skips the slow suites in `quick-test-skips.txt`.
  Never push or finish code that introduces new SwiftLint or SwiftFormat violations.
- **Testing Framework**: All native iOS tests must use Swift Testing (`SwiftTest` via `import Testing`, `@Suite`, `@Test`, `#expect`, `#require`). Do not use legacy `XCTest`.
  - For async waits in tests, use `eventually` and `staysTrue` from `PWUsageTests/test-waits.swift`. Never assert after a fixed `Task.sleep`.
- **Budgets (SwiftLint)**:
  - Line length: 120 chars max
  - File length: 400 warning / 500 error
  - Type body length: 350 warning / 450 error
  - Function body length: 50 warning / 100 error
  - Cyclomatic complexity: 10 warning / 20 error
