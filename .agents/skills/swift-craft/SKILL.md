---
name: swift-craft
description: >-
  Guidelines for writing idiomatic, Swifty code for pwusage's iOS app.
  Use whenever creating, editing, refactoring, or reviewing Swift code in cmd/ios-app.
  Enforces Apple Swift API Design Guidelines, SwiftLint budgets, SwiftFormat, and Swift Testing.
---

# Swift Craft & iOS Quality Guidelines

This skill enforces idiomatic Swift naming conventions, Apple's Swift API Design Guidelines, and strict adherence to SwiftLint and SwiftFormat for `pwusage`'s iOS app.

---

## 1. Swifty Naming Conventions (Apple Swift API Design Guidelines)

### A. Clarity at the Call Site
Code must read like fluid, grammatical English at the site of use:
```swift
// Good
cache.store(snapshot, for: siteID)
userDefaults.register(defaults: initialSettings)
alert.present(on: rootViewController)

// Bad (non-Swifty / Java / Obj-C style)
cache.storeItemForSite(item: snapshot, site: siteID)
userDefaults.registerDefaultsDict(initialSettings)
alert.showOnVC(vc: rootViewController)
```

### B. Omit Needless Words
Do not repeat the type or enclosing context inside property or method names:
```swift
// Good
battery.level
site.refresh()
container.remove(subview)

// Bad
battery.batteryLevel
site.refreshSiteData()
container.removeSubview(subview)
```

### C. No `get` in Accessors
Properties and getters must never begin with `get`:
```swift
// Good
var formattedEnergy: String { ... }
func fetchUsageHistory() async throws -> [UsageEntry] { ... } // asynchronous / network

// Bad
func getFormattedEnergy() -> String { ... }
func getUsageHistory() -> [UsageEntry] { ... }
```

### D. Boolean Assertions
Booleans should read as assertions about the receiver:
```swift
// Good
var isEmpty: Bool
var isRefreshing: Bool
var hasActiveExport: Bool
var canExecuteJob: Bool

// Bad
var empty: Bool
var refreshingFlag: Bool
var checkExport: Bool
```

### E. Side-Effect Naming Rule (Mutating vs. Non-Mutating)
- **Mutating operations** (cause side effects) use imperative verbs:
  `elements.sort()`, `buffer.reverse()`, `job.cancel()`
- **Non-mutating operations** (return a new value) use `-ed` / `-ing` or noun phrases:
  `elements.sorted()`, `buffer.reversed()`, `metrics.cancelingActive()`

### F. Prepositional Argument Labels
Use prepositional labels (`for:`, `with:`, `in:`, `from:`, `to:`, `by:`, `at:`) when arguments represent a role or context:
```swift
// Good
dismiss(animated: true)
energySeries(startingFrom: startDate, to: endDate)
device(for: siteID)

// Bad
dismissWithAnimation(isAnimated: true)
getEnergySeries(startDate, endDate)
getDeviceBySiteId(id: siteID)
```

---

## 2. Swift Idioms & Code Cleanliness

- **No Force Unwrapping**: Strict ban on `!` and `try!`. Always use `guard let`, `if let`, nil-coalescing `??`, or throw errors.
- **Modern Concurrency**: Prefer `async`/`await`, `TaskGroup`, and structured concurrency over completion closures.
- **Value Semantics**: Prefer `struct` and `enum` over `class`.
- **Exhaustive State Modeling**: Use enums with associated values rather than multiple disjoint optionals/booleans.

---

## 3. SwiftLint Budgets & Limits

Ensure all code strictly obeys the project's `.swiftlint.yml` limits:
- **Line length**: 120 chars max
- **File length**: ≤ 400 lines (warning) / 500 lines (error)
- **Type body length**: ≤ 350 lines (warning) / 450 lines (error)
- **Function body length**: ≤ 50 lines (warning) / 100 lines (error)
- **Cyclomatic complexity**: ≤ 10 (warning) / 20 (error)
- **Imports**: Sorted alphabetically (`sorted_imports`)

---

## 4. Swift Testing Standards

All native iOS tests must use **Swift Testing**:
- Import: `import Testing`
- Struct/Suite: `@Suite("Feature description") struct FeatureTests { ... }`
- Test functions: `@Test func descriptiveBehavior() async throws { ... }`
- Assertions: `#expect(...)`, `#require(...)`
- Asynchronous waits: Use `eventually` or `staysTrue` from `PWUsageTests/test-waits.swift`. Never assert after an arbitrary `Task.sleep`.
- **Legacy `XCTest` is strictly prohibited.**

---

## 5. Verification Checklist Before Declaring Done

Always execute these commands in sequence whenever modifying Swift files:

1. **Format**:
   ```bash
   cmd/ios-app/format.sh
   ```
2. **Lint**:
   ```bash
   swiftlint lint cmd/ios-app --strict --baseline .swiftlint-baseline.json
   ```
   *Any warning is considered a failure. Fix all warnings before proceeding.*
3. **Run Tests**:
   ```bash
   cmd/ios-app/run-tests.sh
   ```
