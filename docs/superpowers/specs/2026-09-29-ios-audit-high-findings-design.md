# iOS Audit High Findings — Design Spec

**Date:** 2026-09-29
**Branch:** `fix/ios-audit-high-findings` (from `feature/ios-solcast-load-timing-v2`)
**Source:** [`CODE_AUDIT.md`](../../CODE_AUDIT.md) — 70 findings, 10 High, 0 Critical

## Goal

Fix the 10 High-severity findings from the `cmd/ios-app` audit, plus the three Mediums that are mechanically coupled to them, without regressing the app's behaviour or its zero-warning build.

## Non-goals

- The other 60 audit findings (42 Medium, 17 Low, and §4.6's negative result). They remain available for later branches.
- Whether the estimator's *economic model* is right. §5.1 below is a labelling defect, not a maths defect — that distinction is load-bearing and is argued in that section.
- The server half of the five-minute balance-offset assumption (`LoadTimingForecastEstimator.swift:108-112`). It cannot be settled from iOS source and is listed in the audit's §11.
- Any `@Observable` migration. The audit files it as Medium (§4.1); it is not coupled to a High.

## Constraints carried from the repo

- All iOS tests use Swift Testing (`import Testing`, `@Suite`, `@Test`, `#expect`, `#require`). No XCTest. — `AGENTS.md`
- Every native test run uses `./run-tests.sh`, never `xcodebuild test` directly. — `AGENTS.md`
- The build must stay at **zero Swift compiler warnings**; the audit captured this as ground truth and it is a regression gate.
- Battery SoC must never be presented as fresh when stale; if too old, show unknown (`--`). — `AGENTS.md`, the TRMNL route rules
- Release requires HTTPS. — `cmd/ios-app/README.md`
- No `any`. Explicit types for all parameters and returns. — `AGENTS.md`
- Swift Testing runs use `./run-tests.sh <Suite>` to target a suite.

## Tracking

[`CODE_AUDIT.md`](../../CODE_AUDIT.md) is retained as the **live cross-PR tracking list** for iOS audit work, not a one-shot report. It carries a `Status` bullet on every finding, updated in the same commit that fixes the finding — never batched into a later cleanup. Section and finding numbers are stable across edits, so a later branch can reference `§3.1` in its PR description and mean the same thing.

This branch fixes the 10 High findings plus 3 coupled Mediums and flips those specific `Status` bullets. The remaining 56 findings stay `OPEN` for later branches.

`task.md` remains the per-session ledger for *why* a decision was made; `CODE_AUDIT.md` remains the list of *what* is still outstanding. They are not duplicates: a `Ruling:` line in `task.md` explains a departure from the audit's recommendation, while the `Status` bullet records completion.

## Decisions already made with the reviewer

Four design questions were settled before this spec was written. Each is recorded here because the reasoning, not just the outcome, is what a future reader needs.

### D1 — §5.1 keeps the delta and fixes the wording

The audit filed the estimator's `costNow`/`recommendedCost` as "marginal deltas presented as the cost of a run" and rated it High. On re-reading the code, **the maths is right and the label is wrong**, so the severity was overstated and the fix is narrower than the audit implied.

`score()` (`LoadTimingForecastEstimator.swift:461-474`) returns `Σ (cost(withLoad) − cost(baseline))`. When a load is served by stored surplus, that delta approaches zero — and zero is the *correct* answer to "what will running this cost me?", because the energy was already paid for. Adding an absolute cost (available for free, since `loadedCost` is already in scope at `:464`) would hide that opportunity cost behind a large absolute figure.

**Decision:** keep the delta, change the label to name the measure. No estimator change.

### D2 — §7.1 dedupes and narrows, and adds no cache

The audit proposed three locations for a cached estimator result. Caching anywhere introduces a staleness question (the horizon start advances with the clock), and freezing it for up to 60 s is a behaviour change nobody asked for.

**Decision:** compute the overlay once per body pass in the parent and pass it to both cards, and narrow the `TimelineView` so it wraps only the labels that show a moving clock. This removes the 2× duplication and the per-minute full-body rebuild outright, with no new state and no staleness decision.

### D3 — §5.3 debounces screen appearance rather than honouring the 30-minute claim

The audit proposed making `loadTimingDetailAppeared` respect the documented 30-minute cadence. The reviewer preferred keeping the Load timing screen feeling fresh and instead putting a floor under it.

**Decision:** replace the `force: Bool` parameter with a three-case `BillRefreshTrigger` — `.userGesture`, `.screenAppearance`, `.scheduled` — and apply a 5-minute floor to `.screenAppearance`. `README.md:45` is rewritten to describe the real behaviour rather than the 30-minute claim the audit filed against.

### D4 — §5.4 treats an undated reading as unknown

`AGENTS.md` forbids presenting stale SoC as fresh. The server enforces a two-hour rule; the client enforced nothing.

**Decision:** decode-time suppression. If `stateOfChargeAt` is nil, or the age is negative, or the age exceeds two hours, `stateOfCharge` becomes `nil`. Anything that cannot be dated is unknown. If a server bug drops the timestamp the user sees `--` instead of a real reading — that is the correct direction to fail.

### D5 — §5.11 fails loudly per configuration

**Decision:** a bad origin logs in both configurations; Debug falls back to the **beta** host (never production — that is the confusion `README.md:26` warns about), Release refuses rather than defaulting.

## Workstreams

Seven groups, one commit each, ordered so that a failure in any group leaves the branch shippable. Groups A and D are independent of everything else; Group B is the only one with internal ordering constraints.

### Group A — Sign-in continuation lifecycle (§3.3)

`MobileAuthService` is `@MainActor final class … NSObject`, so `deinit` is available.

- Wrap the `withCheckedThrowingContinuation` in `withTaskCancellationHandler`; on cancellation call `session.cancel()` and resume through the existing idempotent `completeSignIn` (`:213`).
- Delete the two local `continuation.resume(...)` calls at `:123` and `:136`. Routing every path through `completeSignIn` is what removes the double-resume shape. No new `AuthError` case is needed — `.cancelled` already exists.
- `deinit` nils `webSession`.

**Files:** `PWUsage/Authentication/MobileAuthService.swift`
**Tests:** `PWUsageTests/MobileAuthServiceTests.swift`

### Group B — Coordinator lifecycle and polling (§3.1, §3.2, §5.2, §5.3)

All four touch `DashboardCoordinator`, so they land together, in this order.

1. **§3.1** — add `deinit` cancelling `timerTask`/`liveTask`/`billTask`; make `signOut()` and `invalidateSession()` call `scenePhaseChanged(isActive: false)` *before* dropping the reference. The explicit teardown is what actually stops the post-sign-out request; `deinit` is belt-and-braces.
2. **§3.2** — replace the `didBootstrap` latch with a terminal-state check so `bootstrap()` re-runs while `screenState` is still `.bootstrapping`.
3. **§5.3** — introduce `BillRefreshTrigger` with the semantics in D3. `.screenAppearance` applies a 5-minute floor; the floor is a named constant beside `billInterval`, not a literal.
4. **§5.2** — in `refreshSolarForecast(manual:)`, when `loadPlanningContext == nil`, fall through to `loadTimingDetailAppeared()` instead of returning `failedWithBasic`, and preserve `solarForecastUnavailableReason`.

**Files:** `PWUsage/State/DashboardCoordinator.swift`, `PWUsage/PWUsageApp.swift`, `cmd/ios-app/README.md` (the §5.3 behaviour description)
**Tests:** `PWUsageTests/DashboardCoordinatorTests.swift`, `PWUsageTests/PWUsageAppModelTests.swift`

### Group C — Battery SoC client rule (§5.4 + §5.9)

Enforced at decode time in `MobileLiveResponse.init(from:)` so every consumer inherits it, not just `DashboardView`.

- Suppress `stateOfCharge` to `nil` per D4.
- Validate `stateOfCharge` and the four live power values for finiteness and range (§5.9), mapping out-of-range to `nil`.
- Thread an injected clock through `MobileContractDecoder.make()` rather than calling `Date()` inside `init(from:)`, keeping the rule testable.

**Files:** `PWUsage/Models/MobileContracts.swift`, `PWUsage/Networking/PWUsageAPI.swift`
**Tests:** `PWUsageTests/MobileContractsTests.swift`, `PWUsageTests/PWUsageAPITests.swift`

### Group D — Config and signing (§6.1, §6.2, §5.11)

- **§6.1** — delete `DEVELOPMENT_TEAM` from `project.yml:48`. **Verified safe:** `.github/workflows/ios.yml` runs `./run-tests.sh`, which passes `CODE_SIGNING_ALLOWED=NO` and no team, so CI is unaffected. Only a local device build needs it, which `README.md:19` already documents. `README.md:16` becomes accurate as written.
- **§6.2** — add a Release host allowlist (`pwusage.fm.rodeo`). Debug keeps accepting any host so local development still works.
- **§5.11** — per D5, log in both configurations, fall back to beta in Debug, refuse in Release.

**Files:** `cmd/ios-app/project.yml`, `PWUsage/Configuration/AppConfiguration.swift`, `PWUsage/PWUsageApp.swift`
**Tests:** `PWUsageTests/AppConfigurationTests.swift`

### Group E — Cost labelling (§5.1)

Presentation only; the estimator is untouched and `absoluteCost` is not added, per D1.

- `"Start now: $X"` becomes wording that names the measure, e.g. `"Start now — adds $5.40 to your projected bill"`, with the matching change for the recommended start.
- Update the `Comparison.costNow` / `recommendedCost` doc comments so the next reader knows these are marginal.

**Files:** `PWUsage/Views/LoadTimingForecastPresentation.swift`, `PWUsage/Models/LoadTimingForecastEstimator.swift` (doc comment only)
**Tests:** `PWUsageTests/LoadTimingViewTests.swift` (`LoadTimingForecastPresentationTests` suite)

### Group F — Estimator performance (§7.1)

Structural, per D2. No new state.

- Compute `forecastOverlay` once in the parent's body and pass it to both `recommendationCard` and `explorerCard`, removing the 2× duplication.
- Narrow the `TimelineView(.everyMinute)` to wrap only the freshness/source-status labels, not the whole `ScrollView`. This also resolves §7.7 (`.refreshable` living inside a per-minute rebuild) as a side effect, and fixes the discarded `context.date` at `LoadTimingView.swift:274`.

**Files:** `PWUsage/Views/LoadTimingView.swift`
**Tests:** existing suites must pass unchanged apart from Group E's string updates. No new test — this is a structural refactor, verified by the suite plus a manual check that the minute tick still updates the freshness labels.

### Group G — Swallowed errors (§5.10)

`LoadProfileStore` already throws `LoadProfileError` deliberately, and `LoadProfileStoreTests` already asserts that contract at `:43`, `:133-135`. The defect is entirely in the view: three `try?` calls discard errors the store intends to surface.

- Replace `try?` at `LoadProfilesSheet.swift:65` (delete), `:82` (reset), `:102` (select) with a `catch` that writes the underlying error into `validationMessage`.
- Keep the confirmation dialog open on failure so the user learns the profile was not removed, instead of the dialog closing and the row still being there.
- Stop replacing the save `catch` error with "Enter valid profile settings and try again."

**Files:** `PWUsage/Views/LoadProfilesSheet.swift`
**Tests:** no new test. This suite has no `View` testing infrastructure — `LoadTimingViewTests` tests presentation enums, not views — and introducing it for this group would be scope creep. The store's throwing contract is already covered at `LoadProfileStoreTests.swift:43` and `:133-135`; the fix is the removal of three `try?` calls plus their `catch` wiring, verified by the existing suite staying green and by inspection.

## Test strategy

TDD per `AGENTS.md` and the `test-driven-development` skill: failing test first, then the minimal implementation, then commit.

- Swift Testing throughout. No XCTest.
- Per group: `./run-tests.sh <Suite>` for the affected suites, then a full `./run-tests.sh` before the branch is considered finished.
- The zero-warning build is a regression gate: `xcodebuild -project PWUsage.xcodeproj -scheme PWUsage -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build` must stay warning-free.
- `task.md` gains a section for this branch, matching the ledger convention the previous iOS work used — including a `Ruling:` line for D1 and D3, since both contradict what the audit recommended.

## Risks

| Risk | Mitigation |
| --- | --- |
| Group B's §5.3 change alters polling behaviour the audit measured against a 30-min claim | D3 pins the exact trigger semantics; tests cover all three cases; README updated in the same commit |
| Group C's decode-time suppression could hide *fresh* readings if a server field is renamed | The suppression is keyed on `sources.stateOfChargeAt`, which is already decoded; a missing field yields nil, which D4 deliberately treats as unknown |
| Removing `DEVELOPMENT_TEAM` breaks the user's local device build | `README.md:19` already documents the shell override; verified CI does not depend on it |
| Group F's `TimelineView` narrowing changes which views refresh on the minute tick | Manual check is an explicit step; the freshness labels are the only intended consumers |

## Review focus

Inputs the spec implies but no task's tests obviously exercise:

1. **A bill request already in flight when the trigger fires** — the floor must not start a second concurrent request; it must join or skip.
2. **`stateOfChargeAt` in the future** (device clock behind the server) — D4 says suppress; verify the decode actually does rather than computing a negative age that passes a naive `> 2h` check.
3. **Sign-in cancelled while the token exchange is already running** — cancelling must not leave `isAuthenticated` flipped after the user backed out.
4. **Sign-out with a live request already in flight** — the response must not repopulate state after teardown.
5. **A Debug build with `PWUSAGE_API_ORIGIN` set to `http://localhost:5174`** — must still work after the allowlist is added; the allowlist is Release-only.

Each of these gets a test in the group that owns the code:

| # | Case | Group |
| --- | --- | --- |
| 1 | Bill request already in flight when the trigger fires — the floor joins or skips, never double-requests | B |
| 2 | `stateOfChargeAt` in the future (device clock behind server) — suppressed, not passed by a naive `> 2h` on a negative age | C |
| 3 | Sign-in cancelled while the token exchange is already running — `isAuthenticated` must not flip after the user backs out | A |
| 4 | Sign-out with a live request already in flight — the response must not repopulate state after teardown | B |
| 5 | Debug build with `PWUSAGE_API_ORIGIN=http://localhost:5174` — still works; the allowlist is Release-only | D |
