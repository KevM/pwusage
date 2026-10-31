---
name: swift-testing
description: >-
  Guidelines for writing robust, flake-free tests for pwusage's iOS app using Apple's Swift Testing framework (`import Testing`).
  Use whenever writing, updating, or debugging iOS unit tests in cmd/ios-app/PWUsageTests.
---

# Swift Testing Guidelines for `pwusage`

This skill provides rules, patterns, and runbook instructions for authoring unit and integration tests in `cmd/ios-app/PWUsageTests`.

---

## 1. Strictly Prohibited: Legacy `XCTest`

- **Never** import or use `XCTest`, `XCTestCase`, `XCTAssert*`, or `XCTestExpectation`.
- **Always** use Swift Testing:
  ```swift
  import Testing
  ```

---

## 2. Test Suite & Function Anatomy

Define suites using structs annotated with `@Suite`. Name suites and tests with descriptive, human-readable prose:

```swift
import Foundation
import Testing

@MainActor
@Suite("Solar Forecast Store Refresh Behavior")
struct SolarForecastStoreRefreshTests {
    @Test("Refreshes forecast when cache is older than 30 minutes")
    func refreshesWhenCacheStale() async throws {
        let store = SolarForecastStore(clock: MockClock())
        // ...
        #expect(store.isRefreshing)
    }
}
```

### Assertions: `#expect` vs `#require`
- `#expect(a == b)`: Verifies an assertion and records a failure, but continues test execution.
- `#require(optional)`: Unwraps an optional value or throws a failure, halting the current test immediately if nil (replaces `guard let ... else { XCTFail() }`):
  ```swift
  let site = try #require(appModel.sites.first)
  #expect(site.id == "site-123")
  ```
- Testing throws:
  ```swift
  await #expect(throws: NetworkError.self) {
      try await client.fetchForecast()
  }
  ```

---

## 3. Asynchronous State Testing (No Sleep Policy)

> [!CAUTION]
> **Never assert after an arbitrary `Task.sleep`.** Fixed sleeps produce flaky tests under simulator load and slow down test suites.

Always use the project's tested bounded-wait helpers from [`PWUsageTests/test-waits.swift`](file:///Users/kevm/github/pwusage/cmd/ios-app/PWUsageTests/test-waits.swift):

### A. Waiting for State to Change (`eventually`)
When waiting for background tasks or published coordinator properties to reflect a new state:
```swift
try await eventually(timeout: .seconds(2)) {
    coordinator.live.status == .loaded
}
#expect(coordinator.live.data?.batteryPercent == 85)
```

### B. Checking Invariants Do Not Change (`staysTrue`)
When verifying that an event or background tick does *not* trigger an unwanted mutation or side effect:
```swift
try await staysTrue(for: .milliseconds(100)) {
    coordinator.bill.status == .idle
}
```

---

## 4. Parameterized Testing

Use `@Test(arguments:)` to test multiple inputs or boundary conditions cleanly without repeating test boilerplate:

```swift
@Test("Calculates correct grid reserve percentage", arguments: [
    (batteryPercent: 100, target: 80, expectedDelta: 20),
    (batteryPercent: 50, target: 50, expectedDelta: 0),
    (batteryPercent: 20, target: 40, expectedDelta: -20)
])
func reserveCalculations(batteryPercent: Int, target: Int, expectedDelta: Int) {
    let delta = calculateReserveDelta(current: batteryPercent, target: target)
    #expect(delta == expectedDelta)
}
```

---

## 5. Test Doubles and Shared Support

- Place reusable mock services, fake HTTP sessions, and mock clocks in `PWUsageTests/Support/`.
- Use existing preview fixtures from `PWUsage/` (e.g. `PreviewFixture`) when realistic JSON responses or state graphs are needed.

---

## 6. Running Tests Efficiently

Always run tests through the repo runner rather than raw `xcodebuild`:

```bash
# Target a single test suite (fastest iteration)
cmd/ios-app/run-tests.sh SolarForecastStoreRefreshTests

# Target an individual test method
cmd/ios-app/run-tests.sh SolarForecastStoreRefreshTests/refreshesWhenCacheStale

# Run the full suite before submitting PR
cmd/ios-app/run-tests.sh PWUsageTests
```
