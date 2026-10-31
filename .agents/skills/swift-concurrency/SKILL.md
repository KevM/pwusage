---
name: swift-concurrency
description: >-
  Guidelines for writing safe, modern Swift concurrency in pwusage's iOS app.
  Covers actor isolation, @MainActor coordinators, structured concurrency, Sendable models,
  and avoiding SwiftLint's unhandled_throwing_task rule violations.
---

# Swift Concurrency Guidelines for `pwusage`

This skill provides patterns for writing reliable asynchronous code, enforcing actor boundaries, and satisfying strict concurrency rules in `cmd/ios-app`.

---

## 1. Actor Isolation & `@MainActor`

State holders that drive SwiftUI views (coordinators, view models, stores) must be isolated to the main thread:

```swift
@MainActor
final class SolarForecastCoordinator: ObservableObject {
    @Published private(set) var state: ForecastState = .idle

    func refresh() async {
        // Automatically runs on the main actor
        state = .loading
        do {
            let forecast = try await apiClient.fetchForecast()
            state = .loaded(forecast)
        } catch {
            state = .failed(error.localizedDescription)
        }
    }
}
```

- When non-isolated helpers or network clients invoke `@MainActor` methods, dispatch safely with `await` or mark closure parameters `@MainActor () -> Void`.
- Avoid unnecessary `@MainActor` annotations on pure data models, value transformations, or background utility actors.

---

## 2. Resolving SwiftLint `unhandled_throwing_task`

The project enables the `unhandled_throwing_task` opt-in rule. Spawning a `Task` that can throw without handling the error fails the build.

### ❌ Prohibited (SwiftLint Error)
```swift
Task {
    try await service.performExport() // Linter error: unhandled throwing task!
}
```

### ✅ Correct Pattern: Explicit Error Handling
```swift
Task {
    do {
        try await service.performExport()
    } catch {
        logger.error("Failed to export: \(error.localizedDescription)")
        self.errorNotice = error.localizedDescription
    }
}
```

---

## 3. Structured Concurrency vs Detached Tasks

### Prefer `async let` for Fixed Concurrent Requests
```swift
async let live = client.fetchLive(for: siteID)
async let power = client.fetchPower(for: siteID)

let (liveResult, powerResult) = try await (live, power)
```

### Prefer `withThrowingTaskGroup` for Dynamic Iterations
```swift
try await withThrowingTaskGroup(of: SiteMetric.self) { group in
    for site in sites {
        group.addTask {
            try await client.fetchMetrics(for: site.id)
        }
    }
    for try await metric in group {
        metrics.append(metric)
    }
}
```

### Avoid `Task.detached`
Do not use `Task.detached` unless explicitly offloading CPU-intensive processing (such as large JSON parsing or geometry calculations) away from the current actor context.

---

## 4. `Sendable` Model Integrity

All contracts and value types exchanged across actor boundaries or concurrency domains must conform to `Sendable`:
- Use `struct` or `enum` composed entirely of `Sendable` properties.
- Avoid capturing mutable class references in escaping `Task` closures.

---

## 5. Cancellation Support

When implementing recurring background loops or polling logic, respect task cancellation:
```swift
while !Task.isCancelled {
    try await Task.sleep(for: .seconds(60))
    try Task.checkCancellation()
    await refresh()
}
```
