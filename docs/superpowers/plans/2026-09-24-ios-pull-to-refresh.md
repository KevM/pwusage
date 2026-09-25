# iOS Pull-to-Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add native pull-to-refresh support to the PWUsage iOS application in both the primary Dashboard view and the Bill details view.

**Architecture:** Extend `DashboardCoordinator` with `refreshAll(force:)` and `refreshBill(force:)` methods that bypass cadence timers on force refresh while maintaining in-flight task coalescing, auth guards, and site generation guards, then wire these to `.refreshable` on the root `ScrollView`s in `DashboardView` and `BillView`.

**Tech Stack:** Swift 5.10+, SwiftUI, Swift Testing (`import Testing`, `@Suite`, `@Test`, `#expect`), iOS 17.0+ Simulator.

## Global Constraints

- Native iOS app and tests are in `cmd/ios-app`.
- For every native iOS test run, use `cmd/ios-app/run-tests.sh` (do not invoke `xcodebuild test` directly).
- All iOS tests must use Swift Testing (`import Testing`, `@Suite`, `@Test`, `#expect`), never legacy `XCTest`.
- No `any` types (STRICTLY avoid `any` in TypeScript; in Swift maintain strict typing).
- Do not block responses or introduce unbounded concurrent fetches; coalesce concurrent tasks.

---

### Task 1: Implement `refreshAll` and `refreshBill` on `DashboardCoordinator` with Unit Tests

**Files:**
- Modify: `cmd/ios-app/PWUsage/State/DashboardCoordinator.swift`
- Test: `cmd/ios-app/PWUsageTests/DashboardCoordinatorTests.swift`

**Interfaces:**
- Consumes:
  - `isDue(lastAttempt:interval:at:)`
  - `performLive(siteID:generation:)`
  - `performBill(siteID:generation:)`
- Produces:
  - `func refreshAll(force: Bool = true) async`
  - `func refreshBill(force: Bool = true) async`
  - `func refreshDue() async` (refactored to call `refreshAll(force: false)`)
  - Unit test coverage for force-refreshing live and bill data, force-refreshing bill only, deduplicating concurrent calls, and short-circuiting on `requiresSignIn`.

- [x] **Step 1: Write the failing tests in `DashboardCoordinatorTests.swift`**

Add tests to `DashboardCoordinatorTests.swift`:
```swift
    @Test("Force refreshAll bypasses interval checks and fetches both live and bill")
    func forceRefreshAllBypassesIntervalChecksAndFetchesBoth() async {
        let clock = TestClock()
        let api = DashboardAPISpy()
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, now: { clock.now }, timerInterval: nil)
        coordinator.scenePhaseChanged(isActive: true)
        await coordinator.refreshDue()
        #expect(api.liveSiteIDs == ["site-1"])
        #expect(api.billSiteIDs == ["site-1"])

        // Advance by only 1 minute (neither live 5m nor bill 30m is due)
        clock.advance(minutes: 1)
        await coordinator.refreshAll(force: true)

        #expect(api.liveSiteIDs == ["site-1", "site-1"])
        #expect(api.billSiteIDs == ["site-1", "site-1"])
    }

    @Test("Force refreshBill bypasses interval checks and fetches only bill")
    func forceRefreshBillBypassesIntervalChecksAndFetchesOnlyBill() async {
        let clock = TestClock()
        let api = DashboardAPISpy()
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, now: { clock.now }, timerInterval: nil)
        coordinator.scenePhaseChanged(isActive: true)
        await coordinator.refreshDue()
        #expect(api.liveSiteIDs == ["site-1"])
        #expect(api.billSiteIDs == ["site-1"])

        // Advance by only 1 minute
        clock.advance(minutes: 1)
        await coordinator.refreshBill(force: true)

        #expect(api.liveSiteIDs == ["site-1"])
        #expect(api.billSiteIDs == ["site-1", "site-1"])
    }

    @Test("Concurrent refreshAll and refreshBill coalesce in-flight requests")
    func concurrentRefreshesCoalesceInFlightRequests() async {
        let api = DashboardAPISpy()
        api.holdLive = true
        api.holdBill = true
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, now: { Date(timeIntervalSince1970: 0) }, timerInterval: nil)
        coordinator.scenePhaseChanged(isActive: true)

        let first = Task { await coordinator.refreshAll(force: true) }
        await api.waitUntilLiveRequestStarts()
        let second = Task { await coordinator.refreshAll(force: true) }
        let billOnly = Task { await coordinator.refreshBill(force: true) }

        #expect(api.liveSiteIDs.count == 1)
        #expect(api.billSiteIDs.count == 0)

        api.resumeRequests()
        await first.value
        await second.value
        await billOnly.value

        #expect(api.liveSiteIDs.count == 1)
        #expect(api.billSiteIDs.count == 1)
    }

    @Test("refreshAll and refreshBill early return when requiresSignIn is true")
    func refreshesEarlyReturnWhenRequiresSignIn() async {
        let api = DashboardAPISpy()
        api.liveError = PWUsageAPIError.signInRequired
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, now: { Date(timeIntervalSince1970: 0) }, timerInterval: nil)
        coordinator.scenePhaseChanged(isActive: true)
        await coordinator.refreshDue()
        #expect(coordinator.requiresSignIn)

        let liveCount = api.liveSiteIDs.count
        let billCount = api.billSiteIDs.count

        await coordinator.refreshAll(force: true)
        await coordinator.refreshBill(force: true)

        #expect(api.liveSiteIDs.count == liveCount)
        #expect(api.billSiteIDs.count == billCount)
    }
```

- [x] **Step 2: Run test to verify it fails**

Run: `cmd/ios-app/run-tests.sh DashboardCoordinatorTests`
Expected: FAIL (compiler error: value of type 'DashboardCoordinator' has no member 'refreshAll' / 'refreshBill').

- [x] **Step 3: Implement minimal code to make tests pass**

In `cmd/ios-app/PWUsage/State/DashboardCoordinator.swift`:
```swift
    /// Called by the foreground timer and lifecycle events. Missed intervals collapse to one request.
    func refreshDue() async {
        await refreshAll(force: false)
    }

    /// Refreshes live power readings followed by bill estimates.
    /// When `force` is true, bypasses elapsed cadence checks.
    func refreshAll(force: Bool = true) async {
        guard !requiresSignIn else { return }
        if !force {
            guard isForeground else { return }
        }
        let requestTime = now()
        let generation = siteGeneration

        if liveTask == nil {
            if force || isDue(lastAttempt: live.lastAttempt, interval: Self.liveInterval, at: requestTime) {
                live.lastAttempt = requestTime
                let siteID = selectedSiteID
                liveTask = Task { await performLive(siteID: siteID, generation: generation) }
            }
        }
        // The live endpoint may first import stale energy history. Wait for it
        // before asking the bill endpoint to calculate from that history.
        await liveTask?.value
        guard !requiresSignIn, generation == siteGeneration else { return }
        if !force {
            guard isForeground else { return }
        }

        if billTask == nil {
            if force || isDue(lastAttempt: bill.lastAttempt, interval: Self.billInterval, at: requestTime) {
                bill.lastAttempt = requestTime
                let siteID = selectedSiteID
                billTask = Task { await performBill(siteID: siteID, generation: generation) }
            }
        }

        await billTask?.value
    }

    /// Refreshes the bill estimate.
    /// When `force` is true, bypasses elapsed cadence checks.
    func refreshBill(force: Bool = true) async {
        guard !requiresSignIn else { return }
        if !force {
            guard isForeground else { return }
        }
        let requestTime = now()
        let generation = siteGeneration

        if billTask == nil {
            if force || isDue(lastAttempt: bill.lastAttempt, interval: Self.billInterval, at: requestTime) {
                bill.lastAttempt = requestTime
                let siteID = selectedSiteID
                billTask = Task { await performBill(siteID: siteID, generation: generation) }
            }
        }

        await billTask?.value
    }
```

- [x] **Step 4: Run test to verify it passes**

Run: `cmd/ios-app/run-tests.sh DashboardCoordinatorTests`
Expected: PASS (12 tests pass).

- [x] **Step 5: Commit**

```bash
git add cmd/ios-app/PWUsage/State/DashboardCoordinator.swift cmd/ios-app/PWUsageTests/DashboardCoordinatorTests.swift
git commit -m "feat(ios): implement refreshAll and refreshBill on DashboardCoordinator"
```

---

### Task 2: Attach `.refreshable` to `DashboardView` and `BillView`

**Files:**
- Modify: `cmd/ios-app/PWUsage/Views/DashboardView.swift:16-35`
- Modify: `cmd/ios-app/PWUsage/Views/BillView.swift:12-40`

**Interfaces:**
- Consumes:
  - `coordinator.refreshAll()`
  - `coordinator.refreshBill()`
- Produces:
  - Native pull-to-refresh gesture handling in `DashboardView` and `BillView`.

- [x] **Step 1: Attach `.refreshable` to `DashboardView`'s `ScrollView`**

In `cmd/ios-app/PWUsage/Views/DashboardView.swift`, add `.refreshable { await coordinator.refreshAll() }` to the root `ScrollView`:
```swift
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    if coordinator.live.isUnavailable {
                        AvailabilityBanner(message: "Live data is temporarily unavailable. Showing the last successful reading with its original source time.", symbol: "wifi.exclamationmark")
                    }
                    if coordinator.bill.isUnavailable {
                        AvailabilityBanner(message: "The bill estimate could not be refreshed. Showing the last successful estimate.", symbol: "clock.badge.exclamationmark")
                    }
                    liveSection
                    todaySection
                    billNavigation
                }
                .padding(.horizontal, 20)
                .padding(.top, 14)
                .padding(.bottom, 28)
                .frame(maxWidth: 760)
                .frame(maxWidth: .infinity)
            }
            .refreshable {
                await coordinator.refreshAll()
            }
            .background(Color(uiColor: .systemGroupedBackground))
```

- [x] **Step 2: Attach `.refreshable` to `BillView`'s `ScrollView`**

In `cmd/ios-app/PWUsage/Views/BillView.swift`, add `.refreshable { await coordinator.refreshBill() }` to the root `ScrollView`:
```swift
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if state.isUnavailable {
                    AvailabilityBanner(message: "The estimate could not be refreshed. Any amount shown keeps its original calculation time.", symbol: "clock.badge.exclamationmark")
                }
                if let response {
                    estimateCard(response)
                    periodsSection(response)
                    billMetadata(response)
                } else if state.isUnavailable {
                    EmptyCard(symbol: "doc.text.magnifyingglass", title: "Bill estimate unavailable", message: "The server could not provide a current estimate. Try again when your connection is available.")
                } else {
                    HStack(spacing: 12) {
                        ProgressView()
                        Text("Loading bill estimate")
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(22)
                    .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 20))
                }
            }
            .padding(20)
            .frame(maxWidth: 760)
            .frame(maxWidth: .infinity)
        }
        .refreshable {
            await coordinator.refreshBill()
        }
        .background(Color(uiColor: .systemGroupedBackground))
```

- [x] **Step 3: Run full test suite and test harness to verify everything passes**

Run:
1. `cmd/ios-app/run-tests.sh`
2. `cmd/ios-app/test-run-tests.sh`
Expected: All suites and checks pass.

- [x] **Step 4: Commit changes**

```bash
git add cmd/ios-app/PWUsage/Views/DashboardView.swift cmd/ios-app/PWUsage/Views/BillView.swift docs/superpowers/plans/2026-09-24-ios-pull-to-refresh.md
git commit -m "feat(ios): attach refreshable to DashboardView and BillView"
```
