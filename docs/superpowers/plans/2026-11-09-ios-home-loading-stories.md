# iOS Home Loading Stories Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Home cards wait with a quiet animated "story" (an SF Symbol plus a rotating line) instead
of false "unavailable" copy or greyed old numbers. Each card pops in when its data arrives, and
breaks honestly when its request fails.

**Architecture:**
- **Coordinator.** `DashboardCoordinator` marks each endpoint whose reading is missing or more than
  15 minutes old on arrival (cold launch, site switch, return from background, re-auth) with a
  `FreshReadingWait`. The wait bypasses that endpoint's cadence so a fetch is always on the way. A
  success clears the wait; a failure marks it `hasFailed`.
- **Presentation.** A pure `HomeLoadingPresentation` turns the endpoint states into a per-card
  `HomeCardPhase` and supplies the copy.
- **View.** `DashboardView` renders each card as the real content (loaded) or a same-size
  placeholder with a `HomeCardStory` overlay (waiting or broken).

**Tech Stack:**
- Swift 6 and SwiftUI on iOS 18: `symbolEffect` with `.variableColor.iterative` and `.breathe`,
  plus `.contentTransition(.symbolEffect(.replace))`.
- Swift Testing.

**Spec:** `docs/superpowers/specs/2026-11-09-ios-home-loading-stories-design.md`

## Global Constraints

- Swift Testing only. Use `eventually` / `staysTrue` from `PWUsageTests/TestWaits.swift`, never
  sleep-then-assert.
- Lint must be clean: run `./cmd/ios-app/lint.sh` from the repo root.
  - Lines are at most 120 characters, functions at most 50 lines, files at most 400 lines.
  - No trailing commas. No `swiftlint:disable` comments. No force unwraps.
- Zero compiler warnings.
- Tests: run `./run-tests.sh --quick <Suite>` from `cmd/ios-app` while iterating, and a plain
  `./run-tests.sh` once before the PR.
- Freshness limit: **15 min** (`15 * 60`). Slow after: **10 s**. Story lines rotate every
  **2.4 s**.
- Copy goes in verbatim, using the typographic ellipsis "…" and apostrophe "’":
  - Slow line: "Taking longer than usual…"
  - Broken hint: "Pull down to try again."
  - Per-card lines are in Task 3.
- Symbols:

  | Card | Waiting symbol | Motion | Broken symbol |
  |---|---|---|---|
  | Live | `bolt.fill` | breathe | `bolt.slash.fill` |
  | Today | `chart.bar.xaxis` | variableColor | `exclamationmark.triangle` |
  | Bill | `dollarsign.circle` | variableColor | `exclamationmark.triangle` |
  | Smart Shift | `timer` | breathe | `exclamationmark.triangle` |

  Broken symbols are tinted `.orange`. Waiting symbols and lines use `.secondary`.
- **Reduce Motion.** No symbol effects. Lines change without animation. Pop-in is opacity only.
- **Scope.** The freshness rule hides values on Home only. Never clear `response` for it: the Bill
  tab, the Smart Shift tab and the widgets keep reading the same state.
- **When the rule applies.** Only on arrival. A reading shown during a session stays shown as it
  ages; the existing stale banner covers that case.

## Review Focus

1. **A failed request must not retry every 30 s.** Once `hasFailed` is set, the wait stops
   bypassing the cadence. Owning test: Task 2 `failedWaitUsesNormalCadence`.
2. **Coming back after 16–29 min must fetch `live` and `bill` despite their 30 min cadence.**
   Owning test: Task 2 `returnAfterGapFetchesWaitingEndpoints`.
3. **The background save must not make an old reading look fresh.** Owning test: Task 1
   `backgroundSaveKeepsFetchTime`.
4. **Live card on the fast power route.** A power failure while the `live` summary is still loading
   keeps the card waiting. A `live` success alone loads it through the snapshot. Owning tests:
   Task 3 `livePhaseCombinesEndpoints`.
5. **A quick return (under 15 min) changes nothing.** No wait, no extra summary or bill request.
   Owning test: Task 2 `quickReturnKeepsReadings` (the existing `raiseRefreshesPowerOnly` also
   guards this).

---

### Task 1: Fresh-reading waits in the coordinator

**Files:**
- Modify: `cmd/ios-app/PWUsage/Models/DashboardContracts.swift` (`DashboardEndpointState`)
- Modify: `cmd/ios-app/PWUsage/State/Home/DashboardCoordinator.swift` (`restoreCachedReadings`,
  `scenePhaseChanged`, `authenticationRestored`)
- Modify: `cmd/ios-app/PWUsage/State/Home/DashboardCoordinator+Refresh.swift` (`refreshAll`, power
  success, `performBill`, `handle`)
- Modify: `cmd/ios-app/PWUsage/State/Home/DashboardCoordinator+HistoryRefresh.swift`
  (`publishLive`)
- Create: `cmd/ios-app/PWUsage/State/Home/DashboardCoordinator+FreshReadings.swift`
- Test: `cmd/ios-app/PWUsageTests/DashboardCoordinatorFreshnessTests.swift` (an
  `extension DashboardCoordinatorTests`, matching `DashboardCoordinatorCacheTests.swift`)

**Interfaces:**
- **Produces, in `DashboardContracts.swift`:**
  - `struct FreshReadingWait: Equatable { let since: Date; var hasFailed = false }`
  - `DashboardEndpointState.freshReadingWait: FreshReadingWait?`, which `reset()` sets to `nil`.
- **Produces, in `DashboardCoordinator+FreshReadings.swift`:**
  - `static let freshReadingLimit: TimeInterval = 15 * 60`
  - `func holdStaleReadings(at date: Date)`. For each of `live`, `bill` and `power`: set
    `freshReadingWait = FreshReadingWait(since: date)` when `response == nil`, or when
    `lastSuccess` is nil, or when `date.timeIntervalSince(lastSuccess) > freshReadingLimit`.
    Otherwise set it to `nil`. A future-dated `lastSuccess` (negative age) counts as fresh.
  - `func retryFailedWaits(at date: Date)`. Every wait with `hasFailed` becomes
    `FreshReadingWait(since: date)`.

- [ ] **Step 1: Write the failing tests** in `DashboardCoordinatorFreshnessTests.swift`.
  Use `DashboardTestClock`, `DashboardAPISpy`, `FastDashboardAPISpy` and a temp-file
  `DashboardCache`, as in `diskSnapshotsRestorePerSite`.
  - `restoreHoldsOldReadings`:
    - Cache a run at `clock.now`, then advance 16 min and build a new coordinator from the cache.
    - Expect `live.freshReadingWait?.since == clock.now`, the same for `bill`, and
      `live.response != nil` (kept, not cleared).
  - `restoreShowsRecentReadings`:
    - The same, but advance 15 min.
    - Expect `live.freshReadingWait == nil` and `bill.freshReadingWait == nil`.
    - Expect `power.freshReadingWait != nil`, because power is never cached.
  - `successClearsWait`:
    - Start from `restoreHoldsOldReadings`, then `await refreshAll(trigger: .userGesture)`.
    - Expect all three waits to be nil when using `FastDashboardAPISpy`.
  - `failureMarksWait`:
    - Set `api.billError = URLError(.notConnectedToInternet)` and refresh.
    - Expect `bill.freshReadingWait?.hasFailed == true` and `bill.isUnavailable`.
  - `pullRetriesFailedWaits`:
    - After `failureMarksWait`, clear the error and hold the bill (`api.holdBill = true`).
    - Start a `.userGesture` refresh in a `Task`.
    - `eventually { coordinator.bill.freshReadingWait?.hasFailed == false }`.
  - `backgroundSaveKeepsFetchTime`:
    - A fast-API run at T. Advance 20 min and refresh power only (`refreshPower(force: true)`).
    - Call `scenePhaseChanged(isActive: false)`.
    - Expect `cache.snapshot.live["site-1"]?.savedAt == T`, which is `live.lastSuccess`, not the
      later time.
  - `foregroundAfterGapHoldsReadings`:
    - With an in-memory run at T, call `scenePhaseChanged(isActive: false)`, advance 20 min,
      set `api.summary.holdLive = true`, then call `scenePhaseChanged(isActive: true)`.
    - Expect `live.freshReadingWait?.since == clock.now` immediately after the call.

- [ ] **Step 2: Run them and confirm they fail**

  Run: `./run-tests.sh --quick DashboardCoordinatorTests` (from `cmd/ios-app`)
  Expected: build failure, because `freshReadingWait` does not exist yet.

- [ ] **Step 3: Implement**
  - Add the struct and property, with `reset()` clearing it.
  - Add the extension file with `freshReadingLimit`, `holdStaleReadings(at:)` and
    `retryFailedWaits(at:)`.
  - **Call `holdStaleReadings(at: now())`:**
    - at the end of `restoreCachedReadings()`, which covers init, `restoreLaunchCache` and
      `selectSite`;
    - in `scenePhaseChanged(isActive: true)`, right after `refreshSettled = false`;
    - in `authenticationRestored()`, before `startTimer()`.
  - **Call `retryFailedWaits(at: now())`** at the start of `refreshAll` when
    `trigger == .userGesture`.
  - **Clear waits on success:**
    - `publishLive` sets `live.freshReadingWait = nil`. It also sets `power.freshReadingWait = nil`
      inside the branch that replaces `power.response`.
    - The power success path sets `power.freshReadingWait = nil`.
    - `performBill` success sets `bill.freshReadingWait = nil`.
  - **Mark waits on failure.** In `handle(_:generation:endpoint:)`'s endpoint switch, set
    `<endpoint>.freshReadingWait?.hasFailed = true` beside `isUnavailable = true`.
  - **Background save.** In the `scenePhaseChanged(isActive: false)` branch, change
    `cache?.storeLive(..., at: now())` to `at: live.lastSuccess ?? now()`.

- [ ] **Step 4: Run and confirm they pass**

  Run: `./run-tests.sh --quick DashboardCoordinatorTests`
  Expected: PASS, including the existing suites in the same `DashboardCoordinatorTests` family.

- [ ] **Step 5: Lint, then commit**

  Run `./cmd/ios-app/lint.sh`. Then commit with the message
  `feat(ios): hold Home readings older than 15 minutes until refreshed`.

---

### Task 2: Fetch on return

**Files:**
- Modify: `cmd/ios-app/PWUsage/State/Home/DashboardCoordinator+Refresh.swift`
  (`startLiveTaskIfNeeded`, `launchBillTaskIfNeeded`, `refreshPower`)
- Test: `cmd/ios-app/PWUsageTests/DashboardCoordinatorFreshnessTests.swift`

**Interfaces:**
- Consumes `freshReadingWait` from Task 1.
- Produces an internal helper:
  `extension DashboardEndpointState { var awaitsFetch: Bool { freshReadingWait.map { !$0.hasFailed } ?? false } }`.
  Put it in `DashboardCoordinator+FreshReadings.swift`.

- [ ] **Step 1: Write the failing tests**
  - `returnAfterGapFetchesWaitingEndpoints`:
    - Use `FastDashboardAPISpy`.
    - Activate and `eventually { refreshSettled }`. Background, advance 20 min, activate, and
      `eventually { refreshSettled }`.
    - Expect `api.summary.liveSiteIDs.count == 2` and `api.summary.billSiteIDs.count == 2`.
  - `quickReturnKeepsReadings`:
    - The same, but advance 10 min.
    - Expect both counts to be `1`, and all waits to be nil.
  - `failedWaitUsesNormalCadence`:
    - Start from cold with `api.summary.billError` set. Activate and settle, so the bill wait has
      failed.
    - Advance 1 min and call `refreshDue()` 3 times.
    - Expect `api.summary.billSiteIDs.count == 1`.

- [ ] **Step 2: Run them and confirm they fail**

  Run: `./run-tests.sh --quick DashboardCoordinatorTests`
  Expected: `returnAfterGapFetchesWaitingEndpoints` FAILS with a count of 1.

- [ ] **Step 3: Implement**
  - `startLiveTaskIfNeeded`: allow the request when
    `trigger.skipsCadence || live.awaitsFetch || live.cadence.isDue(...)`.
  - `launchBillTaskIfNeeded`: OR `bill.awaitsFetch` into `due` for `.scheduled` and
    `.screenAppearance`.
  - `refreshPower`: treat `power.awaitsFetch` like `force`.

- [ ] **Step 4: Run and confirm they pass**

  Run: `./run-tests.sh --quick DashboardCoordinatorTests`
  Expected: PASS, including `fastPowerDoesNotPollHistory` and `raiseRefreshesPowerOnly`.

- [ ] **Step 5: Lint, then commit**

  Run `./cmd/ios-app/lint.sh`. Then commit with the message
  `feat(ios): fetch Home readings that are waiting when the app returns`.

---

### Task 3: Card phase and copy

**Files:**
- Create: `cmd/ios-app/PWUsage/Views/Home/HomeLoadingPresentation.swift`
- Test: `cmd/ios-app/PWUsageTests/HomeLoadingPresentationTests.swift`

**Interfaces:**
- Consumes `FreshReadingWait` from Task 1.
- Produces:

```swift
enum HomeCardPhase: Equatable { case waiting(isSlow: Bool), broken, loaded }

struct HomeEndpointStatus: Equatable {
    let hasResponse: Bool
    let wait: FreshReadingWait?
}

enum HomeCard: CaseIterable {
    case live, today, bill, smartShift
    var title: String            // "Live power", "Today so far", "Current Bill", "Smart Shift"
    var waitingSymbol: String
    var brokenSymbol: String
    var usesVariableColor: Bool  // true for today and bill; the others breathe
    var storyLines: [String]
    var failureLine: String
}

enum HomeLoadingPresentation {
    static let slowAfter: TimeInterval = 10
    static let lineInterval: TimeInterval = 2.4
    static let slowLine = "Taking longer than usual…"
    static let retryHint = "Pull down to try again."
    static func phase(_ status: HomeEndpointStatus, now: Date) -> HomeCardPhase
    static func livePhase(power: HomeEndpointStatus, live: HomeEndpointStatus, now: Date) -> HomeCardPhase
    static func line(for card: HomeCard, phase: HomeCardPhase, now: Date) -> String
    static func accessibilityLabel(for card: HomeCard, phase: HomeCardPhase) -> String
}
```

Copy (verbatim):

| Card | `storyLines` | `failureLine` |
|---|---|---|
| live | "Reaching your Powerwall…", "Checking your solar…", "Reading the grid…" | "Couldn’t reach your Powerwall." |
| today | "Adding up today’s energy…", "Counting kilowatt-hours…" | "Couldn’t load today’s energy." |
| bill | "Estimating your bill…", "Applying your rate plan…" | "Couldn’t estimate your bill." |
| smartShift | "Checking your rate periods…", "Finding the cheapest times…" | "Couldn’t check your rate periods." |

**Rules.**

`phase`:
1. `wait == nil && hasResponse` → `.loaded`.
2. `wait?.hasFailed == true` → `.broken`.
3. `wait == nil && !hasResponse` → `.waiting(isSlow: false)`.
4. Otherwise → `.waiting(isSlow: now.timeIntervalSince(since) >= slowAfter)`.

`livePhase`:
1. Either part `.loaded` → `.loaded`.
2. Both parts `.broken` → `.broken`.
3. Otherwise → `.waiting(isSlow:)`, where `isSlow` is true if either part is slow.

`line`:
- `.waiting(isSlow: true)` → `slowLine`.
- `.waiting(isSlow: false)` →
  `storyLines[Int(now.timeIntervalSinceReferenceDate / lineInterval) % storyLines.count]`.
- `.broken` → `failureLine`.
- `.loaded` → `""`.

`accessibilityLabel`:
- `.waiting` → `"\(title), loading"`.
- `.broken` → `"\(title). \(failureLine) \(retryHint)"`.
- `.loaded` → `title`.

- [ ] **Step 1: Write the failing tests** in `HomeLoadingPresentationTests.swift`, a
  `@Suite("Home loading presentation")`.
  - `phaseRules`:
    - Cover each of the four `phase` rules. At the boundaries: 9.9 s → `.waiting(isSlow: false)`,
      10 s → `.waiting(isSlow: true)`.
  - `livePhaseCombinesEndpoints`:
    - Power broken and live waiting → `.waiting(isSlow: false)`.
    - Power broken and live loaded → `.loaded`.
    - Both broken → `.broken`.
    - Power waiting slow and live waiting → `.waiting(isSlow: true)`.
  - `linesRotateAndSlowWins`:
    - At `Date(timeIntervalSinceReferenceDate: 0)`, live shows "Reaching your Powerwall…".
    - At `2.4` it shows "Checking your solar…".
    - At `7.2` it wraps back to the first line.
    - When slow it shows "Taking longer than usual…".
    - When broken it shows "Couldn’t reach your Powerwall.".
  - `voiceOverLabels`:
    - Waiting → `"Current Bill, loading"`.
    - Broken → `"Current Bill. Couldn’t estimate your bill. Pull down to try again."`.

- [ ] **Step 2: Run them and confirm they fail**

  Run: `./run-tests.sh --quick HomeLoadingPresentationTests`
  Expected: build failure, because the types don't exist yet.

- [ ] **Step 3: Implement `HomeLoadingPresentation.swift`** to the rules above.

- [ ] **Step 4: Run and confirm they pass**

  Run: `./run-tests.sh --quick HomeLoadingPresentationTests`
  Expected: PASS.

- [ ] **Step 5: Lint, then commit**

  Run `./cmd/ios-app/lint.sh`. Then commit with the message
  `feat(ios): Home card loading phases and story copy`.

---

### Task 4: Story cards on Home

**Files:**
- Create: `cmd/ios-app/PWUsage/Views/Home/HomeCardStory.swift`
- Create: `cmd/ios-app/PWUsage/Views/Home/DashboardView+Loading.swift`, holding the phase
  accessors and the four placeholder builders, to keep `DashboardView.swift` under 400 lines.
- Modify: `cmd/ios-app/PWUsage/Views/Home/DashboardView.swift`
- Modify: `cmd/ios-app/PWUsage/Views/Home/DashboardView+Live.swift`
- Modify: `cmd/ios-app/PWUsage/Views/Home/LivePowerFlowCards.swift` (delete `LoadingCard` if no
  other user remains; check with grep first)
- Modify: `cmd/ios-app/PWUsage/Views/Home/DashboardPreviews.swift` (add a waiting preview and a
  broken preview, if the preview fixtures allow building coordinator states)

**Interfaces:**
- Consumes Task 3's types and Task 1's `freshReadingWait`.
- Produces:
  - `struct HomeCardStory: View { let card: HomeCard; let phase: (Date) -> HomeCardPhase }`
  - In `DashboardView+Loading.swift`:
    - `var livePhase: (Date) -> HomeCardPhase`, `var todayPhase`, `var billPhase`, and
      `var smartShiftPhase`.
    - Each builds `HomeEndpointStatus` from the coordinator (`hasResponse: x.response != nil`,
      `wait: x.freshReadingWait`).
    - For Live, use `coordinator.usesLivePowerEndpoint ? power status : live status` as the power
      half. `todayPhase` and `smartShiftPhase` read `live`; `billPhase` reads `bill`.

- [ ] **Step 1: Build `HomeCardStory`**
  - **Timeline.** Wrap the content in
    `TimelineView(.periodic(from: .now, by: HomeLoadingPresentation.lineInterval / 2))`, and
    evaluate `phase(context.date)` inside it.
  - **Layout.** An `HStack(spacing: 12)` of an `Image` and a `VStack` of the line, plus `retryHint`
    in `.footnote` `.secondary` when broken. Center it vertically in the space it's given, with a
    leading alignment and 16 pt horizontal padding.
  - **Image:**
    - `Image(systemName: isBroken ? card.brokenSymbol : card.waitingSymbol)`, in `.title2`.
    - `.foregroundStyle(isBroken ? .orange : .secondary)`.
    - `.contentTransition(.symbolEffect(.replace))`.
    - `.symbolEffect(.variableColor.iterative, options: .repeating, isActive: animates && card.usesVariableColor)`.
    - `.symbolEffect(.breathe, options: .repeating, isActive: animates && !card.usesVariableColor)`.
    - `animates` is `!reduceMotion && !isBroken`.
  - **Line.** `Text(HomeLoadingPresentation.line(...))` in `.subheadline`, `.secondary`.
    - Add `.contentTransition(.opacity)` and `.animation(reduceMotion ? nil : .easeInOut(duration: 0.4), value: line)`.
  - **Accessibility.** `.accessibilityElement(children: .ignore)` with
    `.accessibilityLabel(HomeLoadingPresentation.accessibilityLabel(...))`.

- [ ] **Step 2: Add the placeholders.** Each card's waiting form must have exactly the loaded
  card's frame.
  - **Approach.** Render the loaded layout with sample values at `.opacity(0)` and
    `.accessibilityHidden(true)`, inside the same `StatusCard`, with `HomeCardStory` overlaid.
  - **Live.**
    - The real `batteryHeader` structure, with a "100%" text and a 44 pt battery symbol, then a
      `Divider`.
    - Then `LivePowerFlowCards(flow: DashboardPresentation.powerFlow(.init(solarPower: 0, loadPower: 0, batteryPower: 0, gridPower: 0, sourceTime: now, isUnavailable: false), now: now))`.
  - **Today.** `adaptiveGrid(TodayEnergyPresentation.tiles(homeKwh: 0, solarKwh: 0, gridNetKwh: 0, batteryNetKwh: 0))`.
  - **Bill and Smart Shift.**
    - Extract each loaded card's inner `HStack` into a private builder that takes its strings, so
      the loaded card and the placeholder share it.
    - Bill: `billCardContent(cost:cycle:)`.
    - Smart Shift: `smartShiftCardContent(_ summary:)`. For the placeholder, use the summary
      `loadTimingSummary` returns for a loaded tariff-less state, so the height matches the
      common case.

- [ ] **Step 3: Wire the sections**
  - **Pattern.** Each section switches on its phase at `.now`:
    - `.loaded` → the existing content.
    - Anything else → the placeholder with the story.
  - **Transition.** `.transition(reduceMotion ? .opacity : .opacity.combined(with: .scale(scale: 0.98)))`
    and `.animation(reduceMotion ? .default : .smooth, value: phase == .loaded)` on the section.
  - **Remove:**
    - Live's `EmptyCard("Live readings unavailable")` and `LoadingCard` branches.
    - Today's final `else` fallback `EmptyCard("Energy data unavailable")`, which is unreachable
      once loaded implies `live != nil`. Keep the "No energy data yet" branch, which is true.
    - Bill's "Bill estimate unavailable" / "is loading" `StatusCard`.
    - The `loadTimingSummary(nil …)` render while `live` is nil.
  - **Scoreboard.** `liveScoreboard(now:)` returns nil unless `livePhase(now) == .loaded`.
  - **Leave `staleNotice` unchanged.**

- [ ] **Step 4: Build and run the whole quick suite**

  Run: `./run-tests.sh --quick` (from `cmd/ios-app`)
  Expected: PASS with zero warnings. Check the build log with
  `grep -c "warning:"` on the retained log if one is printed.

- [ ] **Step 5: Look at it**
  - Run the app in the simulator (use the `run` skill pattern, or `xcrun simctl` with the
    PWUsageDev scheme).
  - Screenshot a cold launch with the cache cleared, so the stories show, and the loaded state.
  - Confirm nothing jumps: in a screen recording or consecutive screenshots, the card frames match.

- [ ] **Step 6: Lint, then commit**

  Run `./cmd/ios-app/lint.sh`. Then commit with the message
  `feat(ios): little-story loading cards on Home`.

---

### Task 5: Finish

- [ ] **Step 1: Update the spec.** In the "Failure with fresh data on hand" call, replace "Once
  that data passes 15 minutes, the card turns Broken" with: the rule applies on arrival only, and
  data shown during a session stays as it ages, covered by the stale banner.
- [ ] **Step 2: Run the full default suite**

  Run `./run-tests.sh` from `cmd/ios-app`.
  Expected: PASS.
- [ ] **Step 3: Commit, push and open a draft PR**
  - Commit the spec and the plan.
  - Push the branch with
    `git push -u origin feat/home-loading-stories`.
  - Open a draft PR with `gh pr create --draft --base main`. Its body summarises the cards, the
    freshness rule and fetch on return, and lists the device checks to do: Reduce Motion,
    VoiceOver, a cold launch on cellular, and a return after 20 minutes.
