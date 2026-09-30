# iOS Audit Correctness Tail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the five confirmed iOS audit defects (§5.5, §5.7 a+b, §5.8, §5.12, §8.18) and §2's eight surviving quick wins, leaving an accurate cross-PR ledger for the remaining audit findings.

**Architecture:** Each finding is one commit with its own TDD cycle. §5.5 introduces a distinct persistence-failure result that never quarantines a credential and keeps the forecast on screen behind a new note; §5.8 makes the planning context tolerant of a device clock behind the server and evicts a poisoned cache entry; §5.7 hardens two clock comparisons; §8.18 moves the battery glyph mapping onto the already-tested presentation layer; §5.12 contains test-fixture crashes to a single test.

**Tech Stack:** Swift 6, SwiftUI, Swift Testing, iOS 18 target, XcodeGen (`./generate.sh`)

**Spec:** [`docs/superpowers/specs/2026-09-30-ios-audit-correctness-tail-design.md`](../specs/2026-09-30-ios-audit-correctness-tail-design.md)

---

## Ground rules for every task

- **Run every native test through `./run-tests.sh`.** Never `xcodebuild test` directly. Bare
  `./run-tests.sh` is the full suite; `./run-tests.sh <SuiteName>` targets one suite *type*.
- **`-only-testing` filters on the suite type, not the file.** Targeting `LoadTimingViewTests` silently
  skips `LoadTimingForecastPresentationTests` and reports a false green — and both types live in the
  *same file*, `PWUsageTests/LoadTimingViewTests.swift` (the second suite is declared at line 285).
  After any change that could affect a sibling suite, run the **full** suite, not just the one you
  edited. Both can be targeted by type name: `./run-tests.sh LoadTimingForecastPresentationTests`.
- **Zero Swift compiler warnings is a gate**, checked after every task, not just at the end:
  ```bash
  cd cmd/ios-app && ./generate.sh && xcodebuild -project PWUsage.xcodeproj -scheme PWUsage \
    -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build 2>&1 | tail -5
  ```
  Expected: `** BUILD SUCCEEDED **` and no `warning:` lines. `appintentsmetadataprocessor` metadata
  extraction is an unrelated toolchain note and is not a warning.
- **No `any`.** Explicit types on every parameter and return. — `AGENTS.md`
- **Flip the `CODE_AUDIT.md` `Status` bullet in the same commit as the fix.** Not batched. If a
  finding's `Location` lines shifted, re-derive them and say in the `Confidence` bullet that the
  numbers now name the amended code, not the pre-fix code the audit read.
- **No XCTest.** Swift Testing only.

## File structure

| File | Responsibility | Touched by |
| --- | --- | --- |
| `PWUsage/State/SolarForecastStore.swift` | Forecast cache, request budget, persistence, credential lifecycle | §5.5 |
| `PWUsage/State/DashboardCoordinator.swift` | Session-scoped orchestration, cadence, forecast/planning-context plumbing | §5.5, §5.7, §5.8 |
| `PWUsage/Models/MobileContracts.swift` | Wire DTOs, decode-time validation, contract invariants | §5.8 |
| `PWUsage/Views/LoadTimingForecastPresentation.swift` | Pure forecast-overlay builder and note copy | §5.5, §5.7 |
| `PWUsage/Views/DashboardView.swift` | Dashboard screen, battery header, metric tiles | §8.18, §2 |
| `PWUsage/Views/DashboardPresentation.swift` | Pure dashboard formatting (already unit-tested) | §8.18 |
| `PWUsage/Views/LoadTimingView.swift` | Load timing screen; owns the overlay call site | §5.5, §2 |
| `PWUsage/Networking/PWUsageAPI.swift` | Mobile contract HTTP client | §2 |
| `PWUsage/Models/LoadProfile.swift` | Load profile model | §2 |
| `PWUsage/Views/SolarForecastSettingsSheet.swift` | Solcast connection settings UI | §2 |
| `PWUsage/Views/SolarForecastPreviews.swift` | Preview fixtures | §2 |
| `PWUsage/Views/DashboardPreviews.swift` | Preview fixtures | §2 |
| `PWUsageTests/SolarForecastStoreTests.swift` | Store behaviour + persistence-failure doubles | §5.5 |
| `PWUsageTests/DashboardCoordinatorTests.swift` | Coordinator behaviour | §5.12, §5.8, §5.7, §5.5 |
| `PWUsageTests/MobileContractsTests.swift` | Contract validation | §5.8 |
| `PWUsageTests/DashboardPresentationTests.swift` | Pure dashboard formatting | §8.18 |
| `PWUsageTests/LoadTimingViewTests.swift` | Two suites: `LoadTimingViewTests` and `LoadTimingForecastPresentationTests` (declared at `:285`) — the pure overlay builder | §5.5, §5.7 |
| `PWUsageTests/SolarForecastCoordinatorTests.swift` | Coordinator + settings-sheet behaviour | §5.5 |
| `PWUsageTests/PWUsageAppModelTests.swift` | App model | §5.12 |
| `PWUsageTests/MobileAuthServiceTests.swift` | Auth service | §5.12 |

No files are created. No files are split — §9.9's `LoadTimingView.swift` split is out of scope.

---

## Task 0: Baseline

Establishes the zero-warning build and green suite that every later task is measured against. If the
baseline is not green, stop and report — a pre-existing failure is not this branch's to fix.

- [ ] **Step 1: Run the full suite**

  ```bash
  cd cmd/ios-app && ./run-tests.sh
  ```

  Expected: every suite passes, exit 0. Note the pass count.

- [ ] **Step 2: Confirm the zero-warning build**

  ```bash
  cd cmd/ios-app && xcodebuild -project PWUsage.xcodeproj -scheme PWUsage \
    -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build 2>&1 | grep -c "warning:"
  ```

  Expected: `0`. Anything else means the tree is not at the state the audit describes.

- [ ] **Step 3: Record the DiagnosticReports count** — the §5.12 before-evidence

  ```bash
  ls ~/Library/Logs/DiagnosticReports/ 2>/dev/null | grep -c "^PWUsage-" || echo 0
  ```

  Expected: some number `N`. Task 3 re-measures this and requires it not to grow.

No commit — nothing has changed.

---

## Task 1: §5.5 — a save failure must not destroy a working Solcast key

The defect: `performRefresh` writes the cache, then `try await persist()`
(`SolarForecastStore.swift:427`) throws. That call sits **inside** the same `do` block as the fetch,
so it lands in the generic `catch` at `:434` → `persistFailureState` → if persisting *again* fails,
`quarantineCredential` **deletes the Keychain item**. The only fault is a disk failure, yet a
working API key is destroyed.

**No existing test covers this path.** The two quarantine tests
(`failedRateLimitPersistenceQuarantinesAcrossRestart` `:560`,
`failedPartialRefreshPersistenceQuarantinesAcrossRestart` `:577`) both drive a *request* failure, so
quarantine is correct there. They must stay green untouched — they are the tripwire proving this fix
narrows the safety valve rather than removing it.

### Step 1: Extend the persistence double to fail N consecutive saves

The existing `failNextSaveAfter(successfulSaves:)` clears its counter when it throws, so it cannot
produce the **double** save failure §5.5 needs.

In `PWUsageTests/SolarForecastStoreTests.swift`, inside `private actor TestSolarForecastFiles`, add
the stored property next to `successfulSavesBeforeFailure`:

```swift
    private var successfulSavesBeforeFailure: Int?
    private var consecutiveSavesToFail = 0
```

Insert the check as the **first** failure gate in `saveState`, so a consecutive-failure request wins
over the one-shot flags:

```swift
    func saveState(_ newState: SolarForecastPersistedState) async throws {
        if shouldHoldNextSave {
            shouldHoldNextSave = false
            await withCheckedContinuation { heldSave = $0 }
        }
        if consecutiveSavesToFail > 0 {
            consecutiveSavesToFail -= 1
            throw TestFileError.failedWrite
        }
        if let remaining = successfulSavesBeforeFailure {
            if remaining == 0 { successfulSavesBeforeFailure = nil; throw TestFileError.failedWrite }
            successfulSavesBeforeFailure = remaining - 1
        }
        if shouldFailNextSave { shouldFailNextSave = false; throw TestFileError.failedWrite }
        state = newState
        payload = (try? JSONEncoder().encode(newState)) ?? Data()
    }
```

And add the control method beside `failNextSaveAfter`:

```swift
    func failSaves(_ count: Int) { consecutiveSavesToFail = count }
```

### Step 2: Write the failing test

Add to the `SolarForecastStoreTests` suite, next to the other quarantine tests:

```swift
    @Test("A save failure after a successful fetch never quarantines the credential")
    func saveFailureAfterSuccessfulFetchNeverQuarantines() async throws {
        let h = Harness()
        try await h.store.connect(apiKey: "key-a", accountScopeID: "account-a", siteID: "site-a", resourceIDs: ["east"])
        #expect(await h.store.refresh(accountScopeID: "account-a", siteID: "site-a") == .refreshed)

        // Two consecutive save failures: the post-fetch write, then the fallback
        // write that persistFailureState attempts. That pair is the exact shape
        // that used to reach quarantineCredential and delete the key.
        await h.files.failSaves(2)
        #expect(await h.store.refresh(accountScopeID: "account-a", siteID: "site-a", manual: true) == .failed(.saveFailed))
        #expect(await h.keychain.count == 1)
        #expect(await h.store.cachedBatch(accountScopeID: "account-a", siteID: "site-a") != nil)
        #expect(await h.store.isRecommendationUsable(accountScopeID: "account-a", siteID: "site-a"))
    }
```

### Step 3: Run it and confirm RED

```bash
cd cmd/ios-app && ./run-tests.sh SolarForecastStoreTests
```

Expected: compile failure — `saveFailed` is not a member of `SolarForecastRefreshFailure`. That is
the normal Swift red for a brand-new enum case and is acceptable. To confirm the test would also fail
on *behaviour* and not only on the missing symbol, temporarily change the expectation to
`.failed(.storageFailure)` and re-run: it must then fail on `keychain.count == 1` (it is 0 today) and
on `isRecommendationUsable` (false today, because `failedScopes` was inserted). Revert to
`.failed(.saveFailed)` before continuing.

### Step 4: Add the failure case

In `PWUsage/State/SolarForecastStore.swift`, add to `SolarForecastRefreshFailure` (`:44`):

```swift
    case storageFailure
    case cleanupFailure
    /// The forecast was fetched successfully but could not be written to disk.
    /// Deliberately distinct from `storageFailure`, which means a credential was
    /// quarantined: here the data is good and the key must survive.
    case saveFailed
```

### Step 5: Split the persist out of the fetch's `do` block

Replace the body of the `do {` at `SolarForecastStore.swift:411-429` so the fetch owns its own
`do`/`catch` chain and the save happens after it, outside any `catch`:

```swift
        let intervals: [SolarForecastInterval]
        do {
            var arrays: [[SolcastForecastPoint]] = []
            for resourceID in credential.resourceIDs {
                try Task.checkCancellation()
                arrays.append(try await client.fetchForecast(resourceID: resourceID))
            }
            try Task.checkCancellation()
            guard (generations[scope] ?? 0) == generation, activeAccountScopeID == credential.accountScopeID,
                  state.credentials[scope]?.credentialID == credential.credentialID else { return .cancelled }
            intervals = try SolarForecast.combine(arrays)
        } catch let error as SolcastClientError {
            guard (generations[scope] ?? 0) == generation, activeAccountScopeID == credential.accountScopeID else { return .cancelled }
            recordRateLimit(error, credentialID: credential.credentialID)
            let outcome = await persistFailureState(scope: scope, credential: credential, description: Self.safeDescription(error))
            return outcome == .persisted ? Self.refreshFailure(error) : Self.refreshResult(for: outcome, ordinaryResult: Self.refreshFailure(error))
        } catch is CancellationError {
            return .cancelled
        } catch {
            guard (generations[scope] ?? 0) == generation, activeAccountScopeID == credential.accountScopeID else { return .cancelled }
            let outcome = await persistFailureState(scope: scope, credential: credential, description: "Forecast request failed")
            let failure: SolarForecastRefreshFailure = (error as? SolarForecastError) == nil ? .requestFailed : .invalidForecast
            return Self.refreshResult(for: outcome, ordinaryResult: .failed(failure))
        }

        state.caches[scope] = SolarForecastBatch(credentialID: credential.credentialID, resourceIDs: credential.resourceIDs, intervals: intervals, fetchedAt: clock.now())
        state.failedScopes.remove(scope)
        lastErrorDescription = nil
        do {
            try await persist()
        } catch {
            // A disk failure is not a forecast failure. The intervals above are
            // good and the credential is untouched, so the cache is kept in memory
            // and the scope is deliberately NOT marked failed — isRecommendationUsable
            // gates on failedScopes, so marking it would hide the data we just
            // fetched. Never quarantine here: the next refresh retries the write,
            // and destroying a working key over a full disk loses the user's setup.
            lastErrorDescription = "Forecast could not be saved to this device"
            return .failed(.saveFailed)
        }
        return .refreshed
```

Delete the old `try await persist()` / `return .refreshed` that previously closed the `do` block.

### Step 6: Run and confirm GREEN

```bash
cd cmd/ios-app && ./run-tests.sh SolarForecastStoreTests
```

Expected: the new test passes **and** `failedRateLimitPersistenceQuarantinesAcrossRestart` and
`failedPartialRefreshPersistenceQuarantinesAcrossRestart` still pass. If either fails, quarantine was
widened or narrowed incorrectly — re-read Step 5 before changing anything.

### Step 7: Make the cause initialiser failable

`SolarForecastUnavailableCause` lives at `DashboardCoordinator.swift:39`. A save failure is not an
*unavailability* — the forecast is in memory and on screen — so it must not become a cause:

```swift
    /// `nil` when the failure does not make the forecast unavailable. A save
    /// failure is deliberately `nil`: the forecast is available in memory, so
    /// `causeNote`'s "Solar forecast unavailable" prefix would be false. It is
    /// surfaced by `DashboardCoordinator.solarForecastSaveFailure` instead.
    init?(_ failure: SolarForecastRefreshFailure) {
        switch failure {
        case .unauthorized: self = .unauthorized
        case .rateLimited: self = .rateLimited
        case .requestFailed: self = .requestFailed
        case .unknownResource: self = .unknownResource
        case .invalidForecast: self = .invalidForecast
        case .storageFailure: self = .storageFailure
        case .cleanupFailure: self = .cleanupFailure
        case .saveFailed: return nil
        }
    }
```

`init?(_ result:)` must then unwrap explicitly rather than relying on implicit optional assignment:

```swift
    init?(_ result: SolarForecastRefreshResult) {
        switch result {
        case .failed(let failure):
            guard let cause = SolarForecastUnavailableCause(failure) else { return nil }
            self = cause
        case .budgetExhausted: self = .budgetExhausted
        case .deferred: self = .deferred
        case .refreshed, .alreadyFresh, .notConfigured, .cancelled: return nil
        }
    }
```

Building now surfaces any other call site that relied on the non-failable form.

### Step 8: Add the published flag and special-case the refresh result

Add the property beside `solarForecastUnavailableCause`:

```swift
    @Published private(set) var solarForecastSaveFailure = false
```

Reset it in `resetForecastEnhancement` and wherever the other forecast state is cleared on sign-out
or invalidation, so a stale warning cannot outlive a session.

In `refreshSolarForecast`, replace the guard at `:417-425`:

```swift
        let saveFailed = refresh == .failed(.saveFailed)
        guard saveFailed || refresh == .refreshed || refresh == .alreadyFresh,
              await forecastStore.isRecommendationUsable(accountScopeID: accountScopeID, siteID: siteID),
              let batch = await forecastStore.cachedBatch(accountScopeID: accountScopeID, siteID: siteID) else {
            solarForecastUnavailableCause = SolarForecastUnavailableCause(refresh)
            solarForecastBatch = nil
            solarForecastState = .failedWithBasic
            return
        }
        solarForecastBatch = batch
        solarForecastUnavailableCause = nil
        solarForecastState = .enhanced
        solarForecastSaveFailure = saveFailed
```

In `loadTimingDetailAppeared`'s success path (`:382-384`), add
`solarForecastSaveFailure = false` beside the other assignments — that path never runs a forecast
refresh, so it must not inherit a stale flag.

### Step 9: Thread the flag into the overlay and give it its own note

In `LoadTimingForecastPresentation.swift`, add beside `unavailableNotePrefix`:

```swift
    static let saveFailureNote = "Forecast fetched, but it could not be saved to this device. It will be retried on the next refresh."
```

Add a parameter to `overlay(...)`, after `cause:` so it reads with the other diagnostics:

```swift
        cause: SolarForecastUnavailableCause?,
        saveFailed: Bool = false,
```

In the enhanced branch, replace `note: nil` with:

```swift
                note: saveFailed ? saveFailureNote : nil,
```

`unavailableNotePrefix` must not appear in this note — the forecast is not unavailable.

At the call site, `LoadTimingView.swift:265`, add:

```swift
            cause: coordinator.solarForecastUnavailableCause,
            saveFailed: coordinator.solarForecastSaveFailure,
```

### Step 10: Write the presentation and coordinator tests

In `PWUsageTests/LoadTimingViewTests.swift`, inside `struct LoadTimingForecastPresentationTests`
(declared at `:285`), add:

```swift
    @Test("A save failure keeps the forecast and is not reported as unavailable")
    func saveFailureKeepsForecastAndIsNotReportedAsUnavailable() {
        let overlay = LoadTimingForecastPresentation.overlay(
            enhancement: .enhanced,
            connection: .ready,
            cause: nil,
            saveFailed: true,
            result: Self.enhanced(Self.waitingComparison()),
            forecastFetchedAt: Self.now.addingTimeInterval(-60),
            contextAsOf: Self.now,
            currencyCode: "USD",
            timeZone: "UTC",
            now: Self.now
        )
        #expect(overlay.isForecastAware)
        #expect(overlay.note == LoadTimingForecastPresentation.saveFailureNote)
        #expect(overlay.note?.contains("unavailable") == false)
    }
```

`Self.enhanced(_:)` (`:1034`) and `Self.waitingComparison()` (`:1046`) are the existing private
helpers in that suite; `Self.now` is its `static let`. This is the same construction
`staleForecastCannotProduceARecommendation` (`:877`) uses, so the new test differs from it only in the
one input under test.

In `PWUsageTests/SolarForecastCoordinatorTests.swift`, add a coordinator-level test. The
`ForecastManagerSpy` (`:619`) already supports this via `setRefreshResults(_:)` (`:640`) and its
`recommendationUsable` flag:

```swift
    @Test("A save failure leaves the enhancement up and claims no unavailability cause")
    func saveFailureLeavesEnhancementUp() async {
        let forecast = ForecastManagerSpy(configuredSiteID: "site-a")
        let api = ForecastDashboardAPISpy()
        let coordinator = DashboardCoordinator(
            siteID: "site-a", api: api, planningAPI: api,
            forecastStore: forecast, accountScopeID: "local-account",
            now: { api.now }, timerInterval: nil
        )
        await coordinator.loadTimingDetailAppeared()
        await forecast.setRefreshResults([.failed(.saveFailed)])

        await coordinator.refreshSolarForecast(manual: true)

        #expect(coordinator.solarForecastState == .enhanced)
        #expect(coordinator.solarForecastBatch != nil)
        #expect(coordinator.solarForecastUnavailableCause == nil)
        #expect(coordinator.solarForecastSaveFailure)
    }
```

`SolarForecastUnavailableCause` is `Equatable`, so `== nil` is the assertion; if the compiler
disagrees, use `#expect(coordinator.solarForecastUnavailableCause == .requestFailed == false)`.

### Step 11: Run the affected suites, then the full suite

```bash
cd cmd/ios-app && ./run-tests.sh SolarForecastStoreTests SolarForecastCoordinatorTests LoadTimingForecastPresentationTests
cd cmd/ios-app && ./run-tests.sh
```
Expected: all green, no new failures. `LoadTimingForecastEstimatorTests` must be untouched and green —
it is the guard on the cost math.

### Step 12: Flip the ledger and commit

In `CODE_AUDIT.md`, set §5.5's `Status` to `FIXED (PR pending)` and add a `Fix:` bullet recording: the
persist is split out of the fetch's `do`; a save failure returns the new `saveFailed` and never
quarantines; the scope is deliberately not marked failed because that would hide the cache; the
forecast stays visible with its own note; and **the audit's stated `Action` was self-defeating** —
"mark the scope failed" gates cache service on `!failedScopes.contains(scope)`. Re-derive the
`Location` line numbers against this tree and note that in the `Confidence` bullet.

```bash
cd /Users/kevm/.codex/worktrees/ios-solcast-timing-v2/pwusage
git add cmd/ios-app/PWUsage cmd/ios-app/PWUsageTests CODE_AUDIT.md
git commit -F - <<'EOF'
fix(ios): stop discarding a working Solcast key on a save failure

The post-fetch persist sat inside the same do block as the fetch, so a
disk failure was caught by the request-failure handler and escalated to
persistFailureState. If persisting the failure state also failed, that
reached quarantineCredential and deleted a working API key over a full
disk.

Persist failure is now a distinct result. The cache is kept in memory, the
scope is deliberately NOT marked failed (that gates cache service and
would hide the data just fetched), the credential is never quarantined,
and the forecast stays on screen behind its own note. That note cannot
reuse causeNote: every message there is prefixed "Solar forecast
unavailable", which would be false.

The audit's Action said to mark the scope failed, which is why the note
records that it was self-defeating as written.

The two existing quarantine tests drive request failures and pass
unchanged, so the safety valve is narrowed rather than removed.
EOF
```

---

## Task 2: §8.18 — an unknown battery charge draws blank

`batterySymbol` (`DashboardView.swift:306-319`) sets `level = "100percent"` in its `nil` branch, so an
unknown charge renders `--` with the label "Battery charge unknown" beside a **full** battery, twice
(hero glyph `:77`, Battery tile `:107`).

The TRMNL renderer already does the right thing: with `soc` null it uses `level = 0`, so
`fillWidth = 0` and the outline renders with no fill (`components.ts:50-51`, `:83-84`, `:116-117`).
iOS matches that with a blank battery, no charging bolt, and a neutral tint.

### Step 1: Write the failing test

In `PWUsageTests/DashboardPresentationTests.swift`, add:

```swift
    @Test("An unknown battery charge draws a blank battery, never a full one")
    func unknownChargeDrawsBlankBattery() {
        // A reading we cannot vouch for: no fill, and no bolt asserting flow the
        // blank fill denies. Matches the TRMNL renderer at fillWidth 0.
        #expect(DashboardPresentation.batterySymbol(powerWatts: 900, stateOfCharge: nil) == "battery.0percent")
        #expect(DashboardPresentation.batterySymbol(powerWatts: -900, stateOfCharge: nil) == "battery.0percent")
        #expect(DashboardPresentation.batterySymbol(powerWatts: 0, stateOfCharge: nil) == "battery.0percent")
    }

    @Test("A known charge keeps its band and its charging bolt")
    func knownChargeKeepsBandAndBolt() {
        #expect(DashboardPresentation.batterySymbol(powerWatts: 0, stateOfCharge: 0) == "battery.0percent")
        #expect(DashboardPresentation.batterySymbol(powerWatts: 0, stateOfCharge: 12) == "battery.0percent")
        #expect(DashboardPresentation.batterySymbol(powerWatts: 0, stateOfCharge: 13) == "battery.25percent")
        #expect(DashboardPresentation.batterySymbol(powerWatts: 0, stateOfCharge: 37) == "battery.25percent")
        #expect(DashboardPresentation.batterySymbol(powerWatts: 0, stateOfCharge: 38) == "battery.50percent")
        #expect(DashboardPresentation.batterySymbol(powerWatts: 0, stateOfCharge: 62) == "battery.50percent")
        #expect(DashboardPresentation.batterySymbol(powerWatts: 0, stateOfCharge: 63) == "battery.75percent")
        #expect(DashboardPresentation.batterySymbol(powerWatts: 0, stateOfCharge: 87) == "battery.75percent")
        #expect(DashboardPresentation.batterySymbol(powerWatts: 0, stateOfCharge: 88) == "battery.100percent")
        #expect(DashboardPresentation.batterySymbol(powerWatts: -900, stateOfCharge: 50) == "battery.50percent.bolt")
        #expect(DashboardPresentation.batterySymbol(powerWatts: 900, stateOfCharge: 50) == "battery.50percent")
    }
```

### Step 2: Run and confirm RED

```bash
cd cmd/ios-app && ./run-tests.sh DashboardPresentationTests
```

Expected: compile failure — `batterySymbol` is not a member of `DashboardPresentation`. It is
currently a `private func` on the view, so relocating it is what makes the mapping testable at all.

### Step 3: Move the mapping to the presentation layer

Add to `DashboardPresentation` (beside `batteryDirection` at `:19`):

```swift
    /// The charge bands and the charging bolt, kept here rather than on the view so
    /// the mapping is unit-testable. A `nil` charge is an unknown reading, not a
    /// full battery: it draws the blank outline, matching the TRMNL renderer, which
    /// renders an unfilled battery when `soc` is null. The charging bolt is omitted
    /// for the same reason — a bolt beside a blank battery asserts flow that the
    /// blank fill denies.
    static func batterySymbol(powerWatts: Double, stateOfCharge: Double?) -> String {
        guard let stateOfCharge else { return "battery.0percent" }
        let isCharging = batteryDirection(powerWatts: powerWatts) == .charging
        let level: String
        switch Int(stateOfCharge.rounded()) {
        case ..<13: level = "0percent"
        case 13..<38: level = "25percent"
        case 38..<63: level = "50percent"
        case 63..<88: level = "75percent"
        default: level = "100percent"
        }
        return isCharging ? "battery.\(level).bolt" : "battery.\(level)"
    }
```

### Step 4: Point the view at it and neutralise the tint

Delete `batterySymbol` from `DashboardView` (`:306-319`). Update both call sites.

Hero glyph, `:77-80`:

```swift
                                    Image(systemName: DashboardPresentation.batterySymbol(
                                        powerWatts: live.live.batteryPower,
                                        stateOfCharge: live.stateOfCharge))
                                        .font(.system(size: 44, weight: .bold))
                                        .foregroundStyle(live.stateOfCharge == nil ? Color.secondary : Color.green)
                                        .accessibilityHidden(true)
```

Battery tile, `:107` — the `symbol:` and `tint:` arguments:

```swift
                            MetricTile(title: "Battery", value: DashboardPresentation.batteryPower(live.live.batteryPower), detail: DashboardPresentation.batteryPowerDetail(live.live.batteryPower), symbol: DashboardPresentation.batterySymbol(powerWatts: live.live.batteryPower, stateOfCharge: live.stateOfCharge), tint: live.stateOfCharge == nil ? .secondary : .green)
```

`--` (`:71`) and the "Battery charge unknown" label (`:75`) are already correct — do not touch them.

### Step 5: Run and confirm GREEN

```bash
cd cmd/ios-app && ./run-tests.sh DashboardPresentationTests
cd cmd/ios-app && ./run-tests.sh
```

### Step 6: Flip the ledger and commit

§8.18's `Status` → `FIXED (PR pending)`, with a `Fix:` bullet recording the TRMNL precedent (the
`fillWidth = 0` code), the no-bolt and neutral-tint refinements, and that the **device check is still
owed** — the outcome is a rendered glyph and no snapshot test or preview verifies it, and the app
gates every screen behind a real sign-in.

```bash
git add cmd/ios-app/PWUsage cmd/ios-app/PWUsageTests CODE_AUDIT.md
git commit -F - <<'EOF'
fix(ios): draw an unknown battery charge as blank, not full

batterySymbol's nil branch picked 100percent, so an unknown charge
rendered -- and the label "Battery charge unknown" beside a full battery,
twice: the hero glyph and the Battery tile both call it.

The nil branch now draws the blank outline, which is what the TRMNL
renderer already does: with soc null it uses level 0, so fillWidth is 0
and the outline renders with no fill. Cross-surface consistency rather
than invention, and it settles the objection that a 0% glyph asserts a
value -- the blank fill says no fill and the adjacent text carries the
meaning, exactly as TRMNL distinguishes "0" from "--".

Two refinements TRMNL does not need because its SVG is hand-built and
always neutral: the charging bolt is dropped, since a bolt beside a
blank battery asserts flow the blank fill denies; and the tint becomes
.secondary when the charge is unknown, since the hardcoded green made a
blank battery read as healthy.

The mapping moves to DashboardPresentation beside the already-tested
batteryDirection, which is what makes it unit-testable at all.

Device check still owed: the outcome is a rendered glyph and no snapshot
test or preview verifies the spacing beside the --.
EOF
```

---

## Task 3: §5.12 — contain test-fixture crashes to one test

Five `try!` sites turn a fixture bug into `_assertionFailure` → `SIGTRAP`, killing the whole test
binary. Under §6.2 this produced 26 crash reports with no test-level message naming the cause.

**Not** `fatalError` — that reproduces the exact mechanism.

### Step 1: Replace the two `AppConfiguration` force-tries

`PWUsageTests/PWUsageAppModelTests.swift:268-273`:

```swift
    // `pwusage.test` is a stub host, so the allowlist opt-out is explicit. Built by
    // a throwing helper rather than a `try!` static let, so a rejected origin fails
    // the one test that used it instead of trapping the whole binary.
    private static func makeConfiguration() throws -> AppConfiguration {
        try AppConfiguration(apiOriginString: "https://pwusage.test", allowUnlistedHost: true)
    }
```

Replace all ten `Self.configuration` references with `try Self.makeConfiguration()`. Every enclosing
test is already `async throws` (e.g. `bootstrapRestoresCookieSessionAndFetchesSitesOnlyOnce` at `:8`),
so `try` needs no signature change. Verify each of the ten sites after editing:

```bash
cd cmd/ios-app && grep -n "Self.configuration" PWUsageTests/PWUsageAppModelTests.swift
```

Expected: no matches.

### Step 2: Fix the continuation resume in the same file

`PWUsageAppModelTests.swift:366-372` resumes a `CheckedContinuation<MobileLiveResponse, Error>` inside
a non-throwing `for`-style loop, so the throw cannot propagate. Route it into the continuation instead:

```swift
    func resumeLiveRequests() {
        holdLive = false
        let pending = liveContinuations
        liveContinuations.removeAll()
        for (siteID, continuation) in pending {
            do {
                continuation.resume(returning: try Self.liveResponse(siteID: siteID))
            } catch {
                // A broken fixture fails the one test awaiting this continuation,
                // with the decode error attached, instead of trapping the binary.
                continuation.resume(throwing: error)
            }
        }
    }
```

`liveResponse` at `:388` is already `throws`; leave it.

### Step 3: Make `makeService` throwing

`PWUsageTests/MobileAuthServiceTests.swift:432-437` — change the signature and the force-try:

```swift
    private func makeService(
        isAuthenticated: Bool = false,
        startResult: Bool = true,
        api: FakeMobileAuthAPI? = nil,
        sessionFactory: MobileAuthService.SessionFactory? = nil
    ) throws -> MobileAuthService {
        // `pwusage.test` is a stub host, so the allowlist opt-out is explicit.
        let apiConfiguration = try AppConfiguration(apiOriginString: "https://pwusage.test", allowUnlistedHost: true)
```

Then prefix all sixteen call sites with `try`:

```bash
cd cmd/ios-app && grep -n "= makeService(" PWUsageTests/MobileAuthServiceTests.swift
```

Expected after the edit: no `= makeService(` without a preceding `try`.

### Step 4: Make the coordinator fixtures throwing and contain the resume

`PWUsageTests/DashboardCoordinatorTests.swift:524-534` — change both helpers:

```swift
    private static func liveResponse(siteID: String) throws -> MobileLiveResponse {
        // A charge reading older than two hours decodes as unknown, so date it now rather than
        // reusing the deliberately stale `liveStatusAt` above.
        let chargeAt = ISO8601DateFormatter().string(from: Date())
        let json = #"{"version":1,"site":{"id":"\#(siteID)","name":"Home","timezone":"UTC","localDate":"2026-09-23"},"live":{"solarPower":1,"loadPower":2,"batteryPower":3,"gridPower":4},"stateOfCharge":50,"activeTariff":"Peak","today":{"homeKwh":1,"solarKwh":2,"gridNetKwh":3,"batteryNetKwh":4},"todayComplete":true,"currentBill":null,"sources":{"liveStatusAt":"2026-09-23T12:00:00Z","energyDataThrough":null,"stateOfChargeAt":"\#(chargeAt)"}}"#
        return try MobileContractDecoder.make().decode(MobileLiveResponse.self, from: Data(json.utf8))
    }

    private static func billResponse(siteID: String) throws -> MobileBillResponse {
        let json = #"{"version":1,"site":{"id":"\#(siteID)","name":"Home","timezone":"UTC"},"currentBill":{"estimatedCost":42,"currency":"USD","cycleStart":"2026-09-01T00:00:00Z","cycleEnd":"2026-10-01T00:00:00Z","periods":[]},"sources":{"calculatedAt":"2026-09-23T12:00:00Z","energyDataThrough":null}}"#
        return try MobileContractDecoder.make().decode(MobileBillResponse.self, from: Data(json.utf8))
    }
```

`resumeRequests()` at `:512-521` uses `forEach`, whose closure cannot throw. Replace it:

```swift
    func resumeRequests() {
        holdLive = false
        holdBill = false
        let livePending = liveContinuations
        liveContinuations.removeAll()
        for (siteID, continuation) in livePending {
            do {
                continuation.resume(returning: try Self.liveResponse(siteID: siteID))
            } catch {
                continuation.resume(throwing: error)
            }
        }
        let billPending = billContinuations
        billContinuations.removeAll()
        for (siteID, continuation) in billPending {
            do {
                continuation.resume(returning: try Self.billResponse(siteID: siteID))
            } catch {
                continuation.resume(throwing: error)
            }
        }
    }
```

### Step 5: Confirm no `try!` remains in the test target

```bash
cd cmd/ios-app && grep -rn "try!" PWUsageTests/
```

Expected: no matches. If a legitimate one remains, it is outside this finding's five sites and must
be justified in the commit message rather than silently kept.

### Step 6: Run the full suite

```bash
cd cmd/ios-app && ./run-tests.sh
```

Expected: green, identical pass count to Task 0 (this change must not alter which tests exist).

### Step 7: Mutation-check the containment

This is test infrastructure, so "the helper throws now" is not evidence. Prove the failure is
contained:

1. Note the current count: `ls ~/Library/Logs/DiagnosticReports/ | grep -c "^PWUsage-"`.
2. Temporarily corrupt one fixture — in `DashboardCoordinatorTests.planingContextResponse`, set
   `slots.count` in the JSON to an invalid value, or simpler, change `version: 1` to `version: 9` in
   `liveResponse` so `MobileLiveResponse.init(from:)` throws `unsupportedVersion`.
3. Run `./run-tests.sh DashboardCoordinatorTests`.
4. Confirm: the run reports **failing tests with a decode/contract error message**, not a crash, and
   `~/Library/Logs/DiagnosticReports/` gains **no** new `PWUsage-*` reports.
5. Revert the corruption and confirm the suite is green again.

Both halves are required: a readable failure **and** no new crash reports. Record the before/after
crash counts in the commit message.

### Step 8: Flip the ledger and commit

§5.12's `Status` → `FIXED (PR pending)`, with a `Fix:` bullet recording the before/after crash counts
from Step 7 and noting the four helpers touched.

```bash
git add cmd/ios-app/PWUsageTests CODE_AUDIT.md
git commit -F - <<'EOF'
test(ios): contain fixture failures to one test

Five try! sites across four helpers built a fixture inside a static let
initializer or a shared makeService, so any thrown error became
_assertionFailure -> SIGTRAP and killed the whole binary instead of
failing one test.

Replaced with throwing helpers. Where a fixture feeds a
CheckedContinuation from a non-throwing resume loop, the error is routed
into the continuation with resume(throwing:) rather than propagated, so
the awaiting test fails with the decode error attached.

Not fatalError: that reproduces the exact mechanism being removed.

Mutation-checked, since "the helper throws now" is not evidence. Before
this change the same corruption produced process deaths; after it the run
reports failing tests with a contract error and DiagnosticReports gains
no new PWUsage-* entries. Counts recorded in CODE_AUDIT.md 5.12.
EOF
```

---

## Task 4: §5.8 — planning-context clock skew and cache eviction

`validating` (`MobileContracts.swift:230-274`) requires `sourceAge` within `[-(5 * 60), 24h]`. A device
more than five minutes **behind** the server rejects **every** response as `contextInvalid`, permanently, and the cached
re-validation at `DashboardCoordinator.swift:533-536` re-rejects the same entry on every read.

**Amended 2026-09-30, in the branch's second review pass:** the three citations in this passage were corrected in place against the current tree — `MobileContracts.swift:120` to `:119` (the `age >= 0` guard), `:219-231` to `:230-274` (`validating`, which grew when the skew-direction comment was corrected), and `DashboardCoordinator.swift:506` to `:533-536` (the cache-hit block). All three sat in text this branch had already edited for the skew direction, and a citation pass that fixed the wording around them and left the line numbers behind is how a document ends up asserting things about code it never opened.

**Amended 2026-09-30, in the branch's final review pass:** the skew direction is wrong throughout this document. `sourceAge = now.timeIntervalSince(asOf)` compares the *server's* `asOf` against the *device's* clock, so `asOf` looks future-dated only when the device is **behind**; a device running fast makes it look *older*, which the pre-fix `[-300s, 24h]` window already accepted and which was therefore never this finding's population. Every "fast" below is corrected to "behind" / "slow" in the text it appears in; the reasoning and the code change were always right, and only the description of who the fix rescues was not. The landed commit subject for §5.8 still says "fast" and cannot be corrected without rewriting the branch's history, so that one instance is recorded rather than fixed.


### Step 1: Write the failing contract tests

In `PWUsageTests/MobileContractsTests.swift`, add a helper and two tests. The helper must satisfy
every clause of `validating`, so it is the memberwise initialiser copied from
`DashboardCoordinatorTests.planningContextResponse` (`:536-556`) — that helper is `private` to the
other file and cannot be reused, hence the copy:

```swift
    private static func makePlanningContext(siteID: String, asOf: Date) -> MobileLoadPlanningContextResponse {
        MobileLoadPlanningContextResponse(
            version: 1,
            site: .init(id: siteID, timezone: "UTC"),
            units: .init(power: "kW", localMinute: "minute-of-day"),
            asOf: asOf,
            availability: .available,
            unavailableReason: nil,
            usableDayCount: 14,
            historyStart: asOf.addingTimeInterval(-14 * 24 * 60 * 60),
            historyEnd: asOf.addingTimeInterval(-60),
            slots: (0..<48).map { index in
                MobileLoadPlanningContextResponse.Slot(
                    localMinute: index * 30, homeKw: 1, batteryNetChargeKw: 0, sampleCount: 14, coverage: 1
                )
            }
        )
    }
```

Then the tests:

```swift
    @Test("A planning context stamped ahead of a slow device clock still validates")
    func planningContextToleratesClockBehindServer() throws {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        // Thirty minutes ahead: a mis-set device clock, not bad data.
        let response = Self.makePlanningContext(siteID: "site-a", asOf: now.addingTimeInterval(30 * 60))
        #expect(throws: Never.self) { try response.validating(siteID: "site-a", now: now) }
    }

    @Test("A planning context stamped absurdly ahead is still rejected")
    func planningContextRejectsAbsurdFutureAsOf() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let response = Self.makePlanningContext(siteID: "site-a", asOf: now.addingTimeInterval(365 * 24 * 60 * 60))
        #expect(throws: MobileLoadPlanningContextResponse.ContractError.self) {
            try response.validating(siteID: "site-a", now: now)
        }
    }
```

If `Self.makePlanningContext` cannot be `private` in that suite (Swift Testing suites are structs, so
it can), leave it `private`. The second test is what stops the tolerance from becoming "accept
anything" — it is not optional coverage.

### Step 2: Run and confirm RED

```bash
cd cmd/ios-app && ./run-tests.sh MobileContractsTests
```

Expected: `planningContextToleratesClockBehindServer` fails — 30 minutes of negative skew exceeds the
current 5-minute allowance.

### Step 3: Add the named skew constant

In `MobileContracts.swift`, inside `MobileLoadPlanningContextResponse`, beside the existing age
constant:

```swift
    /// `asOf` is stamped by the *server* and compared against the *device* clock, so a
    /// device whose clock is behind sees it in the future even though the data is fine. A
    /// device running fast is the opposite and was never this finding's population. This
    /// bound is deliberately asymmetric with the positive one: leniency here costs a
    /// bounded amount of mis-measured freshness, while strictness makes a mis-set
    /// device clock reject every response forever and blame the server for it.
    /// This is NOT the live contract's rule — `stateOfChargeMaximumAge` is about a
    /// suspect *reading* and requires `age >= 0`, which is stricter, not comparable.
    static let maximumNegativeAgeSkew: TimeInterval = 60 * 60
```

Then in `validating`, replace `sourceAge >= -(5 * 60)` with:

```swift
              sourceAge >= -Self.maximumNegativeAgeSkew,
```

### Step 4: Run and confirm GREEN

```bash
cd cmd/ios-app && ./run-tests.sh MobileContractsTests
```

Both new tests pass, and `planningContextRejectsAbsurdFutureAsOf` proves the tolerance is bounded —
that is the test that stops this from becoming "accept anything".

### Step 5: Verify whether eviction is needed before changing anything

The spec asserts the eviction is necessary. **Re-derive that claim first** — it may not hold, and
adding a code change whose necessity cannot be demonstrated is how a fix stops being a fix.

Read `DashboardCoordinator.planningContext(siteID:api:)` (`:498-511`) as it stands:

```swift
        let requestTime = now()
        if let cached = planningContextCache[siteID],
           requestTime.timeIntervalSince(cached.fetchedAt) >= 0,
           requestTime.timeIntervalSince(cached.fetchedAt) < Self.planningContextLifetime,
           let validated = try? cached.response.validating(siteID: siteID, now: requestTime) {
            return PlanningContextOutcome(
                context: validated.estimatorContext,
                unavailableReason: Self.enhancementReason(forReason: validated.unavailableReason)
            )
        }
        // …falls through to a network fetch
```

Two facts follow, and they undercut the spec's reasoning:

1. **Re-validation failure already refetches.** The `if let validated = try? …` is part of the
   cache-hit *condition*, so a failure drops through to the fetch below. The audit's phrasing
   "re-rejects the same bad entry on every read rather than refetching" is inaccurate: it re-validates
   *and* refetches on every read.
2. **A successful refetch overwrites the entry** at `:543`
   (`planningContextCache[siteID] = PlanningContextCacheEntry(...)`), so a stale cached entry is
   replaced without any eviction.

Combined with Step 3 — which is what actually fixes the reported failure, since a device clock behind the server is
the cause and the skew constant is the cure — the eviction may fix nothing.

Confirm with an experiment rather than an opinion. Add a temporary test in
`PWUsageTests/DashboardCoordinatorTests.swift` that pins the behaviour as it stands:

```swift
    @Test("A cached entry that fails re-validation is replaced by the next fetch")
    func poisonedCacheEntryIsReplacedOnNextFetch() async {
        let clock = TestClock()
        let api = DashboardAPISpy()
        api.contextAsOf = clock.now.addingTimeInterval(-60)
        let coordinator = DashboardCoordinator(
            siteID: "site-1", api: api, planningAPI: api, now: { clock.now }, timerInterval: nil
        )
        coordinator.scenePhaseChanged(isActive: true)
        await coordinator.loadTimingDetailAppeared()
        #expect(coordinator.loadPlanningContext != nil)
        let fetchesAfterFirstLoad = api.contextSiteIDs.count

        // Age past the context's own 24h bound and let a valid response arrive.
        clock.advance(minutes: 24 * 60)
        api.contextAsOf = clock.now
        await coordinator.loadTimingDetailAppeared()

        #expect(coordinator.solarForecastUnavailableReason == nil)
        #expect(coordinator.loadPlanningContext != nil)
        #expect(api.contextSiteIDs.count > fetchesAfterFirstLoad)
    }
```

Run it:

```bash
cd cmd/ios-app && ./run-tests.sh DashboardCoordinatorTests
```

- **If it passes unmodified**, the cache self-heals and the eviction is unnecessary. **Skip Step 6's
  code change**, keep the test (it now guards the self-healing property the audit believed was
  missing), and record in §5.8's `Fix:` bullet that the audit's "rather than refetching" claim was
  inaccurate and that no eviction was needed. Say so plainly in the commit message.
- **If it fails**, work out which of the two expectations broke before touching the cache. A failure on
  `contextSiteIDs.count` means the refetch is *not* happening, which contradicts fact 1 and means the
  cache-hit block behaves differently than it reads — investigate that first.

### Step 6: Add the eviction only if Step 5 proved it necessary

If, and only if, Step 5 failed, insert immediately after the cache-hit block:

```swift
        if planningContextCache[siteID] != nil {
            // Re-validation failed while the entry was still inside its lifetime.
            // Evict so the refetch below can replace the entry; a failed refetch
            // then leaves the entry absent rather than re-failing on every read.
            planningContextCache.removeValue(forKey: siteID)
        }
```

Do not touch the fresh-response path at `:538`; it already declines to cache an invalid response.

### Step 7: Run and confirm GREEN, then the full suite

```bash
cd cmd/ios-app && ./run-tests.sh DashboardCoordinatorTests MobileContractsTests
cd cmd/ios-app && ./run-tests.sh
```

`LoadTimingForecastEstimatorTests` is the guard on the cost math that consumes this context and must
be run explicitly, not merely as part of the full suite.

### Step 8: Flip the ledger and commit

§5.8's `Status` → `FIXED (PR pending)`. The `Fix:` bullet must record: the named constant and the
asymmetry; that the audit's "match the live contract's tolerance" named a **stricter** bound
(`stateOfChargeMaximumAge` requires `age >= 0`) and the two cases are not comparable; the outcome of
Step 5 — whether eviction was needed, and if not, that the audit's "re-rejects the same bad entry on
every read rather than refetching" was inaccurate because re-validation failure falls through to a
refetch and `:543` overwrites the entry; and that the skew-rejected note no longer tells the user to
report a server bug.

```bash
git add cmd/ios-app/PWUsage cmd/ios-app/PWUsageTests CODE_AUDIT.md
git commit -F - <<'EOF'
fix(ios): tolerate a device clock behind the server on the planning context

validating required the server's asOf to be within five minutes in the
future, so a device more than five minutes behind the server rejected every response
as contextInvalid, permanently. The note told the user to report a
server bug that was really their own clock.

The fix is a named maximumNegativeAgeSkew of one hour, asymmetric with
the 24h positive bound: leniency costs a bounded amount of mis-measured
freshness, strictness makes a mis-set clock reject everything forever.

The audit's Action said to widen the allowance "to match the live
contract's tolerance", but the live contract requires age >= 0, which
is stricter rather than more lenient -- a future-stamped SoC reading is
suspect data, while asOf is a server timestamp read against a device
clock. The cases are not comparable.

The audit also asked for a cache eviction. Re-deriving the claim first
showed it was not needed: re-validation failure already falls through
to a refetch, and a successful refetch overwrites the entry, so the
cache self-heals. The audit's "re-rejects the same bad entry on every
read rather than refetching" was inaccurate. No eviction is added; a
test now pins the self-healing property instead.
EOF
```

---

## Task 5: §5.7 (a) and (b) — the device clock

### Part (a): a backwards clock silently stops all polling

`isDue` (`DashboardCoordinator.swift:636-639`) computes
`date.timeIntervalSince(lastAttempt) >= interval`. Move the clock backwards and the 5-minute live poll
and 30-minute bill poll **stop entirely**, with no error and no UI indication.

**Step 1: Write the failing test.** In `PWUsageTests/DashboardCoordinatorTests.swift`, add a test that
moves the injectable clock backwards and asserts a refresh still happens. The suite is `@MainActor`
and its `TestClock` (`:442`) is `@MainActor private final` with
`advance(minutes:)` built on `addingTimeInterval(minutes * 60)` — so a **negative** argument moves
time backwards and no new helper is needed:

```swift
    @Test("A clock moved backwards does not stall the poll")
    func backwardsClockDoesNotStallThePoll() async {
        let clock = TestClock()
        let api = DashboardAPISpy()
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, now: { clock.now }, timerInterval: nil)

        coordinator.scenePhaseChanged(isActive: true)
        await coordinator.refreshDue()
        #expect(api.liveSiteIDs == ["site-1"])

        // The user's clock jumps back an hour.
        clock.advance(minutes: -60)
        await coordinator.refreshDue()
        #expect(api.liveSiteIDs == ["site-1", "site-1"])
    }
```

The coordinator setup mirrors `initialForegroundLoadAndExactSixtyMinuteRequestCounts` (`:9`) exactly.
Note the `isDue` path that must change is the **live** one; the bill path is floored at 30 minutes and
is unaffected, which is why this test asserts only on `liveSiteIDs`.

**Step 2: Confirm RED.**

```bash
cd cmd/ios-app && ./run-tests.sh DashboardCoordinatorTests
```

Expected: `liveSiteIDs` has one entry, not two — the second refresh is suppressed.

**Step 3: Fix `isDue`.** Replace `:636-639`:

```swift
    private func isDue(lastAttempt: Date?, interval: TimeInterval, at date: Date) -> Bool {
        guard let lastAttempt else { return true }
        let elapsed = date.timeIntervalSince(lastAttempt)
        // A negative elapsed time means the device clock moved backwards, so real
        // elapsed time is unknown. Treat it as due: a spurious poll costs one
        // request, while stalling freezes live and bill data indefinitely with no
        // error and nothing on screen to explain it.
        guard elapsed.isFinite else { return true }
        return elapsed < 0 || elapsed >= interval
    }
```

**Step 4: Confirm GREEN**, then run the full suite.

### Part (b): a backwards clock makes any forecast age look fresh

`LoadTimingForecastPresentation.swift:95` requires
`now.timeIntervalSince(fetchedAt) <= maximumForecastAge` with no `>= 0`.
`LoadTimingRecommendation.isFresh` (`:139`) already uses `age >= 0 && age <= detailFreshnessWindow`,
so this aligns an outlier with the codebase's own convention.

**Step 5: Write the failing test.** In `PWUsageTests/LoadTimingViewTests.swift`, inside
`struct LoadTimingForecastPresentationTests` (declared at `:285`), beside
`staleForecastCannotProduceARecommendation` (`:877`):

```swift
    @Test("A forecast stamped in the future cannot produce a recommendation")
    func futureDatedForecastCannotProduceARecommendation() {
        let overlay = LoadTimingForecastPresentation.overlay(
            enhancement: .enhanced,
            connection: .ready,
            cause: nil,
            result: Self.enhanced(Self.waitingComparison()),
            forecastFetchedAt: Self.now.addingTimeInterval(600),
            contextAsOf: Self.now,
            currencyCode: "USD",
            timeZone: "UTC",
            now: Self.now
        )

        #expect(overlay.enhanced == nil)
        #expect(!overlay.isForecastAware)
    }
```

`forecastFetchedAt` is ten minutes in the **future** relative to `Self.now`, which is exactly the
backwards-device-clock case. Reusing the same helpers as `:877` keeps the new test differing from it
in one input only, so a failure localises immediately.

**Step 6: Confirm RED.** Expected: `isForecastAware` is `true` today, because a negative age passes
`<= maximumForecastAge`.

**Step 7: Fix the gate.** In `overlay(...)`, replace the freshness condition with:

```swift
        let forecastAge = forecastFetchedAt.map { now.timeIntervalSince($0) }
        if enhancement == .enhanced, connection == .ready, let comparison = result.comparison,
           let fetchedAt = forecastFetchedAt, let forecastAge,
           forecastAge >= 0, forecastAge <= maximumForecastAge,
           comparison.costNow.isFinite, comparison.recommendedCost.isFinite,
           comparison.savings.isFinite, comparison.estimatedSolarContribution.isFinite {
```

The `>= 0` matches `LoadTimingRecommendation.isFresh`. A future-dated forecast means the device clock
is behind, so its age is unknowable — treat it as not fresh rather than as fresh.

**Step 8: Confirm GREEN, then run the full suite.**

```bash
cd cmd/ios-app && ./run-tests.sh LoadTimingForecastPresentationTests DashboardCoordinatorTests
cd cmd/ios-app && ./run-tests.sh
```

**Step 9: Flip the ledger and commit.** §5.7's `Status` → `FIXED (PR pending)`, with a `Fix:` bullet
recording that **only parts (a) and (b) are fixed**, that part (c) (anchoring cadence to
`ContinuousClock`) moved to the new §3.15, and that the audit's Action bundled three sizes of change.

```bash
git add cmd/ios-app/PWUsage cmd/ios-app/PWUsageTests CODE_AUDIT.md
git commit -F - <<'EOF'
fix(ios): stop a backwards clock stalling polls and faking freshness

Two clock comparisons trusted the device clock with no skew allowance.

isDue computed now - lastAttempt >= interval, so a user who moved the
clock backwards stopped the 5-minute live poll and the 30-minute bill
poll entirely, with no error and nothing on screen to explain it. A
negative elapsed time now counts as due: a spurious poll costs one
request, a stalled poll freezes data indefinitely.

The forecast overlay gate required now - fetchedAt <= maximumForecastAge
with no >= 0, so a clock behind the server made any age look fresh.
LoadTimingRecommendation.isFresh already had the bound; this aligns the
outlier with the codebase's own convention.

Part (c) of the audit's finding -- anchoring cadence to ContinuousClock
-- is not done here. It is the same lastAttempt bookkeeping as 3.7, so
it is re-filed as 3.15 to land with that change rather than touching
the same lines twice.
EOF
```

---

## Task 6: §2 — the eight surviving quick wins

Mechanical edits. **#1 is corrected** — see below.

**Amended 2026-09-30, after the branch landed (ledger reconciliation):** this originally also said
**#2 is already fixed** by §6.2, "which replaced the no-op `do/catch` in `PWUsageAPI.swift` with
real `ContractError` handling". **Both of that claim's premises are false**, so #2 was
implemented instead, in its own commit `03c41d5`. The no-op `do { … } catch { throw error }` was
still in `perform(_:)` at `PWUsage/Networking/PWUsageAPI.swift:109-110` at the start of this
branch — so the audit's citation was exactly right and only the reasoning around it was wrong —
and `perform(_:)` had not been edited since the Solcast commit `c05947b`, so no prior finding
could have removed it. The `ContractError` pairs the claim pointed at are the `fetchLive`
(`:50-51`) and `fetchBill` (`:59-60`) decodes: real error mapping, not this item, and predating
this branch. See the corrected Step 4 below and the `D7` ruling in `task.md`.

**#1 — delete the view call sites, keep the methods.** The audit and §9.4 both propose deleting
`solarForecastSettingsDidEdit()` and `loadProfileDidEdit()` as dead code. They are not dead:
`SolarForecastCoordinatorTests.swift:573`, `:593` and `:613` use them as a synchronization seam, calling them
mid-flight to model a settings edit during an in-progress refresh. The tests are named for the
invariant — *"Profile comparisons and settings edits perform no requests"*, *"Unsaved settings edits do
not strand a loading enhancement"*, *"Unsaved settings edits do not supersede a disconnect in
progress"*. **The emptiness is the contract under test.** Delete only the five view call sites:
`SolarForecastSettingsSheet.swift:29`, `:103`, `:108`, `:181` and `LoadTimingView.swift:406` (pre-fix
line numbers). Then remove the now-dangling `.onChange` wrappers where a call site was the whole
body, leaving the modifier list intact.

**Amended 2026-09-30, after the branch landed (ledger reconciliation):** "the four view call sites"
was an undercount twice over. There are **five** view call sites (four in the settings sheet, one
in `LoadTimingView`), of which **three** were whole `.onChange` bodies — the `:181` site is a direct
call inside a `Toggle` binding and the `LoadTimingView` one shares an `.onChange(of:
profileStore.profiles)` with a real body, so neither is a bare wrapper. Both numbers are correct
about different things, and the two were being used interchangeably. The seam test range was
likewise stale: the three tests are at `:573`, `:593` and `:613`, not `:552-611`.

Keep all three tests and both methods. Update §9.4's `Status` to stay `OPEN` with a note recording
that the methods are an intentional no-op seam, so the finding is not filed a third time.

**#3 — `fetchSites` uses the shared decoder.** `PWUsage/Networking/PWUsageAPI.swift:42`:

```swift
        do { return try MobileContractDecoder.make().decode([MobileSite].self, from: data) }
```

(`:79` and `:117` decode `SessionResponse` / `ErrorResponse`, which are not contracts — leave them.)
`[MobileSite]` has no custom `init(from:)`, so injecting the clock via `decoder.userInfo` changes
nothing; `PWUsageAPITests` verifies the site fetch still decodes.

**#4 — consolidate the scattered conformances.** Delete the one-line retroactive conformances at
`PWUsageApp.swift:11`, `DashboardCoordinator.swift:10` and `:17`, and declare all three in one place
next to the `PWUsageAPI` type declaration.

**#5 — interpolate the attempt allowance.** `SolarForecastSettingsSheet.swift:122`:

```swift
                        Text("This device has made \(budget.totalAttempts) of \(SolarForecastStore.totalAttemptsPerUTCDay) attempts today (\(budget.automaticAttempts) automatic).")
```

**#6 — rename the preview constant.** `SolarForecastPreviews.swift:8`: `SitePreviewTimeZone` →
`SITE_PREVIEW_TIME_ZONE`, updating its two uses at `:58` and `:152`.

**#7 — fix the brace.** `LoadTimingForecastPresentation.swift:76` currently ends
`return Placement(card: card, profile: profile)    }`; move the closing brace to its own line.

**#8 — drop the unused `CaseIterable`.** `DashboardPreviews.swift:4` and `SolarForecastPreviews.swift:12`
both declare `CaseIterable`; `allCases` appears nowhere. Remove the conformance from both.

**#9 — delete the callerless `isBuiltIn`.** `LoadProfile.swift:32`; the real built-in/custom distinction
is id comparison at `LoadProfileStore.swift:109`. Verify nothing references it:

```bash
cd cmd/ios-app && grep -rn "isBuiltIn" PWUsage/ PWUsageTests/
```

Expected: only the declaration line, which you then delete.

**Verify and commit:**

```bash
cd cmd/ios-app && ./run-tests.sh
cd /Users/kevm/.codex/worktrees/ios-solcast-timing-v2/pwusage
git add cmd/ios-app CODE_AUDIT.md
git commit -F - <<'EOF'
refactor(ios): take the audit's self-contained quick wins

Eight of the audit's section 2 items, plus two corrections.

Item 1 is corrected rather than taken as written. The audit (and 9.4)
propose deleting solarForecastSettingsDidEdit and loadProfileDidEdit as
dead code, but SolarForecastCoordinatorTests uses them as a
synchronization seam: three tests call them mid-flight to model a
settings edit during an in-progress refresh, and are named for the
invariant they protect. The emptiness is the contract under test. Only
the five view call sites go; the methods and the tests stay, and 9.4
now records why so it is not filed a third time.

**Amended 2026-09-30, after the branch landed (ledger reconciliation):** the
paragraph this heredoc template originally carried in place of the one above
("Item 2 is already done. 6.2's rewrite replaced the no-op do/catch in
PWUsageAPI with real ContractError handling.") was false, so item 2 is not part
of the `fcabe56` commit at all — it landed separately as `03c41d5`, once the
premise had been checked against the tree and found to be wrong. Five view call
sites went, not the four this message claimed; see the correction above.

**Note for anyone auditing this branch:** the false paragraph existed only in
*this template*. The commit message actually landed in `fcabe56` is the
corrected one, so `git log` will **not** turn up a false claim — do not go
looking for one.

The rest: fetchSites routes through the shared contract decoder; three
scattered retroactive conformances are consolidated; the settings sheet
interpolates totalAttemptsPerUTCDay instead of duplicating the literal;
the preview constant is renamed to upper snake case; a closing brace
moves off its return line; two unused CaseIterable conformances are
dropped; and the callerless LoadProfile.isBuiltIn is deleted.
EOF
```

---

## Task 7: Ledger reconciliation

The final commit makes `CODE_AUDIT.md` and `task.md` agree with the tree. Individual `Status` bullets
were already flipped in Tasks 1-6; this is the cross-cutting pass.

### Step 1: Update the progress header and count table

In `CODE_AUDIT.md`, the `**Progress:**` line and the count table currently read 74 findings / 17 fixed
/ 57 OPEN. They must become:

- 75 findings tracked
- 22 fixed
- 52 OPEN, 22 FIXED, 1 WON'T FIX

Re-derive both rows by listing the findings themselves rather than by arithmetic — the `FIXED` row
gains §5.5, §5.7, §5.8, §5.12, §8.18; the `OPEN` row loses those five and §5.6; and §3.15 is added to
`OPEN`. Cross-check the three numbers sum to 75.

### Step 2: File §3.15

Add to §3, after §3.14, following the existing entry format exactly (`Location`, `What`, `Why`,
`Action`, `Severity`, `Status: OPEN`, `Confidence`):

- **Title:** Cadence is anchored to a wall clock the user can move
- **Location:** `PWUsage/State/DashboardCoordinator.swift` — the `lastAttempt` stamps and `requestTime`
  derivation
- **What:** §5.7's part (c) was deferred from the correctness-tail branch because it is the same
  `lastAttempt` bookkeeping as §3.7. Cadence intervals are measured with `Date`, so a clock change
  moves them, and §3.7's pre-request stamping compounds it.
- **Why:** `Date` is not monotonic. A user or an NTP correction can move it, and cadence decisions
  should not depend on a value the user controls.
- **Action:** Anchor cadence to `ContinuousClock`. Do this in the same change as §3.7's
  stamp-after-the-request fix, since a monotonic timeline is what makes that rule meaningful.
- **Severity:** Medium
- **Confidence:** High

### Step 3: Record §5.6 as WON'T FIX

Set its `Status` to `WON'T FIX` and add a bullet recording the rationale: the trigger is unobserved per
the audit's own confidence note, the arrays are fetched seconds apart on a fixed epoch grid, and the
fix lands in the energy and cost math. State the condition for revisiting: if a device is ever observed
returning `incompleteCoverage` for a reason other than a genuinely empty array, re-open it. The finding
number stays in place.

### Step 4: Strike quick win #2 and mark #1 corrected

In §2, mark item 2 as already done by §6.2, and annotate item 1 to point at §9.4's note so the two
cannot drift apart again.

**Amended 2026-09-30, after the branch landed (ledger reconciliation):** the first half of this
step is not achievable as written and must not be performed by a later reader. Item 2 was **not**
already done by §6.2 — the no-op `do/catch` was still in `perform(_:)` at the start of the branch —
so "strike" is the wrong instruction and the item was implemented in `03c41d5` instead. Item 1's
annotation is the half that still holds. The rule this step was reaching for is worth keeping
explicitly, though: an item must not be struck on the authority of another finding's commit
message unless the cited lines have been opened in the current tree.

### Step 5: Write the task.md Ledger section

Append a `## iOS audit correctness tail (fix/ios-audit-correctness-tail)` section to `task.md` with a
checkbox line per commit, then a `Ruling:` line for each of the spec's D1-D7, in the established format:
what was decided, why, and what it costs if the ruling is wrong. Every ruling must name its cost,
because that is the convention the existing ledger entries follow and a ruling without one is
unreviewable.

### Step 6: Verify the ledger and commit

```bash
cd /Users/kevm/.codex/worktrees/ios-solcast-timing-v2/pwusage
grep -c "Status:\*\* OPEN" CODE_AUDIT.md
grep -c "Status:\*\* FIXED" CODE_AUDIT.md
grep -c "Status:\*\* WON'T FIX" CODE_AUDIT.md
```

Expected: 52, 22, 1 — and the three must sum to 75.

```bash
git add CODE_AUDIT.md task.md
git commit -F - <<'EOF'
docs(ios): reconcile the audit ledger with the correctness tail

Flips the five findings this branch fixed, records 5.6 as WON'T FIX with
the condition for revisiting it, files 3.15 so 5.7's deferred part (c)
is not lost behind a FIXED status, and annotates section 2's items 1
and 2 to match what the code now says.

Counts: 75 tracked, 52 OPEN, 22 FIXED, 1 WON'T FIX.
EOF
```

---

## Final verification

Run after Task 7. Every gate must pass before the branch is offered for review.

- [ ] **Full suite green:** `cd cmd/ios-app && ./run-tests.sh` — exit 0
- [ ] **Zero warnings:** the `xcodebuild` command in Ground rules prints `0` from `grep -c "warning:"`
- [ ] **No crash reports added:** `ls ~/Library/Logs/DiagnosticReports/ | grep -c "^PWUsage-"` is not
      greater than Task 0's `N`
- [ ] **No `try!` in tests:** `grep -rn "try!" cmd/ios-app/PWUsageTests/` returns nothing
- [ ] **No dead helper:** `grep -rn "isBuiltIn" cmd/ios-app/PWUsage cmd/ios-app/PWUsageTests` returns
      nothing
- [ ] **No 100% glyph for unknown:** `grep -n "100percent" cmd/ios-app/PWUsage/Views/DashboardPresentation.swift`
      shows it only inside the `switch`, never as a `nil` fallback
- [ ] **Ledger sums:** OPEN + FIXED + WON'T FIX == 75
- [ ] **Commits:** seven, in the spec's order, each green on its own
      — **Amended 2026-09-30: the branch has ten.** Three were added during execution
      (`8c44dc9` test-target warnings, `3a367bb` split out of the §5.7 commit on review,
      `03c41d5` §2 item 2, which D7 wrongly struck). Each commit's reason is recorded in
      `task.md` under the commit-count ruling, and the design doc's commit table carries the
      same three rows with the same reasons.

## Not in this branch

Recorded here so a later reader does not assume they were forgotten.

- §3.1-§3.11 concurrency/lifetime findings, and the new §3.15
- §4.1-§4.5 API modernity, including the `@Observable` migration
- §5.6's fix (WON'T FIX, with a revisit condition)
- §5.7 part (c) (re-filed as §3.15)
- §6.3 untested destructive keychain path
- §7.2-§7.6 performance
- §8.1-§8.17 SwiftUI/UI modernization
- §9.1-§9.15 dead code and refactors, including the §9.8 and §9.9 file splits
- Two owed device checks that cannot be discharged here: §8.18's rendered glyph and §5.10's
  alert-over-dialog presentation. Both need a real sign-in.
