# iOS Audit High Findings — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the 10 High-severity findings from the `cmd/ios-app` audit, plus the three Mediums mechanically coupled to them, in seven independently revertable commits.

**Architecture:** Every group is a self-contained change to one subsystem. No group introduces a new architectural pattern; three introduce a small named type or constant (`BillRefreshTrigger`, `billMinimumInterval`, a decoder `userInfo` key). Groups A and D are independent of all others. Group B is the only group with internal ordering constraints and is executed in its stated order.

**Tech Stack:** Swift 6, SwiftUI, iOS 18 deployment target, Swift Testing (`import Testing`), XcodeGen, `xcodebuild`.

**Spec:** [`docs/superpowers/specs/2026-09-29-ios-audit-high-findings-design.md`](../specs/2026-09-29-ios-audit-high-findings-design.md) — read it before starting. Decisions D1–D5 in that spec override the audit's own recommendations in two places (D1, D3) and are not open to re-litigation during implementation.

## Global Constraints

- Every task's requirements implicitly include this section.
- All iOS tests use Swift Testing (`import Testing`, `@Suite`, `@Test`, `#expect`, `#require`). No XCTest.
- Run tests only via `./run-tests.sh`, never `xcodebuild test` directly. Target a suite with `./run-tests.sh <Suite>`, a single test with `./run-tests.sh <Suite>/<method>`.
- All test runs happen in `cmd/ios-app`.
- **Zero-warning gate:** the build must remain free of Swift compiler warnings. The audit captured zero as the baseline; any new warning fails the task.
- Strictly no `any`. Every parameter and return type is explicit.
- Battery SoC must never be presented as fresh when stale. Too old, or undatable, means unknown (`--`).
- Release requires HTTPS. A Release build additionally requires an allowlisted host (Task D).
- The `.serialized` trait on `MobileAuthServiceTests` and `SolarForecastStoreTests` must be preserved; those suites share state.
- TDD: write the failing test, watch it fail, then implement the minimum that passes. Do not write implementation first.
- One commit per task, using the exact message in that task's final step.
- **Every task's commit also flips that task's findings in `CODE_AUDIT.md`** from `OPEN` to `FIXED (PR #N, commit <sha>)`, in the same commit — never batched into a later cleanup. That file is the live cross-PR tracking list; its `§N.M` numbers are stable and referenced from PR descriptions. Fill in the real PR number and the commit's own short sha, which is only knowable after committing, so amend the commit once to complete the line rather than leaving a placeholder.

## Review Focus

Five inputs the spec implies that no task's tests obviously exercise. Each is pinned to the task that owns the code; a task is not complete until its row is covered.

| # | Case | Expected behaviour | Task |
| --- | --- | --- | --- |
| 1 | A bill request is already in flight when a trigger fires | The new trigger joins or skips; it never starts a second concurrent request | B |
| 2 | `stateOfChargeAt` is in the future (device clock behind server) | SoC is suppressed, not passed by a naive `> 2h` test on a negative age | C |
| 3 | Sign-in is cancelled while the token exchange is already running | `isAuthenticated` does not flip to `true` after the user backed out | A |
| 4 | Sign-out with a live request already in flight | The late response does not repopulate state after teardown | B |
| 5 | Debug build with `PWUSAGE_API_ORIGIN=http://localhost:5174` | Still accepted; the host allowlist is Release-only | D |

## File Structure

| File | Responsibility | Tasks |
| --- | --- | --- |
| `PWUsage/Authentication/MobileAuthService.swift` | PKCE sign-in, session cookie lifecycle | A |
| `PWUsage/State/DashboardCoordinator.swift` | Polling cadence, forecast enhancement orchestration | B |
| `PWUsage/PWUsageApp.swift` | App model, bootstrap, scene phase | B, D |
| `cmd/ios-app/README.md` | Behaviour documentation for the app target | B |
| `PWUsage/Models/MobileContracts.swift` | Wire DTOs and their decoding rules | C |
| `PWUsage/Networking/PWUsageAPI.swift` | Endpoint construction and decoding | C |
| `cmd/ios-app/project.yml` | XcodeGen spec, per-config settings | D |
| `PWUsage/Configuration/AppConfiguration.swift` | API origin selection and validation | D |
| `PWUsage/Views/LoadTimingForecastPresentation.swift` | Forecast overlay copy | E |
| `PWUsage/Models/LoadTimingForecastEstimator.swift` | Estimator (doc comment only) | E |
| `PWUsage/Views/LoadTimingView.swift` | Load timing screen | F |
| `PWUsage/Views/LoadProfilesSheet.swift` | Profile management sheet | G |

---

### Task A: Sign-in continuation lifecycle (§3.3)

**Closes in `CODE_AUDIT.md`:** §3.3

**Files:**
- Modify: `PWUsage/Authentication/MobileAuthService.swift:114-140`, `:213-217`
- Test: `PWUsageTests/MobileAuthServiceTests.swift`

**Interfaces:**
- Consumes: `MobileAuthWebSession.cancel()` (already declared at `MobileAuthService.swift:11`, already implemented by the test fake at `MobileAuthServiceTests.swift:297`)
- Produces: `MobileAuthService.signIn() async throws` — unchanged signature, but now resumes on caller cancellation with `AuthError.cancelled`. `deinit` nils `webSession`. No new `AuthError` case.

**Notes:** `completeSignIn` at `:213-217` already guards on `pendingContinuation != nil` and clears it before resuming, so it is the single idempotent resume point. Two call sites currently bypass it by resuming a local continuation — that bypass is the bug. `AuthError.cancelled` already exists (`:35`); reuse it.

- [ ] **Step 1: Write the failing tests**

Add three `@Test` methods to `MobileAuthServiceTests`. Use the existing `makeService(isAuthenticated:)` helper and `FakeWebAuthenticationSession`.

```swift
@Test("Cancelling sign-in resumes once and clears the pending continuation")
func cancellingSignInResumesOnceAndClearsPending() async throws {
    let fakeSession = FakeWebAuthenticationSession()
    let service = makeService(sessionFactory: { _, _, completion in
        fakeSession.configure(completion: completion)
        return fakeSession
    })
    let task = Task { try await service.signIn() }
    await #expect(service.pendingContinuationForTesting != nil)
    task.cancel()
    await #expect(throws: MobileAuthService.AuthError.cancelled) { try await task.value }
    // The continuation must be cleared, or every later sign-in throws alreadyInProgress.
    let second = Task { try await service.signIn() }
    fakeSession.complete(url: try #require(Self.validCallbackURL))
    _ = try? await second.value
}
```

If `pendingContinuationForTesting` does not exist, add a minimal `var pendingContinuationForTesting: Bool { pendingContinuation != nil }` to the service under test — it is the only way to observe the leak, and it is worth the three lines.

```swift
@Test("A web session that fails to start does not resume twice")
func failedStartDoesNotResumeTwice() async throws {
    let fakeSession = FakeWebAuthenticationSession()
    fakeSession.startResult = false
    let service = makeService(sessionFactory: { _, _, _ in fakeSession })
    await #expect(throws: MobileAuthService.AuthError.sessionCouldNotStart) { try await service.signIn() }
    // A late completion from the failed session must not resume an already-resumed continuation.
    fakeSession.complete(error: URLError(.cancelled))
}

@Test("Cancelling during a stalled token exchange does not authenticate")
func cancellingDuringStalledExchangeDoesNotAuthenticate() async throws {
    // Pins Review Focus #3.
    let api = FakeMobileAuthAPI()
    api.suspendsExchange = true
    let fakeSession = FakeWebAuthenticationSession()
    let service = makeService(api: api, sessionFactory: { _, _, completion in
        fakeSession.configure(completion: completion)
        return fakeSession
    })
    let task = Task { try await service.signIn() }
    fakeSession.complete(url: try #require(Self.validCallbackURL))
    task.cancel()
    api.resumeExchange()
    _ = try? await task.value
    #expect(service.isAuthenticated == false)
}
```

`FakeMobileAuthAPI` already supports a stalled exchange — `resumeExchange()` exists at `:328` and `secondSignInIsRejectedUntilTheFirstSessionExchangeFinishes` at `:118` already drives it. Add a `suspendsExchange` flag if the existing fake does not already have one.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `./run-tests.sh MobileAuthServiceTests`
Expected: FAIL — `cancellingSignInResumesOnceAndClearsPending` and `cancellingDuringStalledExchangeDoesNotAuthenticate` hang or throw `alreadyInProgress`; `failedStartDoesNotResumeTwice` may pass or trap on double-resume. The first failure is the signal that matters.

- [ ] **Step 3: Implement cancellation and remove the two local resumes**

In `signIn()`, replace the bare `withCheckedThrowingContinuation` with `withTaskCancellationHandler(operation:onCancel:)`. The `onCancel` closure calls `session.cancel()` and then `completeSignIn(continuation, with: .failure(.cancelled))`.

Delete the `continuation.resume(throwing: AuthError.webAuthenticationFailed)` at the `[weak self]`-nil branch (`:123`) and the `continuation.resume(throwing: AuthError.sessionCouldNotStart)` in the `start() == false` branch (`:136`). Both become `completeSignIn(...)` calls so every path goes through the single idempotent resume.

Add a `deinit` that sets `webSession = nil`. `MobileAuthService` is `@MainActor final class … NSObject`, so a plain `deinit` compiles; it must not touch the main-actor-isolated properties beyond the plain stored-property nil, which is permitted.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `./run-tests.sh MobileAuthServiceTests`
Expected: PASS, all 16 tests.

- [ ] **Step 5: Verify the build stays warning-free**

Run: `xcodebuild -project PWUsage.xcodeproj -scheme PWUsage -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build 2>&1 | grep -c "warning:.*\.swift"`
Expected: `0`

- [ ] **Step 6: Commit**

```bash
git add CODE_AUDIT.md PWUsage/Authentication/MobileAuthService.swift PWUsageTests/MobileAuthServiceTests.swift
git commit -m "fix(ios): cancel and guard the sign-in continuation

The sign-in continuation had no cancellation handler, so a cancelled
sign-in leaked the continuation and left pendingContinuation non-nil,
making every later sign-in throw alreadyInProgress forever. Two paths
also resumed a local continuation directly, bypassing the idempotent
completeSignIn that already existed.

Adds a deinit so the web session does not outlive the service."
```

---

### Task B: Coordinator lifecycle and polling (§3.1, §3.2, §5.2, §5.3)

**Closes in `CODE_AUDIT.md`:** §3.1, §3.2, §5.2, §5.3

**Files:**
- Modify: `PWUsage/State/DashboardCoordinator.swift:113-114`, `:212-215`, `:288-355`, `:576-583`
- Modify: `PWUsage/PWUsageApp.swift:108-124`, `:181-196`
- Modify: `cmd/ios-app/README.md` (the first-release-bullet describing bill refresh)
- Test: `PWUsageTests/DashboardCoordinatorTests.swift`, `PWUsageTests/PWUsageAppModelTests.swift`

**Interfaces:**
- Consumes: nothing from other tasks
- Produces:
  - `enum BillRefreshTrigger { case userGesture, screenAppearance, scheduled }` — nested in `DashboardCoordinator`
  - `DashboardCoordinator.billMinimumInterval: TimeInterval = 5 * 60` — `static let`, beside `billInterval` at `:114`
  - `private func launchBillTaskIfNeeded(trigger: BillRefreshTrigger, requestTime: Date, generation: Int)` — replaces the `force: Bool` parameter
  - `func refreshBill(trigger: BillRefreshTrigger) async` — replaces `refreshBill(force: Bool = true)` at `:273`
  - `func refreshAll(trigger: BillRefreshTrigger) async` — replaces `refreshAll(force: Bool = true)` at `:243`

**Do these four in order.** §3.1 first (it is the only one that is a security-adjacent correctness fix), then §3.2, then §5.3, then §5.2.

**Call-site map for §5.3.** Verified by grep; every production path that reaches the bill endpoint, and what it should become:

| Call site | Reaches | Today | Becomes |
| --- | --- | --- | --- |
| `refreshDue()` `:238` → `refreshAll(force: false)` | live + bill | bill `isDue` at 30 min | `.scheduled` (unchanged behaviour) |
| `DashboardView` `.refreshable` `:36` → `refreshAll()` | live + bill | forces bill (default arg) | `.userGesture` |
| `BillView` `.refreshable` `:39` → `refreshBill()` | bill | forces bill (default arg) | `.userGesture` |
| `loadTimingDetailAppeared` `:319` → `refreshBill(force: true)` | bill | forces bill | `.screenAppearance` — **the §5.3 fix** |
| `loadTimingDetailRefreshed` `:524` → `refreshBill(force: true)` | bill | forces bill | `.userGesture` |

`scenePhaseChanged` `:189` and `selectSite` `:229` both go through `refreshDue()` → `force: false`, so they are already correctly scheduled and must keep that behaviour. The Load-timing foreground path reaches `loadTimingDetailAppeared` via `LoadTimingView`'s `onChange(of: coordinator.isForeground)` at `:359-362`, which is the route the audit filed.

- [ ] **Step 1: Write the failing tests for §3.1 and Review Focus #4**

In `DashboardCoordinatorTests`, using the existing `DashboardAPISpy`:

```swift
@Test("No request is issued on the next timer tick after sign-out")
func noRequestAfterSignOut() async throws {
    let clock = TestClock()
    let api = DashboardAPISpy()
    let coordinator = makeCoordinator(api: api, clock: clock)
    coordinator.scenePhaseChanged(isActive: true)
    await coordinator.refreshAll()
    let callsBeforeSignOut = api.liveCallCount

    // Sign-out clears the scene and drops the coordinator; the timer must not
    // outlive it with isForeground still true.
    coordinator.authenticationInvalidated()
    coordinator.scenePhaseChanged(isActive: false)
    #expect(coordinator.pollingTimerIsActive == false)

    await clock.advance(by: .seconds(60))
    #expect(api.liveCallCount == callsBeforeSignOut)
}
```

For Review Focus #4, start a live request, call `authenticationInvalidated()` while it is in flight, let the spy return, and assert `coordinator.live.response == nil` and `coordinator.requiresSignIn == false`.

- [ ] **Step 2: Run to verify failure**

Run: `./run-tests.sh DashboardCoordinatorTests`
Expected: FAIL on `noRequestAfterSignOut` — `pollingTimerIsActive` is still `true` because `signOut` in `PWUsageApp` drops the coordinator without stopping the timer.

- [ ] **Step 3: Implement §3.1**

Add to `DashboardCoordinator`:

```swift
deinit {
    timerTask?.cancel()
    liveTask?.cancel()
    billTask?.cancel()
}
```

In `PWUsageAppModel.signOut()` and `invalidateSession()`, call `coordinator?.scenePhaseChanged(isActive: false)` immediately before `coordinator = nil`. This is the fix that actually stops the request; `deinit` is belt-and-braces for any other drop site.

- [ ] **Step 4: Run to verify pass**

Run: `./run-tests.sh DashboardCoordinatorTests`
Expected: PASS.

- [ ] **Step 5: Write the failing test for §3.2**

In `PWUsageAppModelTests`, using the existing `ApplicationAPISpy`, make `fetchSites` suspend, cancel the bootstrap task mid-flight, then let it return:

```swift
@Test("Bootstrap re-runs after being cancelled before it reaches a terminal state")
func bootstrapRetriesAfterCancellation() async throws {
    // The didBootstrap latch is set on entry, so a cancelled bootstrap left the
    // screen on .bootstrapping with no way to retry.
    #expect(model.screenState == .bootstrapping)
    let retry = Task { await model.bootstrap() }
    await spy.resumeFetchSites()
    await retry.value
    #expect(model.screenState == .signedIn)
}
```

- [ ] **Step 6: Implement §3.2**

In `PWUsageApp.bootstrap()`, replace `guard !didBootstrap else { return }` / `didBootstrap = true` with a terminal-state check: return early only when `screenState` is one of `.signedIn`, `.signedOut`, or `.unavailable`. Set `didBootstrap = true` only on reaching a terminal state, so a cancelled bootstrap is retried on the next `.task`.

- [ ] **Step 7: Write the failing tests for §5.3 and Review Focus #1**

```swift
@Test("Opening Load timing twice inside the minimum interval issues one bill request")
func screenAppearanceDebouncesBillRequests() async throws {
    await coordinator.loadTimingDetailAppeared()
    let afterFirst = api.billCallCount
    await coordinator.loadTimingDetailAppeared()
    #expect(api.billCallCount == afterFirst)
}

@Test("An explicit refresh always issues a bill request")
func userGestureAlwaysRefreshesBill() async throws {
    await coordinator.loadTimingDetailAppeared()
    let afterFirst = api.billCallCount
    await clock.advance(by: .seconds(10))
    await coordinator.loadTimingDetailRefreshed()
    #expect(api.billCallCount > afterFirst)
}

@Test("An in-flight bill request is not duplicated by a second trigger")
func inFlightBillRequestIsNotDuplicated() async throws {
    // Pins Review Focus #1.
    let first = Task { await coordinator.loadTimingDetailAppeared() }
    let second = Task { await coordinator.loadTimingDetailAppeared() }
    await first.value
    await second.value
    #expect(api.billCallCount == 1)
}
```

The third test already passes today, because `launchBillTaskIfNeeded` guards on `billTask == nil` at `:578`. It is a regression pin, not a fix — keep it, because Task B rewrites that guard's neighbourhood.

- [ ] **Step 8: Implement §5.3 (D3)**

Add the enum and constant from the Interfaces block. Rewrite `launchBillTaskIfNeeded` so:

- `.userGesture` — always launch.
- `.screenAppearance` — launch only if the last attempt is at least `billMinimumInterval` (5 min) old, i.e. `isDue(lastAttempt: bill.lastAttempt, interval: Self.billMinimumInterval, at: requestTime)`.
- `.scheduled` — launch only if `isDue(lastAttempt: bill.lastAttempt, interval: Self.billInterval, at: requestTime)`.

Keep the existing `guard billTask == nil else { return }` first, so an in-flight request is joined rather than duplicated.

**Drop the `= true` default arguments on both `refreshAll` and `refreshBill`.** Today `refreshAll(force: Bool = true)` and `refreshBill(force: Bool = true)` mean a bare `coordinator.refreshAll()` silently forces a bill request. That default is what let two call sites opt into forcing without saying so, and it is the reason this defect was easy to miss. With `BillRefreshTrigger` there is no default — every call site must state its intent, so a future call site cannot force a bill request by accident.

Update the five call sites from the table above. The live-data check at `:252` keeps its own `force`-derived logic: live is refreshed when the trigger is `.userGesture` or when `isDue` at `liveInterval` holds. Do not change `liveInterval` — the audit did not flag the live cadence.

**`refreshAll` keeps its ordering contract** at `:260-266`: await the live task before launching the bill, so a due bill lands after a potentially-refreshing live import. That comment is load-bearing and must survive the rewrite.

Rewrite the README bullet at `:45` that claims the bill is fetched "at most every 30 minutes while the app is foregrounded" to state the three tiers: 30 minutes on the timer, a 5-minute floor when the Load timing screen opens, and always on an explicit pull.

- [ ] **Step 9: Run to verify pass**

Run: `./run-tests.sh DashboardCoordinatorTests` then `./run-tests.sh PWUsageAppModelTests`
Expected: PASS.

- [ ] **Step 10: Write the failing test for §5.2**

```swift
@Test("Manual refresh refetches a missing household profile")
func manualRefreshRefetchesMissingPlanningContext() async throws {
    // The note says "Pull down to refresh it", but the path returned
    // failedWithBasic without ever re-issuing load-planning-context.
    await coordinator.loadTimingDetailAppeared()
    planningAPI.failNextFetch = true
    await coordinator.loadTimingDetailRefreshed()
    #expect(planningAPI.callCount > 1)
    #expect(coordinator.loadPlanningContext != nil)
}
```

- [ ] **Step 11: Implement §5.2**

In `refreshSolarForecast(manual:)`, when `manual` is true and `loadPlanningContext == nil`, return early by calling `await loadTimingDetailAppeared()` instead of falling into the `failedWithBasic` branch. Do not overwrite `solarForecastUnavailableReason` on that path, so a `serverOutdated` or `contextInvalid` diagnosis computed elsewhere survives.

- [ ] **Step 12: Full test run, then verify the build**

Run: `./run-tests.sh`
Expected: PASS, no failures.

Run: `xcodebuild -project PWUsage.xcodeproj -scheme PWUsage -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build 2>&1 | grep -c "warning:.*\.swift"`
Expected: `0`

- [ ] **Step 13: Commit**

```bash
git add CODE_AUDIT.md PWUsage/State/DashboardCoordinator.swift PWUsage/PWUsageApp.swift cmd/ios-app/README.md PWUsageTests/DashboardCoordinatorTests.swift PWUsageTests/PWUsageAppModelTests.swift
git commit -m "fix(ios): stop the coordinator outliving sign-out, and debounce the bill

Four audit findings in the coordinator:

- authenticationInvalidated() left isForeground true, so the polling
  timer could issue an authenticated request after sign-out. Adds a
  deinit and stops the timer before the coordinator is dropped.
- bootstrap() latched didBootstrap on entry, so a cancellation mid
  installAuthorizedSites left the app on the spinner with no retry.
- loadTimingDetailAppeared forced a bill request on every appearance
  and foreground transition. Replaces the force flag with a
  BillRefreshTrigger: 30 minutes on the timer, a 5-minute floor on
  screen open, always on an explicit pull.
- Manual refresh could never recover a missing household profile,
  while its own note told the user to pull down to refresh."
```

---

### Task C: Battery SoC client rule (§5.4, §5.9)

**Closes in `CODE_AUDIT.md`:** §5.4, §5.9

**Files:**
- Modify: `PWUsage/Models/MobileContracts.swift:61-75`, `:315-327`
- Modify: `PWUsage/Networking/PWUsageAPI.swift:47-54`
- Test: `PWUsageTests/MobileContractsTests.swift`, `PWUsageTests/PWUsageAPITests.swift`

**Interfaces:**
- Consumes: nothing from other tasks
- Produces:
  - `static func make(now: @escaping @Sendable () -> Date = { Date() }) -> JSONDecoder` — replaces `static func make() -> JSONDecoder` at `MobileContracts.swift:316`. The default argument keeps all four existing call sites in `PWUsageAPI` compiling unchanged.
  - `extension CodingUserInfoKey { static let now = … }` — internal to the `MobileContracts` file.

**Notes:** the clock goes in `decoder.userInfo` because `MobileLiveResponse.init(from:)` cannot otherwise see it, and calling `Date()` inside `init(from:)` would make the rule untestable. `fetchLive` at `:47` decodes without any `.validating(...)` call, unlike `fetchBill` at `:58` — put the rule in `init(from:)` so it applies on decode regardless.

- [ ] **Step 1: Write the failing tests**

In `MobileContractsTests`, decoding JSON payloads with a fixed clock:

```swift
@Test("SoC older than two hours decodes as unknown")
func staleStateOfChargeDecodesAsUnknown() throws {
    let now = Date(timeIntervalSince1970: 1_000_000)
    let payload = livePayload(stateOfCharge: 72, stateOfChargeAt: now.addingTimeInterval(-3 * 3600).iso8601)
    let response = try MobileContractDecoder.make(now: { now }).decode(MobileLiveResponse.self, from: payload)
    #expect(response.live.stateOfCharge == nil)
}

@Test("SoC with no source timestamp decodes as unknown")
func undatedStateOfChargeDecodesAsUnknown() throws {
    // Pins D4: anything that cannot be dated is unknown, never "fresh".
    let now = Date(timeIntervalSince1970: 1_000_000)
    let payload = livePayload(stateOfCharge: 72, stateOfChargeAt: nil)
    let response = try MobileContractDecoder.make(now: { now }).decode(MobileLiveResponse.self, from: payload)
    #expect(response.live.stateOfCharge == nil)
}

@Test("SoC dated in the future decodes as unknown")
func futureStateOfChargeDecodesAsUnknown() throws {
    // Pins Review Focus #2. A naive `age > 2h` test passes a negative age.
    let now = Date(timeIntervalSince1970: 1_000_000)
    let payload = livePayload(stateOfCharge: 72, stateOfChargeAt: now.addingTimeInterval(600).iso8601)
    let response = try MobileContractDecoder.make(now: { now }).decode(MobileLiveResponse.self, from: payload)
    #expect(response.live.stateOfCharge == nil)
}

@Test("Fresh SoC survives decode")
func freshStateOfChargeSurvives() throws {
    let now = Date(timeIntervalSince1970: 1_000_000)
    let payload = livePayload(stateOfCharge: 72, stateOfChargeAt: now.addingTimeInterval(-600).iso8601)
    let response = try MobileContractDecoder.make(now: { now }).decode(MobileLiveResponse.self, from: payload)
    #expect(response.live.stateOfCharge == 72)
}

@Test("Out-of-range SoC decodes as unknown")
func outOfRangeStateOfChargeDecodesAsUnknown() throws {
    let now = Date(timeIntervalSince1970: 1_000_000)
    let payload = livePayload(stateOfCharge: 150, stateOfChargeAt: now.addingTimeInterval(-600).iso8601)
    let response = try MobileContractDecoder.make(now: { now }).decode(MobileLiveResponse.self, from: payload)
    #expect(response.live.stateOfCharge == nil)
}
```

Add a `livePayload(stateOfCharge:stateOfChargeAt:)` helper in the test file that builds a minimal valid `MobileLiveResponse` JSON with version 1, reusing the existing fixture helpers where they exist. Build both `stateOfCharge` and `sources.stateOfChargeAt` from the two arguments, so each test varies exactly one thing.

- [ ] **Step 2: Run to verify failure**

Run: `./run-tests.sh MobileContractsTests`
Expected: FAIL — `stateOfCharge` is decoded verbatim today, so the stale, undated, future, and out-of-range cases all return a value.

- [ ] **Step 3: Implement the decode rule**

Add the `CodingUserInfoKey.now` extension in `MobileContracts.swift`. Change `make()` to `make(now:)` and set `decoder.userInfo[.now] = now()` before returning.

In `MobileLiveResponse.init(from:)`, after decoding `sources` and `live`, compute:

```swift
let clock = decoder.userInfo[.now] as? Date ?? Date()
let soC = live.stateOfCharge
let validSoC: Double? = {
    guard let soC, soC.isFinite, (0...100).contains(soC) else { return nil }
    guard let at = sources.stateOfChargeAt else { return nil }
    let age = clock.timeIntervalSince(at)
    guard age >= 0, age <= Self.stateOfChargeMaximumAge else { return nil }
    return soC
}()
```

with `static let stateOfChargeMaximumAge: TimeInterval = 2 * 3600` on `MobileLiveResponse`. Assign `live` with the validated SoC substituted. `init(from:)` currently assigns `self.live` from the container at `:68`; it will need the decoded `Live` value bound to a local first so the substitution can happen — that is the one structural edit this task requires.

Validate the four live power values for finiteness at the same time, mapping non-finite to `0` (they are display values, not unknown-able measurements, and `batterySymbol` and the direction arrow both handle a zero cleanly). Do not range-check powers — negative grid and battery values are legitimate.

- [ ] **Step 4: Run to verify pass**

Run: `./run-tests.sh MobileContractsTests` then `./run-tests.sh PWUsageAPITests`
Expected: PASS. `PWUsageAPI.swift`'s four `MobileContractDecoder.make()` call sites compile unchanged because `now` has a default argument.

- [ ] **Step 5: Verify the build**

Run: `xcodebuild -project PWUsage.xcodeproj -scheme PWUsage -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build 2>&1 | grep -c "warning:.*\.swift"`
Expected: `0`

- [ ] **Step 6: Commit**

```bash
git add CODE_AUDIT.md PWUsage/Models/MobileContracts.swift PWUsage/Networking/PWUsageAPI.swift PWUsageTests/MobileContractsTests.swift PWUsageTests/PWUsageAPITests.swift
git commit -m "fix(ios): enforce the battery SoC freshness rule on the client

The two-hour rule lived only in buildMobileDashboardContract on the
server. The client decoded stateOfCharge verbatim, so any contract
drift, proxy, or cached response would render a stale percentage as
current.

Decoding now suppresses SoC to unknown when the source timestamp is
missing, in the future, or older than two hours, and validates the
value's range and finiteness. The clock is injected through the
decoder's userInfo so the rule is testable."
```

---

### Task D: Config and signing (§6.1, §6.2, §5.11)

**Closes in `CODE_AUDIT.md`:** §6.1, §6.2, §5.11

**Files:**
- Modify: `cmd/ios-app/project.yml:48`
- Modify: `PWUsage/Configuration/AppConfiguration.swift:8-11`, `:20-29`, `:35-47`
- Modify: `PWUsage/PWUsageApp.swift:16`
- Test: `PWUsageTests/AppConfigurationTests.swift`

**Interfaces:**
- Consumes: nothing from other tasks
- Produces:
  - `AppConfiguration.releasedAPIOriginHosts: Set<String>` — `static let`, `["pwusage.fm.rodeo"]`
  - `AppConfiguration.debugFallbackAPIOrigin: URL` — `static let`, `https://pwusagebeta.fm.rodeo`
  - `AppConfiguration.initializationError: (any Error)?` — new stored property so `PWUsageApp` can surface a misconfiguration instead of trapping

**Notes:** CI runs `./run-tests.sh` with `CODE_SIGNING_ALLOWED=NO` and no `DEVELOPMENT_TEAM`, verified against `.github/workflows/ios.yml:36-44`, so removing the committed team ID cannot break CI. Only a local device build needs it, which `README.md:19` already documents.

- [ ] **Step 1: Write the failing tests**

In `AppConfigurationTests`, alongside the six existing tests:

```swift
@Test("Release accepts the production host")
func releaseAcceptsProductionHost() throws {
    #expect(try AppConfiguration(apiOriginString: "https://pwusage.fm.rodeo", isRelease: true).apiOrigin.host == "pwusage.fm.rodeo")
}

@Test("Release rejects a host that is not allowlisted")
func releaseRejectsUnallowlistedHost() {
    #expect(throws: AppConfiguration.ValidationError.self) {
        _ = try AppConfiguration(apiOriginString: "https://pwusagebeta.fm.rodeo", isRelease: true)
    }
}

@Test("Debug still allows a local HTTP origin")
func debugAllowsLocalOriginWithAllowlistPresent() throws {
    // Pins Review Focus #5: the allowlist is Release-only.
    #expect(try AppConfiguration(apiOriginString: "http://localhost:5174", isRelease: false).apiOrigin.host == "localhost")
}
```

- [ ] **Step 2: Run to verify failure**

Run: `./run-tests.sh AppConfigurationTests`
Expected: FAIL on `releaseRejectsUnallowlistedHost` — `validate` never inspects the host.

- [ ] **Step 3: Implement the allowlist**

Add `releasedAPIOriginHosts` as a `static let` on `AppConfiguration`. In `validate`, when `isRelease` is true, add a `components.host` membership check against that set to the existing `guard`.

- [ ] **Step 4: Run to verify pass**

Run: `./run-tests.sh AppConfigurationTests`
Expected: PASS, all 9 tests.

- [ ] **Step 5: Remove the committed signing team**

Delete the `DEVELOPMENT_TEAM: 6HQGHHRK87` line from `project.yml:48`. Leave `CODE_SIGN_STYLE: Automatic` in place.

- [ ] **Step 6: Write the failing test for §5.11**

```swift
@Test("An invalid Debug origin falls back to beta, never to production")
func invalidDebugOriginFallsBackToBeta() throws {
    let config = try AppConfiguration.fromBundle(bundle: .main, environment: ["PWUSAGE_API_ORIGIN": "not a url at all"], isDebug: true)
    #expect(config.apiOrigin.host == "pwusagebeta.fm.rodeo")
}
```

This requires `fromBundle` to take injectable `environment` and `isDebug` parameters with defaults matching today's behaviour (`ProcessInfo.processInfo.environment` and the `#if DEBUG` flag). That signature change is what makes D5 testable.

- [ ] **Step 7: Implement the D5 fallback**

`fromBundle` no longer propagates a parse failure. On failure it records the underlying error in the new `initializationError` property and returns the configuration for `debugFallbackAPIOrigin` in Debug, or rethrows in Release. `PWUsageApp.init` at `:16` stops using `try!` and reads the recorded error instead.

- [ ] **Step 8: Run to verify pass**

Run: `./run-tests.sh AppConfigurationTests` then `./run-tests.sh PWUsageAppModelTests`
Expected: PASS. `PWUsageAppModelTests` covers the model, not the `App` struct, so it should be unaffected — run it to confirm the signature change did not ripple.

- [ ] **Step 9: Verify the build and regenerate the project**

Run: `./generate.sh && xcodebuild -project PWUsage.xcodeproj -scheme PWUsage -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build 2>&1 | grep -c "warning:.*\.swift"`
Expected: `0`

`generate.sh` must run first — the `.xcodeproj` is gitignored and generated, so a `project.yml` change is invisible until it is regenerated.

- [ ] **Step 10: Commit**

```bash
git add CODE_AUDIT.md cmd/ios-app/project.yml PWUsage/Configuration/AppConfiguration.swift PWUsage/PWUsageApp.swift PWUsageTests/AppConfigurationTests.swift
git commit -m "fix(ios): stop shipping the signing team and unvalidated origins

- DEVELOPMENT_TEAM was committed to project.yml, which README.md already
  told developers not to do. CI builds with CODE_SIGNING_ALLOWED=NO and
  no team, so only local device builds are affected.
- Release validation required HTTPS but never checked the host, so any
  allowlisted-by-accident origin would ship silently and the site_auth
  cookie is scoped to whatever host the app talks to.
- An invalid origin silently fell back to production, so a typo in a
  scheme env var turned a Debug build into a production client. Debug
  now falls back to beta; Release refuses."
```

---

### Task E: Cost labelling (§5.1)

**Closes in `CODE_AUDIT.md`:** §5.1

**Files:**
- Modify: `PWUsage/Views/LoadTimingForecastPresentation.swift:131-134`
- Modify: `PWUsage/Models/LoadTimingForecastEstimator.swift:37`, `:40` (doc comments only)
- Test: `PWUsageTests/LoadTimingViewTests.swift` (`LoadTimingForecastPresentationTests` suite, `:285`)

**Interfaces:**
- Consumes: nothing from other tasks
- Produces: no new symbols. Two string literals change; two doc comments change.

**Do not touch the estimator maths.** D1 settled this: the delta is correct and `absoluteCost` is explicitly out of scope. If the new copy reads wrong for a case you hit, fix the copy, not the maths, and say so in the commit.

- [ ] **Step 1: Write the failing tests**

In the `LoadTimingForecastPresentationTests` suite, find the assertions that pin the current `"Start now: $…"` and `"Start at …"` strings and update them to the new copy:

```swift
#expect(overlay.enhanced?.costNow == "Start now — adds $0.05 to your projected bill")
#expect(overlay.enhanced?.recommendedCost == "Start at 3:30 PM — adds $0.02 to your projected bill")
```

Add one case that pins the D1 reasoning, so a future change cannot quietly reintroduce the absolute-cost reading:

```swift
@Test("A near-zero marginal cost renders as an addition, not a total")
func nearZeroDeltaReadsAsAnAddition() throws {
    // The delta is near zero when the load is served by stored surplus. That is
    // the correct answer; the old "Start now: $0.00" read like a broken total.
    #expect(overlay.enhanced?.costNow.contains("adds") == true)
}
```

- [ ] **Step 2: Run to verify failure**

Run: `./run-tests.sh LoadTimingForecastPresentationTests`
Expected: FAIL on the two updated assertions.

- [ ] **Step 3: Implement the copy change**

At `:131` and `:134`, change the two literals to name the measure. Pin these exact forms:

- `costNow` → `"Start now — adds \(money(comparison.costNow)) to your projected bill"`
- `recommendedCost` → `"Start at \(clock(comparison.recommendedStart)) — adds \(money(comparison.recommendedCost)) to your projected bill"`

Add a doc comment to `Comparison.costNow` and `Comparison.recommendedCost` stating that both are the marginal cost of the load against the projected household baseline, not the absolute cost of the energy involved, and that a near-zero value means the load is served by stored surplus.

- [ ] **Step 4: Run to verify pass**

Run: `./run-tests.sh LoadTimingViewTests`
Expected: PASS. Note that this suite name covers `LoadTimingForecastPresentationTests` too — `run-tests.sh` normalizes the prefix, and the audit's §9.12 records that this file's name is misleading.

- [ ] **Step 5: Commit**

```bash
git add CODE_AUDIT.md PWUsage/Views/LoadTimingForecastPresentation.swift PWUsage/Models/LoadTimingForecastEstimator.swift PWUsageTests/LoadTimingViewTests.swift
git commit -m "fix(ios): name what the cost figure measures

costNow and recommendedCost are the marginal cost of the load against
the projected household baseline. Rendered as \"Start now: \$X\" they
read as the absolute cost of the run, which is wrong whenever the load
is served by stored surplus and the delta is near zero.

The estimator maths is correct and is unchanged; only the copy and its
doc comments changed."
```

---

### Task F: Estimator performance (§7.1)

**Closes in `CODE_AUDIT.md`:** §7.1

**Files:**
- Modify: `PWUsage/Views/LoadTimingView.swift:272-331`, `:358-363`, `:366-418`, `:482-514`
- Test: no new test (see Step 4)

**Interfaces:**
- Consumes: nothing from other tasks. Independent of Task E — E is presentation-only, F is structural, and they touch different call sites.
- Produces:
  - `private func forecastOverlay(now:timing:response:profile:) -> LoadTimingForecastPresentation.Overlay?` — gains an optional return so the parent can pass the value down
  - `recommendationCard(_:timing:response:now:overlay:)` and `explorerCard(_:timing:response:now:overlay:)` — each gains an `overlay` parameter

**This task adds no cache and no new stored state**, per D2. The win is removing a 2× duplicate evaluation and a per-minute full-body rebuild.

- [ ] **Step 1: Move the overlay computation to the parent body**

In `body`, after `timingForDisplay` and `recommendation` are bound, compute the overlay once and pass it into both card calls. The overlay's `placement` determines which card carries it, so the parent must compute `LoadTimingForecastPresentation.placement(recommendation:explicitExploredID:)` once and derive the overlay from it — that also removes the second `placement` call currently made independently at `:484-485`.

Change both card methods to take the precomputed `overlay` and stop calling `forecastOverlay` or `placement` internally.

- [ ] **Step 2: Narrow the TimelineView**

Currently `TimelineView(.everyMinute) { _ in let now = Date(); ScrollView { … } }` at `:272-274` wraps the entire screen, and the timeline's own `context.date` is discarded in favour of a fresh `Date()`.

Narrow it so the minute tick reaches only the freshness and source-status labels. Those are the views that call `LoadTimingPresentation.sourceStatus(isUnavailable:energyDataThrough:now:)` and the equivalent battery-age line. Extract them into a small `private struct` that owns its own `TimelineView(.everyMinute) { context in … }` and uses `context.date` directly.

`ScrollView` and its `.refreshable` must end up outside any `TimelineView`, which is what fixes the audit's §7.7 as a side effect.

- [ ] **Step 3: Build and eyeball**

Run: `xcodebuild -project PWUsage.xcodeproj -scheme PWUsage -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build 2>&1 | grep -c "warning:.*\.swift"`
Expected: `0`

Open the Load timing screen in a simulator and confirm the freshness labels still update once per minute and that pull-to-refresh still works. This is the only step in the plan that requires looking at a screen.

- [ ] **Step 4: Run the existing suites**

Run: `./run-tests.sh LoadTimingViewTests` and `./run-tests.sh LoadTimingForecastEstimatorTests`
Expected: PASS, unchanged except for Task E's string updates. No new test: this is a structural refactor with no new observable behaviour, and the suite has no `View` testing infrastructure to assert on it.

- [ ] **Step 5: Commit**

```bash
git add CODE_AUDIT.md PWUsage/Views/LoadTimingView.swift
git commit -m "perf(ios): evaluate the forecast overlay once per body, not twice

forecastOverlay was called from both the recommendation and explorer
cards, and both were inside a TimelineView(.everyMinute) that rebuilt
the whole ScrollView each minute — so a multi-candidate search over the
forecast horizon ran up to twice a minute on the main actor.

Computes the overlay and its placement once in the parent body and
passes them down, and narrows the timeline to the freshness labels,
which are the only views that show a moving clock. ScrollView and
.refreshable now sit outside any timeline."
```

---

### Task G: Swallowed errors (§5.10)

**Closes in `CODE_AUDIT.md`:** §5.10

**Files:**
- Modify: `PWUsage/Views/LoadProfilesSheet.swift:64-67`, `:81-84`, `:101-104`, `:164-166`
- Test: no new test (see Step 4)

**Interfaces:**
- Consumes: `LoadProfileError` thrown by `LoadProfileStore.deleteCustomProfile(id:)` (`:100`), `.resetBuiltInProfile(id:)` (`:108`), `.selectProfile(id:)` (`:117`) — all already `throws` and already covered by `LoadProfileStoreTests.swift:43` and `:133-135`
- Produces: no new symbols. Three `try?` become `do`/`catch` writing to the existing `validationMessage` state.

- [ ] **Step 1: Surface delete and reset failures**

Replace `try? store.deleteCustomProfile(id: profile.id)` at `:65` with a `do`/`catch` that writes the caught error's description into `validationMessage`. On failure, do **not** clear `pendingDeletion` — the confirmation dialog must stay open so the user learns the profile was not removed, rather than the dialog closing with the row still present.

Apply the same shape to `try? store.resetBuiltInProfile(id: profile.id)` at `:82`, keeping `pendingReset` set on failure.

- [ ] **Step 2: Surface select failures**

Replace `try? store.selectProfile(id: profile.id)` at `:102` with a `do`/`catch` writing to `validationMessage`.

- [ ] **Step 3: Stop masking the save error**

At `:164-166`, the save `catch` sets the generic "Enter valid profile settings and try again." Replace it with the underlying error's description. `LoadProfileError` already distinguishes the validation cases the generic message was standing in for, so the specific reason reaches the user.

- [ ] **Step 4: Run the existing suites**

Run: `./run-tests.sh LoadProfileStoreTests`
Expected: PASS, unchanged. The store's throwing contract was already covered; this task only stops the view from discarding it. No new test is added because the suite has no `View` testing infrastructure — `LoadTimingViewTests` exercises presentation enums, not views — and introducing one for three `try?` calls would be scope creep.

- [ ] **Step 5: Commit**

```bash
git add CODE_AUDIT.md PWUsage/Views/LoadProfilesSheet.swift
git commit -m "fix(ios): stop discarding profile errors in the sheet

LoadProfileStore throws LoadProfileError deliberately, and the delete,
reset, and select call sites each discarded it with try? — so a failed
deletion closed its confirmation dialog and left the row in place with
no explanation, and a save failure was reported as a validation problem
even when the values were fine.

Surfaces the underlying reason and keeps the dialog open on failure."
```

---

## Completion

After Task G:

```bash
./run-tests.sh
xcodebuild -project PWUsage.xcodeproj -scheme PWUsage -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

Both must pass.

Then reconcile the two ledgers — they answer different questions and neither replaces the other:

- **`CODE_AUDIT.md`** — flip all 13 findings this branch covers to `FIXED (PR #N, commit <sha>)` and update the Progress table at the top. It is the list of *what is still outstanding*, referenced by `§N.M` from later PR descriptions, so its numbering must not shift.
- **`task.md`** — add a section for this branch using the existing `Ruling:` convention. It is the record of *why* a decision was made, so it needs a ruling for D1 (the audit's §5.1 severity was overstated: the estimator maths is correct and only the copy was wrong) and for D3 (§5.3 became a 5-minute debounce rather than the 30-minute cadence change the audit proposed). Without these, a future reader has the audit in front of them and no record that its recommendation was deliberately declined.
