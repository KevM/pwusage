# iOS Code Audit — `cmd/ios-app`

> **This file is the live tracking list for iOS audit work across PRs.** Every finding carries a `Status` bullet. Update it in the same commit that fixes the finding — do not batch the check-offs into a later cleanup. Section and finding numbers (`§N.M`) are stable: never renumber, because other documents and PR descriptions reference them. If a finding is dropped rather than fixed, leave its number in place and write `_REMOVED: <reason>_` as its body.

**Status values:** `OPEN` → `IN PROGRESS (PR #N)` → `FIXED (PR pending)` → `FIXED (PR #N, commit <sha>)` · `WON'T FIX (<reason>)` · `REMOVED (<reason>)`

*`FIXED (PR pending)` is the form every entry on this branch uses: the finding is fixed and verified in-tree, but the PR number and commit are stamped once the branch merges. Once merged, replace it with `FIXED (PR #N, commit <sha>)`. Do not mix the two forms in one file.*

**Progress:** 74 findings tracked. 17 fixed. First batch in flight on `fix/ios-audit-high-findings` — the 10 High findings plus 3 coupled Mediums (see `docs/superpowers/specs/2026-09-29-ios-audit-high-findings-design.md`). §8.18 was filed after that batch's whole-branch review.

| Status | Count | Findings |
| --- | --- | --- |
| OPEN | 57 | all except §3.1, §3.2, §3.3, §3.12, §3.13, §3.14, §5.1, §5.2, §5.3, §5.4, §5.9, §5.10, §5.11, §6.1, §6.2, §7.1, §7.7 |
| IN PROGRESS | 0 | — |
| FIXED | 17 | §3.1, §3.2, §3.3, §3.12, §3.13, §3.14, §5.1, §5.2, §5.3, §5.4, §5.9, §5.10, §5.11, §6.1, §6.2, §7.1, §7.7 (§4.6 is a recorded negative result, not a finding) |

---

**Audit taken on branch:** `feature/ios-solcast-load-timing-v2`, working tree clean at the time of the audit.
**Findings fixed on branch:** `fix/ios-audit-high-findings`.
**Date:** 2026-09-29
**Scope:** 48 Swift files, ~13,500 LOC (28 app / 20 test). iOS 18 deployment target, Swift 6, SwiftUI, Swift Testing.
**Method:** `ios-code-audit` skill (read-only) + `swiftui-pro`, `swift-concurrency-pro`, `swift-testing-pro` reference passes. Four parallel audits, every Critical/High re-verified by opening the cited lines.

**Compiler ground truth:** `xcodebuild ... -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build` → **BUILD SUCCEEDED with zero Swift compiler warnings.** The single emitted warning is `appintentsmetadataprocessor[...]: Metadata extraction skipped, no AppIntents.framework dependency found` — an unrelated toolchain note. This is a genuinely clean build; §3 reflects that.

---

## 1. Executive summary

1. **[High] Cost figures are marginal deltas presented as the cost of a run** — §5.1 — `LoadTimingForecastEstimator.swift:461-474`
2. **[High] Pull-to-refresh can never recover a missing household profile** — §5.2 — `DashboardCoordinator.swift:379`, `:523-530`
3. **[High] `DEVELOPMENT_TEAM` is committed to `project.yml`, contradicting the README** — §6.1 — `project.yml:48`
4. **[High] Coordinator polls the API after sign-out; no `deinit` anywhere in the app** — §3.1 — `DashboardCoordinator.swift:236-241`, `:712-719`, `PWUsageApp.swift:250-265`
5. **[High] "Bill at most every 30 minutes" is bypassed on every Load-timing appearance and foreground** — §5.3 — `DashboardCoordinator.swift:341`, `LoadTimingView.swift:411-415`
6. **[High] The forecast estimator re-runs on the main actor up to twice per body, every minute** — §7.1 — `LoadTimingView.swift:243`, `:273`, `:407`, `:488`
7. **[High] App can latch permanently on "Connecting to pwusage…"** — §3.2 — `PWUsageApp.swift:108-123`
8. **[High] Sign-in continuation has no cancellation handler and no double-resume guard** — §3.3 — `MobileAuthService.swift:131-168`, `:170-183`
9. **[High] Release origin validation accepts any HTTPS host, with no production allowlist** — §6.2 — `AppConfiguration.swift:96-115`
10. **[High] Battery SoC freshness is enforced only server-side; the client never re-checks it** — §5.4 — `MobileContracts.swift:98-121`, `DashboardView.swift:71`

**No Critical findings survived verification.** Four items were escalated to Critical by the audit passes and were demoted after opening the cited lines — see §12. The highest-severity confirmed issues are High: a mislabelled money figure, an unrecoverable UI state, a leaked signing team ID, and a post-sign-out network request.

---

## 2. Quick wins

Each of these is a small, self-contained edit.

- **`DashboardCoordinator.swift:447-448`** — delete the two empty methods `solarForecastSettingsDidEdit()` and `loadProfileDidEdit()` and their six call sites (`SolarForecastSettingsSheet.swift:29`, `:103`, `:108`, `:181`; `LoadTimingView.swift:406`).
- **~~`LoadTimingView.swift:273` — the `TimelineView(.everyMinute) { _ in` closure discards `context.date` and calls `Date()` instead.~~ Done, as part of §7.1.** The screen-wide timeline that had this shape is gone; the two timelines that remain both bind `context.date` (`LoadTimingView.swift:331`, `:351`, `:763`). The bare `Date()` calls at `:310` and `:319` are body-pass-time by design (see §7.1's residual-divergence note).
- **`PWUsageAPI.swift:109-110`** — remove the no-op `do { … } catch { throw error }` wrapper.
- **`PWUsageAPI.swift:42`** — `fetchSites` uses a bare `JSONDecoder()` while `:49`, `:58`, `:67` all use `MobileContractDecoder.make()`. Route it through the shared decoder.
- **`PWUsage.swift` / `PWUsageApp.swift:13`, `DashboardCoordinator.swift:10`, `:17`** — three scattered one-line retroactive conformances of `PWUsageAPI` to three protocols. Consolidate into one declaration.
- **`SolarForecastSettingsSheet.swift:122`** — the string hardcodes `"of 10 attempts"`, duplicating `SolarForecastStore.totalAttemptsPerUTCDay` (`SolarForecastStore.swift:83`). Interpolate the constant.
- **`SolarForecastPreviews.swift:8`** — `let SitePreviewTimeZone` is a file-scope value in PascalCase. Rename to an upper-snake-case constant.
- **`LoadTimingForecastPresentation.swift:76`** — closing brace on the same line as the `return`; the only such line in the file.
- **`DashboardPreviews.swift:4`, `SolarForecastPreviews.swift:12`** — `CaseIterable` on both preview-mode enums is never used; `allCases` appears nowhere.
- **`LoadProfile.swift:32`** — `isBuiltIn` has no callers. The built-in/custom distinction `LoadProfileStore` actually uses is id comparison at `LoadProfileStore.swift:109`, `:160-165`.

---

## 3. Concurrency

The build is warning-free, and the generation-counter discipline in `SolarForecastStore` (`generations` / `inFlight` / `mutatingScopes`, re-checked after every `await` at `:231`, `:235`, `:398`, `:409`, `:419`, `:428`, `:435`) and in `DashboardCoordinator` (`:249`, `:261`, `:296`, `:490`) is genuinely careful. The findings below are the gaps that discipline does not cover.

### 3.1 Coordinator polls the API after sign-out; no `deinit` anywhere in the app
- **Location:** `PWUsage/State/DashboardCoordinator.swift:236-241` (`authenticationInvalidated`), `:712-719` (the timer loop), `:201` (the `deinit` this finding added); `PWUsage/PWUsageApp.swift:250-265` (`signOut`), `:271-287` (`invalidateSession`), `:293-296` (`teardownCoordinator`) — all re-derived after the fix
- **What:** `signOut()` called `coordinator?.authenticationInvalidated()` then `coordinator = nil`, but `authenticationInvalidated()` only bumped `forecastGeneration` and reset forecast state — it never set `requiresSignIn` or cleared `isForeground`. `DashboardCoordinator` had no `deinit` to cancel `timerTask`/`liveTask`/`billTask`. At the time of the finding, `grep -rn "deinit" PWUsage/` returned **no matches anywhere in the app**.
- **Why:** The timer loop (`:712-719`) holds a strong `self` across `await self.refreshDue()`, and its guard is `self.isForeground, !self.requiresSignIn` — both of which remained `true`/unchanged after sign-out. A live and bill request could therefore be issued *after* the user had signed out.
- **Action:** Add a `deinit` cancelling all three tasks, and have `PWUsageAppModel` call `scenePhaseChanged(isActive: false)` before dropping the coordinator in both `signOut()` and `invalidateSession()`.
- **Severity:** High
- **Status:** FIXED (PR pending)
- **Confidence:** High — verified at finding time by reading `:236-241`, `:712-719`, `PWUsageApp.swift:250-265`, and confirming no `deinit` existed. Post-fix the numbers above name the amended code, not the pre-fix code the audit read.

### 3.2 App can latch permanently on "Connecting to pwusage…"
- **Location:** `PWUsage/PWUsageApp.swift:108-123`, `:220-258`
- **What:** `bootstrap()` sets `didBootstrap = true` on entry and is driven from a `.task` modifier whose task is cancelled on disappear. `installAuthorizedSites` sets `sites` at `:221` but only reaches `screenState = .signedIn` at `:257`, after several `await`s.
- **Why:** A cancellation between those points propagates to the `catch` at `:120`, which sets `.unavailable` only for errors thrown *out of* `bootstrap`. If cancellation lands such that `screenState` stays `.bootstrapping` with `sites` populated, the `.task` reruns on re-appear, `bootstrap()` returns immediately on the `didBootstrap` latch, and the spinner is permanent. There is no retry path.
- **Action:** Reset the latch when bootstrap does not reach a terminal state, or drive it from `.task(id:)` keyed on `screenState` rather than a one-shot boolean.
- **Severity:** High
- **Status:** FIXED (PR pending)
- **Confidence:** High

### 3.3 Sign-in continuation has no cancellation handler and no double-resume guard
- **Location:** `PWUsage/Authentication/MobileAuthService.swift:131-168`, `:170-183`
- **What:** `signIn()` stores a `CheckedContinuation` in `pendingContinuation` and relies entirely on the `ASWebAuthenticationSession` completion; there is no `withTaskCancellationHandler`. The `session.start() == false` branch at `:163-168` resumes the local `continuation` after having stored it in `pendingContinuation`, and the `[weak self]`-nil path at `:147-153` does the same. Separately, the token exchange at `:252` runs in a `Task { @MainActor }` that is not a child of `signIn()`, so cancelling the sign-in does not stop it.
- **Why:** If the calling task is cancelled mid-flow, the continuation is never resumed and `pendingContinuation` stays non-nil, so every later sign-in throws `.alreadyInProgress` (`:132`) forever. The shape is also fragile against double-resume ("SWIFT TASK CONTINUATION MISUSE"), which is not production-reachable today but is one refactor away.
- **Action:** Done. `signIn()` is wrapped in `withTaskCancellationHandler`; `onCancel` (`:170-183`) cancels the session and routes the resume through `completeSignIn`, and the start-failure and `[weak self]`-nil paths do the same, so every completion path is idempotent and generation-scoped. The originally prescribed `deinit` was **dropped, deliberately**: it was a provable no-op (the object is deallocating and `ASWebAuthenticationSession` does not retain the service, so `webSession = nil` releases nothing), and its own comment conceded it was no substitute for `onCancel`. Cancelling the sheet is `onCancel`'s job and is now done there. See §3.13 and §3.14 for the generation scoping that makes those paths safe.
- **Severity:** High
- **Status:** FIXED (PR pending)
- **Confidence:** High — verified `:131-168` and `:170-183`, and the `deinit` claim by confirming the session is never retained by the service (the completion closure captures `self` weakly).

### 3.4 A cancelled fetch is recorded as "data unavailable"
- **Location:** `PWUsage/State/DashboardCoordinator.swift:591-605`, `:607-622`, `:626-651`
- **What:** `performLive`/`performBill` funnel every thrown error — including the `URLError.cancelled` produced at `:632-633` or by `selectSite`'s `liveTask?.cancel()` at `:222` — into `handle(_:generation:endpoint:)`, which sets `isUnavailable = true` and a status code.
- **Why:** Cancelling a pull-to-refresh, or the sibling-cancel in the `signInRequired` branch, shows "Live data is temporarily unavailable" even though nothing failed. The generation check filters the site-switch case but not these.
- **Action:** Handle `CancellationError` and `URLError.cancelled` explicitly in `performLive`/`performBill` and return without touching endpoint state.
- **Severity:** Medium
- **Status:** OPEN
- **Confidence:** High

### 3.5 The timer loop can exit without clearing `timerTask`
- **Location:** `PWUsage/State/DashboardCoordinator.swift:129`, `:653-660`
- **What:** `startTimer` guards on `timerTask == nil` and `pollingTimerIsActive` reports `timerTask != nil`, but both `return` statements in the loop body (the sleep `catch` and the `guard let self, self.isForeground, !self.requiresSignIn`) exit without resetting the property.
- **Why:** A later `startTimer()` becomes a no-op and `pollingTimerIsActive` lies. This is currently latent — I could not find a path where `isForeground` or `requiresSignIn` changes without `stopTimer` also running — but §3.1 shows the invariant is maintained only by convention, and §3.6 makes the exit reachable.
- **Action:** Clear `timerTask` in the loop's exit path (a `defer` inside the task body).
- **Severity:** Medium
- **Status:** OPEN
- **Confidence:** High

### 3.6 `refreshAll` awaits detached task handles, so caller cancellation escapes a non-throwing API
- **Location:** `PWUsage/State/DashboardCoordinator.swift:243-284` (awaits at `:260`, `:268`, `:283`), `:655-660`
- **What:** `refreshAll` is `async` and non-throwing but awaits `liveTask?.value` / `billTask?.value` on `Task<Void, Never>` handles. The timer loop at `:660` calls `await self.refreshDue()` outside any `do` block.
- **Why:** `Task.value` honours cancellation of the *awaiting* context, so a `CancellationError` can escape the timer loop's `Task<Void, Never>` body, terminating the polling loop and leaving `timerTask` non-nil — the exact combination §3.5 describes.
- **Action:** Make the awaits cancellation-tolerant, or convert to `async let` children. Wrap the timer body in a `catch is CancellationError` that clears `timerTask`.
- **Severity:** Medium
- **Status:** OPEN
- **Confidence:** Medium — reasoned from `Task.value` semantics, not observed at runtime.

### 3.7 Cadence timestamps are stamped before the request runs
- **Location:** `PWUsage/State/DashboardCoordinator.swift:251-257`, `:577-584`
- **What:** `live.lastAttempt` / `bill.lastAttempt` are set to `now()` immediately before spawning the task, not on response.
- **Why:** A request that fails or is abandoned still suppresses the next attempt for the full 5/30 minutes. A transient network failure or a user-cancelled pull-to-refresh silently costs a full cadence window of freshness.
- **Action:** Record the attempt time on completion, or track last-success separately from last-attempt for the cadence decision.
- **Severity:** Medium
- **Status:** OPEN
- **Confidence:** High

### 3.8 `selectSite` starts multi-endpoint work without checking foreground state
- **Location:** `PWUsage/State/DashboardCoordinator.swift:217-234`
- **What:** `selectSite` guards on `isForeground` for the `refreshDue` task at `:229-230`, then unconditionally spawns `Task { await loadTimingDetailAppeared() }` at `:233`.
- **Why:** A site switch made while inactive (or immediately before backgrounding) issues a full bill + planning-context + Solcast refresh that continues after the scene is no longer active, spending Solcast budget with no user watching. This is the clearest violation of the README's "stops timers in the background" claim.
- **Action:** Apply the same `isForeground` guard to the enhancement task, or defer it to the next foreground transition.
- **Severity:** Medium
- **Status:** OPEN
- **Confidence:** High

### 3.9 Planning-context cache and in-flight tasks survive sign-out
- **Location:** `PWUsage/State/DashboardCoordinator.swift:212-215`, `:455-518`
- **What:** `authenticationInvalidated()` bumps `forecastGeneration` and resets published state, but leaves `planningContextCache` (24-hour lifetime at `:462`) and `planningContextTasks` untouched.
- **Why:** A cached household profile survives a session change and is reused verbatim when the same site is re-selected after re-authentication; an in-flight request issued under the old session still writes to the cache at `:500` on return. The `siteID`/generation guards cover the *published* state but not the cache, so the two can disagree.
- **Action:** Clear `planningContextCache` and cancel/clear `planningContextTasks` in `authenticationInvalidated()` and `selectSite`.
- **Severity:** Low
- **Status:** OPEN
- **Confidence:** High

### 3.10 `@MainActor` on the data protocols but not on the conforming class
- **Location:** `PWUsage/State/DashboardCoordinator.swift:4-17`; `PWUsage/Networking/PWUsageAPI.swift:17-23`
- **What:** `MobileDashboardDataAPI` and `MobileLoadPlanningDataAPI` are `@MainActor`, while `MobileAuthAPI` (same concrete type) is not, and a retroactive extension conforms the non-isolated class to the main-actor-isolated protocols.
- **Why:** Not a correctness bug (URLSession work is nominally nonisolated), but the same object is simultaneously isolated and not depending on which protocol it is viewed through, and the dependency cannot be injected behind a background actor.
- **Action:** Drop `@MainActor` from the two data protocols and let the `@MainActor` coordinator do its own state mutation after `await`.
- **Severity:** Medium
- **Status:** OPEN
- **Confidence:** High

### 3.11 Unstructured `Task { }` with no retained handle
- **Location:** ~20 sites: `DashboardCoordinator.swift:190`, `:207`, `:230`, `:233`, `:474-486`; `PWUsageApp.swift:38`, `:56`, `:253`, `:297`, `:304`, `:308`, `:327`, `:363`; `LoadTimingView.swift:414`; `SolarForecastSettingsSheet.swift:32`, `:53`, `:89`, `:114`, `:134`; `MobileAuthService.swift:171`, `:252`, `:305`
- **What:** Fire-and-forget tasks spawned from `init`-adjacent, button-action, `onChange`, and Combine-sink contexts; none retain a handle or check `Task.isCancelled`.
- **Why:** They cannot be cancelled when their view disappears — `LoadTimingView.swift:414` fires a full bill + context + Solcast refresh on foreground that outlives the screen, and the Combine sink at `PWUsageApp.swift:253` can race a subsequent sign-in.
- **Action:** Use structured scopes: `.task`/`.task(id:)` in views, retained `Task?` properties in stores, `AsyncStream` instead of `sink` + `Task` in `PWUsageAppModel`.
- **Severity:** Medium
- **Status:** OPEN
- **Confidence:** High

### 3.12 A late failed token exchange can sign out a newer, successful sign-in
- **Location:** `PWUsage/Authentication/MobileAuthService.swift:252-263`
- **What:** The token exchange runs in a detached `Task { @MainActor }` that is not a child of `signIn()`, so it keeps running after the sign-in is cancelled. On failure it assigned `isAuthenticated = false` unconditionally, before calling `completeSignIn`. The success branch was guarded by `completeSignIn`'s `Bool` return; the failure branch was not.
- **Why:** Cancelling a sign-in whose exchange is already in flight leaves that exchange running. If it then fails, the unguarded assignment clears `isAuthenticated` for whatever session state exists at that moment — including a *newer* sign-in that has already succeeded. A user who cancels one sign-in and immediately signs in again can be signed straight back out, with no action of their own.
- **Action:** Route the failure branch through the same guard: `if completeSignIn(continuation, with: .failure(error)) { isAuthenticated = false }`. Covered by `lateFailedExchangeCannotSignOutNewerSuccessfulSignIn`.
- **Severity:** High
- **Status:** FIXED (PR pending)
- **Confidence:** High — verified by reverting the guard and observing the new test fail.

### 3.13 `completeSignIn` guards on "some continuation is pending", not "this continuation is pending"
- **Location:** `PWUsage/Authentication/MobileAuthService.swift:274-284` (`completeSignIn`), reached from the detached exchange task at `:252-263` and from the `onCancel` handler at `:170-183`
- **What:** The guard is `pendingContinuation != nil`, not an identity check against the `continuation` argument. `CheckedContinuation` is a struct, so identity is not directly available and a partial fix is not a one-liner. Any completion therefore claims the shared slot, regardless of which sign-in attempt it belongs to.
- **Why:** Sign-in A is cancelled while its detached exchange is in flight: `onCancel` runs `completeSignIn(A)`, which resumes A's continuation and clears the slot. A newer sign-in B then sets `pendingContinuation = B`. When A's exchange finally reports a result, `completeSignIn(A)` still sees a non-nil slot, so it (a) resumes **A's already-resumed continuation** a second time — a process-level "SWIFT TASK CONTINUATION MISUSE" trap, not an observable error — and (b) nils out the slot, discarding B's continuation so B's own later success fails its guard and never sets `isAuthenticated = true`. The window is narrow and needs a slow exchange plus a fast re-sign-in, but the consequence is a crash or a permanently stuck signed-out state, not merely a brief flicker. Note `lateFailedExchangeCannotSignOutNewerSuccessfulSignIn` does not cover this: it awaits B to completion before resuming A's exchange, so the slot is already nil.
- **Action:** Done. The pending slot is now a `PendingSignIn` value pairing the continuation with the sign-in generation that owns it; `signIn()` bumps `signInGeneration` and captures it, and `completeSignIn(generation:_:with:)` refuses to resume or clear unless that generation still owns the slot. Every completion path (session callback, start failure, `onCancel`, detached exchange) goes through it, and its `Bool` return still gates the `isAuthenticated` side effects. Covered by `lateFailedExchangeCannotDisturbNewerPendingSignIn`.
- **Severity:** High
- **Status:** FIXED (PR pending)
- **Confidence:** High — the double-resume was reproduced before the fix. `lateFailedExchangeCannotDisturbNewerPendingSignIn` drove A to a stalled exchange, cancelled A, let B claim the slot, then failed A's exchange; the pre-fix binary died with `EXC_BREAKPOINT`/SIGTRAP ("SWIFT TASK CONTINUATION MISUSE") at `MobileAuthService.swift:248` `continuation.resume(with:)` from the detached exchange task, killing the whole test process with 0 assertions reported. The fix leaves A's late failure inert and B completes and authenticates.

### 3.14 A superseded attempt's session callback is applied to the live attempt
- **Location:** `PWUsage/Authentication/MobileAuthService.swift:215-229` (`finishAuthentication`), reached from the session closure at `:146-159`
- **What:** `finishAuthentication` read `pendingSignIn` and `activeAttempt` as *whatever was current*: it took the pending slot's generation, nil'd `webSession`/`activeAttempt`, and then called `completeSignIn(generation: <the live attempt's generation>, …)` with its own error. The generation counter introduced for §3.13 therefore guarded the continuation but not the other per-attempt state. The same hole existed in `onCancel` (`:170-183`), where `webSession?.cancel()` and both nils ran *before* the generation check.
- **Why:** This is pre-existing, not a regression — the unguarded read predates §3.13's fix, and §3.13 left it in place. The window is the *common* ordering, not a rare race: attempt A presents its sheet, the view tears down and A's task is cancelled, so `onCancel` cancels the session, frees A's slot and resumes A. The session's own completion was already in flight out of process and lands *after* that. The user taps sign in again; B claims the slot and its sheet is up; A's stale `.canceledLogin` then resumes B's continuation, so B dies with a bogus `.cancelled` and the user is told the sign-in was cancelled when they never cancelled it. Because `webSession` was also nil'd, the service can no longer cancel a presented session. The mirror case in `onCancel` — a late cancel for an attempt whose continuation was already resumed — cancels B's presented sheet and nils B's `activeAttempt`, which makes B's real callback bail at `guard let material` and park B's continuation, reproducing the original §3.3 `.alreadyInProgress`-forever symptom. The window was previously unexercised because the test fake never delivered a completion on `cancel()`, so the stale callback could not be produced at all.
- **Action:** Done. The `generation` is captured in the `sessionFactory` closure and passed into `finishAuthentication(callbackURL:error:generation:)`, which early-returns unless `pendingSignIn?.generation == generation`; the `webSession`/`activeAttempt` clearing moved inside that guard, so a superseded callback touches nothing. `onCancel` moves its `webSession?.cancel()` and both nils behind the same `pending.generation == generation` check. Covered by `staleSessionCallbackIsAppliedToNoOne`, which captures A's completion before cancelling A, then delivers it after B has claimed the slot and asserts B is undisturbed and still completes.
- **Severity:** High
- **Status:** FIXED (PR pending)
- **Confidence:** High — verified by reverting only the `finishAuthentication` guard: `staleSessionCallbackIsAppliedToNoOne` failed on `service.pendingContinuationForTesting` and `service.hasWebSessionForTesting` (B's slot and session were destroyed by A's callback) and then on B never authenticating, without hanging.

---

## 4. API modernity

### 4.1 `ObservableObject` throughout, on an iOS 18 target
- **Location:** `PWUsageApp.swift:13`, `:18`, `:33`, `:66-82`; `DashboardCoordinator.swift:111-129`; `MobileAuthService.swift:18`, `:45`; `LoadProfileStore.swift:5`, `:29-30`; `LoadTimingView.swift:212`, `:216`, `:225`; `DashboardView.swift:4`; `BillView.swift:4`; `SolarForecastSettingsSheet.swift:4`; `LoadProfilesSheet.swift:4`
- **What:** All four observable types use the Combine-backed `ObservableObject` pattern rather than the `@Observable` macro available since iOS 17.
- **Why:** The main modernization gap. It drags `import Combine` into `PWUsageApp.swift` solely for `AnyCancellable`, routes every update through a full `objectWillChange` invalidation instead of per-property tracking, and is what forces the sink-plus-Task pattern in `installAuthorizedSites`.
- **Action:** Migrate the four types to `@Observable` (with `@ObservationIgnored` where views should not observe), replace `@StateObject`/`@ObservedObject` with `@State`/`@Environment`, and replace the Combine pipeline with a direct callback or `AsyncStream`.
- **Severity:** Medium
- **Status:** OPEN
- **Confidence:** High

### 4.2 `async` declared on synchronous operations
- **Location:** `PWUsageAPI.swift:20`, `:91-97`; `SolarForecastStore.swift:65`, `:172-186`; `SolcastCredentialStore.swift:5-9`, `:40-134`
- **What:** `clearSiteAuthCookie()` has no suspension point; `activateAccountScope` is declared `async` but implemented synchronously in an actor; the four `SolcastCredentialKeychain` requirements are `async throws` but implemented synchronously.
- **Why:** No functional bug, but it forces `await` at call sites that cannot suspend, and it hides that the synchronous `SecItem*` calls run on the actor's cooperative executor rather than a dedicated queue.
- **Action:** Declare the synchronous members as synchronous; if the intent is to keep Keychain I/O off the cooperative pool, move the bodies to a dedicated serial executor.
- **Severity:** Low
- **Status:** OPEN
- **Confidence:** High

### 4.3 `async let` children interleave three dependent main-actor mutations
- **Location:** `PWUsage/State/DashboardCoordinator.swift:318-324`, `:329-333`
- **What:** `billRefresh`, `refreshResult`, and `contextResult` are launched concurrently; `billRefresh` publishes `bill.response`/`billSuccessGeneration` while `contextResult` mutates `planningContextCache`, and the parent then reads both.
- **Why:** Not a data race (all main-actor), but `billSucceeded` at `:329` is derived from a generation counter incremented by a concurrently running task, so the result depends on where the suspension points land. The "wait for live before asking for the bill" ordering is expressed in `refreshAll` but not here.
- **Action:** Derive `billSucceeded` from actual response state, or express the ordering structurally.
- **Severity:** Medium
- **Status:** OPEN
- **Confidence:** Medium

### 4.4 `@unchecked Sendable` on a stateless URLSession delegate
- **Location:** `PWUsage/Networking/SolcastClient.swift:27-31`
- **What:** `RedirectRejectingDelegate` opts out of `Sendable` checking.
- **Why:** The class holds no mutable state and its method is a pure function of its arguments, so the escape hatch is unnecessary. It is the only `@unchecked Sendable` in the app, which makes it a pattern others may copy.
- **Action:** Keep the conformance but document why it is sound (stateless delegate; `delegateQueue: nil` so URLSession supplies a serial queue).
- **Severity:** Low
- **Status:** OPEN
- **Confidence:** High

### 4.5 Duplicate UIKit scene traversal from both `.task` and `.onAppear`
- **Location:** `PWUsage/PWUsageApp.swift:333-344`
- **What:** `configureWindowSizeRestrictions()` and `model.scenePhaseChanged(...)` are both invoked from `.task` and again from `.onAppear` immediately after.
- **Why:** Two full passes over `UIApplication.shared.connectedScenes` per appearance. `scenePhaseChanged` is idempotent today, so the impact is wasted work — but this becomes a double-timer the moment either call stops being idempotent.
- **Action:** Keep the work in one place (`.task` is sufficient).
- **Severity:** Low
- **Status:** OPEN
- **Confidence:** High

### 4.6 Deprecation sweep — no findings
No `NavigationView`, no single-parameter `onChange(of:perform:)` (all seven sites use the iOS 17 two-parameter form), no `.animation(_:value:)`, no deprecated `Timer`/`Timer.publish` (the app uses a `Task.sleep` loop, which is the correct modernization), no deprecated `.cornerRadius`/`.foregroundColor`/`.navigationBarLeading`/`onReceive` in the view layer, no `AnyCancellable` publisher work outside `PWUsageAppModel`, and `isMainActorDefaultIsolation` is unset so `@MainActor` is explicit throughout. Formatters use `DateFormatter`/`NumberFormatter` rather than the modern `FormatStyle` — that is the remaining modernity gap and is filed in §7.2.

**Severity:** None (negative result, recorded so the sweep is not repeated)

---

## 5. Bugs / logic errors

### 5.1 Cost figures are marginal deltas, presented as the cost of a run
- **Location:** `PWUsage/Models/LoadTimingForecastEstimator.swift:472-480` (the `total` accumulation; the per-interval `loadedCost - baselineCost` delta at `:477`); `PWUsage/Views/LoadTimingForecastPresentation.swift:135` and `:138` (the two cost literals), `:153` (the `savings` figure)
- **What:** At the time of the finding, `score()` returned `total` as `Σ (cost(withLoad) − cost(baseBalances))` — the **incremental** cost of adding the load on top of the projected household baseline — and the presentation rendered it as `"Start now: \(money(comparison.costNow))"` and `"Start at HH:MM: \(money(comparison.recommendedCost))"`, which read as the absolute cost of running the load. That rendering is gone; the two literals at `:135` and `:138` now say "adds … to your projected bill". The estimator half of this finding still stands as written.
- **Why:** For a 36 kWh Level 2 car charge the true cost can be an order of magnitude larger than the delta shown, so the user is shown a number that is not the cost of the thing they are about to do. The `savings` figure *is* correct (a difference of two deltas), which made the mislabel easy to miss. **Superseded in part by the corrections below:** the premise that the number shown is wrong does not hold — only the label was.
- **Action:** ~~Present the delta with explicit wording ("adds about $X to your projected bill"), or compute and store the absolute loaded cost alongside the delta and display that.~~ **Done, first option only.** Both figures now render as `"Start now — adds $X to your projected bill"` / `"Start at HH:MM — adds $X to your projected bill"`, and `Comparison.costNow` / `Comparison.recommendedCost` carry doc comments recording that both are marginal against the projected household baseline, so a future reader assuming "total" is corrected at the source. **The second option was considered and rejected:** adding an `absoluteCost` field would hide the one fact the marginal figure exists to convey — that a run served by stored surplus is already paid for. The estimator maths is unchanged.
- **Severity:** High → **overstated; demoted to Low on fix.** The maths is correct and the defect is purely a label, so the "wrong number shown to the user" claim in **Why** does not hold.
- **Status:** FIXED (PR pending)
- **Confidence:** High — at the time of the finding, verified that the estimator computed `loadedCost - baselineCost` and that the presentation labelled the result "Start now: $X". Re-verified at fix time: the delta is still computed as `loadedCost - baselineCost` (`:477`), and the two cost literals are now at `:135`/`:138` and carry the corrected wording. Tests in `LoadTimingForecastPresentationTests` pin the new copy and would fail if it were reverted.
- **Correction 1 of 2 — the estimator maths is correct, and is unchanged.** `score()` returning `Σ (cost(withLoad) − cost(baseline))` is the right answer to "what will running this cost me?": when the load is served by stored surplus the delta approaches zero, and zero is the *right* answer, because that energy was already paid for. The defect is the **label, not the number** — `"Start now: $5.40"` read as the absolute cost of the run. The "order of magnitude larger" figure in **What**/**Why** is the absolute cost of the energy, which the user did not ask about and which is not the decision they are making.
- **Correction 2 of 2 — the severity was overstated.** A reader comparing this fix against the original finding should expect them to disagree on severity and on what the defect is: filed as **High** on the claim that the true cost could be an order of magnitude larger, it is a **Low** copy defect, because no number was ever wrong.

### 5.2 Pull-to-refresh can never recover a missing household profile
- **Location:** `PWUsage/State/DashboardCoordinator.swift:404-419` (the `loadPlanningContext == nil` branch of `refreshSolarForecast(manual:)`), `:566-573` (`loadTimingDetailRefreshed`) — re-derived after the fix
- **What:** `refreshSolarForecast(manual:)` included `loadPlanningContext != nil` in its success guard and never re-issued a `load-planning-context` fetch. `loadTimingDetailRefreshed()` routes to it whenever `solarForecastConnection != .notConnected`, and only fell through to `loadTimingDetailAppeared()` (which *does* fetch the context) when the connection was `.notConnected`.
- **Why:** If the planning context failed once — transient network, `contextInvalid`, or an out-of-date server that was later redeployed — the user could pull to refresh forever and never get it back. The only escape is disconnecting and reconnecting the Solcast credential. The note shown is `causeNote(nil)` ("Pull down to refresh it"), which sends the user into exactly that loop. This path also never set `solarForecastUnavailableReason`, discarding the `serverOutdated`/`contextInvalid` diagnosis computed elsewhere.
- **Action:** When `loadPlanningContext == nil` in the manual refresh path, fall through to `loadTimingDetailAppeared()` instead of returning a forecast-only failure, and preserve `solarForecastUnavailableReason`. Implemented at `:404-419`: the manual branch now awaits `loadTimingDetailAppeared()` and returns, so the context refetch happens inside `refreshSolarForecast` rather than only for a `.notConnected` credential.
- **Severity:** High
- **Status:** FIXED (PR pending)
- **Confidence:** High — verified at finding time by reading the pre-fix `:379` and `:523-530`; the numbers above are the amended code, re-derived against this tree.

### 5.3 "Bill at most every 30 minutes" is bypassed on every Load-timing appearance
- **Location:** `PWUsage/State/DashboardCoordinator.swift:341` (the appearance-driven bill refresh), `:566-573` (`loadTimingDetailRefreshed`), `:256` (`selectSite`'s `loadTimingDetailAppeared()` task); `PWUsage/Views/LoadTimingView.swift:411-415`; `PWUsage/Views/SolarForecastSettingsSheet.swift:250` — re-derived after the fix
- **What:** `loadTimingDetailAppeared()` unconditionally ran `async let billRefresh: Void = refreshBill(force: true)`. It is invoked from a `.task` on view appearance (`LoadTimingView.swift:411`), from an `onChange(of: coordinator.isForeground)` at `:412-415`, from `selectSite` (`DashboardCoordinator.swift:256`), and after every array-selection save (`SolarForecastSettingsSheet.swift:250`).
- **Why:** The README states the bill is requested "at most every 30 minutes while the app is foregrounded". For any user with a Solcast key connected, every foreground transition, site switch, and settings save issues a forced bill request, bypassing the `billInterval` cadence check. This is an unbudgeted cost on a database-heavy TOU rollup, and it is invisible because the UI looks like a normal refresh.
- **Action:** Make `loadTimingDetailAppeared` respect cadence — `refreshBill(trigger: .screenAppearance)` and rely on `isDue(lastAttempt:interval:at:)`, reserving the bypassing trigger for explicit user gestures (`.refreshable`). **The View menu's "Refresh" (⌘R) is *not* such a gesture**: `PWUsageApp.swift:82-88` calls `coordinator.refreshDue()`, which routes to `refreshAll(trigger: .scheduled)` (`DashboardCoordinator.swift:260-262`), so ⌘R has never bypassed the cadence and is not one of the `force: true` sites this finding was about. Note that the fix also widened this path's bill-freshness tolerance from *required a new success* to *under five minutes old* (`:351-357`): once the appearance-driven refresh is floored, a bill fetched moments earlier by an earlier appearance, a site switch, or a pull produces no new success, and requiring one would drop the enhancement every time the screen is reopened inside the floor. The wider tolerance is what makes §5.2's recovery observable — a success at T followed by an appearance at T+299s is suppressed by `isDue`, leaves `billSuccessGeneration` unchanged, is reported fresh by `billIsFresh`, and the enhancement still proceeds. It is not a fresh bill in the strict sense, but the bill is computed from live data that may itself be five minutes old, so the tolerance adds no meaningful staleness.
- **Severity:** High
- **Status:** FIXED (PR pending)
- **Confidence:** High — verified at finding time at the pre-fix `:319` and `:357-362`; re-derived to `:341` and `:351-357` in this tree, where the call is `refreshBill(trigger: .screenAppearance)` rather than `force: true`.

### 5.4 Battery SoC freshness is enforced only server-side
- **Location:** `PWUsage/Models/MobileContracts.swift:21` (`let stateOfCharge: Double?`), `:81` (`Sources.stateOfChargeAt`), `:98-101` (the decode), `:115-121` (`validatedStateOfCharge`); `PWUsage/Views/DashboardView.swift:71-101`; `PWUsage/Views/DashboardPresentation.swift:209-215` — re-derived after the fix
- **What:** At the time of the finding `stateOfCharge` was decoded as a bare `Double?` with no range, finiteness, or age check, and `DashboardView:71` rendered it directly. The only client-side gate was `chargeAgeLabel` at `DashboardPresentation.swift:209-215`, which merely adds an **orange caption** at >20 minutes — it does not suppress the value. `sources.stateOfChargeAt` was decoded but never consulted to decide whether to show the percentage.
- **Why:** The README's "values older than two hours remain unknown (`--`)" is entirely a property of `buildMobileDashboardContract` on the server. Any drift there — a stale contract version, a proxy, a cached response — silently produces a stale percentage presented as current, which is exactly what the README says must never happen. This is the load-bearing battery-provenance invariant from `DesignDecisions.md`, defended in only one of two places.
- **Action:** Independently suppress `stateOfCharge` to `nil` on the client when `sources.stateOfChargeAt` is missing or older than two hours, mirroring the server rule.
- **Severity:** High
- **Status:** FIXED (PR pending)
- **Confidence:** High — verified at finding time that the decode was bare, that `DashboardView:71` rendered unconditionally, and that `:209-215` only added a caption. The line numbers above are the amended code, re-derived against this tree.
- **Fix:** Enforced in `MobileLiveResponse.init(from:)` (`MobileContracts.swift:98-101`) rather than in the view, so every consumer inherits it. `stateOfCharge` is suppressed to `nil` when `sources.stateOfChargeAt` is absent, when the reading is stamped in the future (negative age — a device or server clock behind the other), or when the age exceeds `MobileLiveResponse.stateOfChargeMaximumAge` (two hours); the rule itself is `validatedStateOfCharge` at `:115-121`. The clock is injected via `MobileContractDecoder.make(now:)`, which defaults to `{ Date() }` so the four existing `PWUsageAPI` call sites compile unchanged, and travels to `init(from:)` in `decoder.userInfo`. Suppression is deliberately one-directional: a dropped timestamp shows `--` rather than a reading the client cannot vouch for. No view change was needed — `DashboardView.swift:71` already renders `nil` as `--`, and the caption at `:90` is already gated on `live.stateOfCharge != nil`. **The `--` and the caption are honest; the glyph beside them is not.** See §8.18.

### 5.5 A persist failure after a *successful* Solcast fetch deletes a valid API key
- **Location:** `PWUsage/State/SolarForecastStore.swift:425`, `:434-437`, `:442-476`
- **What:** In `performRefresh`, the cache is written and then `try await persist()` at `:425` throws. That falls into the generic `catch` at `:434`, which calls `persistFailureState`; if persisting again fails there, `quarantineCredential` at `:461-465` deletes the Keychain item.
- **Why:** The only fault is a disk/write failure, not a bad credential or a bad response, yet the user's working Solcast API key is destroyed and they must re-enter it. The `failedScopes` quarantine semantics are meant for unusable data, not for "the filesystem said no".
- **Action:** Distinguish persistence failure from request failure: on a persist failure, keep the in-memory cache, mark the scope failed, and surface a distinct "could not save" state — without deleting the Keychain item.
- **Severity:** Medium
- **Status:** OPEN
- **Confidence:** High — verified `:425` → `:434` → `:442-476`.

### 5.6 Two Solcast arrays with different interval boundaries void the whole forecast
- **Location:** `PWUsage/Models/SolarForecast.swift:209-211`
- **What:** `SolarForecast.combine` requires `Set(points.keys) == expectedKeys` — an exact match of the interval key sets of the selected arrays.
- **Why:** Two arrays on the same account are not guaranteed to return byte-identical interval sets, and a single difference (a day-boundary offset, a different horizon length) throws `incompleteCoverage` and produces *nothing*. The failure surfaces as "An array returned no usable forecast" rather than as a partial forecast from the arrays that did line up.
- **Action:** Align arrays onto the union of their interval boundaries (bucketing and re-weighting each array's kW onto a common grid) rather than requiring identical key sets.
- **Severity:** Medium
- **Status:** OPEN
- **Confidence:** Medium — the exact-match requirement is verified; the frequency of key divergence is inferred from Solcast's API contract, not observed.

### 5.7 All cadence and staleness decisions trust the device clock
- **Location:** `PWUsage/State/DashboardCoordinator.swift:586-589`; `PWUsage/Views/LoadTimingForecastPresentation.swift:96`; `PWUsage/Models/LoadTimingRecommendation.swift:133-139`
- **What:** `isDue`, the forecast-freshness gate, and `LoadTimingRecommendation.isFresh` all subtract a server timestamp from a device `Date()` with no skew allowance.
- **Why:** A user who moves the clock backward causes `date.timeIntervalSince(lastAttempt) >= interval` to be false for an unbounded period, so the 5-minute live poll and 30-minute bill poll **stop entirely** with no error and no UI indication. In the other direction the negative-age checks in `isFresh` and `overlay` correctly reject, but the presentation path at `:96` has no `>= 0` guard, so a backwards clock makes any age look fresh.
- **Action:** Add a bounded skew allowance, treat a negative age as stale rather than fresh in the forecast overlay gate, and anchor cadence to `ContinuousClock` rather than `Date`.
- **Severity:** Medium
- **Status:** OPEN
- **Confidence:** High

### 5.8 `asOf` staleness for the planning context allows only 5 minutes of negative skew
- **Location:** `PWUsage/Models/MobileContracts.swift:185-186`; `PWUsage/State/DashboardCoordinator.swift:463`
- **What:** `MobileLoadPlanningContextResponse.validating` requires `now.timeIntervalSince(asOf)` to be within `[-300s, 24h]`.
- **Why:** A device more than five minutes fast rejects every server response as `contextInvalid`, permanently — and the cached re-validation at `:463` re-rejects the same bad entry on every read rather than refetching. The message shown ("The server sent household data this app could not read. Please report this") points at the wrong component.
- **Action:** Widen the negative-skew allowance to match the live contract's tolerance, and on repeated `contextInvalid` evict the cache entry and refetch once.
- **Severity:** Low
- **Status:** OPEN
- **Confidence:** Medium

### 5.9 `stateOfCharge` is decoded without range or finiteness validation
- **Location:** `PWUsage/Models/MobileContracts.swift:21`, `:98-101`, `:115-121`; `PWUsage/Views/DashboardView.swift:306-319` (`batterySymbol`) — re-derived after the fix
- **What:** At the time of the finding `stateOfCharge` was a bare `Double?` with no validation, and `batterySymbol` mapped anything `>= 88` to the `100percent` glyph.
- **Why:** The server validates the range, so this only manifests under contract drift — but the client would render "150%" and a full-battery glyph from a malformed response. `MobileLoadPlanningContextResponse` *does* validate its numerics, so the live DTO is the inconsistent one.
- **Action:** Validate range and finiteness of `stateOfCharge` and the four live power values during decode, mapping out-of-range to unknown.
- **Severity:** Low
- **Status:** FIXED (PR pending)
- **Confidence:** Medium
- **Fix:** `stateOfCharge` is validated during decode for finiteness and the inclusive 0–100 range, mapping failures to `nil` (`MobileContracts.swift:115-121`). The four live power values are checked for **finiteness only** (`MobileLiveResponse.Live.finiteOrZero`, non-finite → `0`) — no range check, because negative grid and battery readings are legitimate and both `batterySymbol` and `batteryDirection` handle zero cleanly. `150` therefore decodes to `nil`, so the label renders `--` instead of "150%". **It does not fix the glyph.** An earlier revision of this bullet claimed it resolved "a 150% label *and* a full-battery glyph"; that was an overclaim, and it is withdrawn. `batterySymbol`'s `else` branch (`DashboardView.swift:315-316`) picks `100percent` for *any* `nil` charge, not just an out-of-range one, so a malformed response, an undated reading, and a genuinely-full battery all draw the same full glyph. Filed as §8.18. Note also that the **finiteness** half is defence-in-depth against a non-JSON source and is unreachable from the wire: `JSONDecoder` rejects `1e400`/`1e999` as "not representable in Swift", and `NaN`/`Infinity` are not valid JSON, so only the 0–100 range check has real test coverage (`MobileContractsTests` exercises `finiteOrZero` directly and says so in a comment).

### 5.10 Errors swallowed or replaced with generic copy
- **Location:** `PWUsage/Views/LoadProfilesSheet.swift:63-71` (delete dialog action), `:84-92` (reset dialog action), `:109-114` (select), `:176-178` (save `catch`), `:183-189` (`message(for:)`); `PWUsage/Models/LoadProfile.swift:35-55` (`LoadProfileError.errorDescription`); `PWUsageTests/LoadProfileStoreTests.swift:157-168`
- **What:** `try?` discarded delete/reset/select failures entirely, and the save `catch` threw away the underlying error in favour of "Enter valid profile settings and try again."
- **Why:** A persistence failure is reported to the user as a validation problem, sending them to edit values that were already fine. A failed deletion was worse: it cleared `pendingDeletion`, closing the confirmation dialog while leaving the row in the list with no explanation at all.
- **Action:** Let the thrown errors surface in `validationMessage`; reserve `try?` for genuinely ignorable failures.
- **Severity:** Medium
- **Status:** FIXED (PR pending)
- **Confidence:** High
- **Fix:** All four call sites now use `do`/`catch` and write the caught error into `validationMessage`. `pendingDeletion` / `pendingReset` are cleared **only on success**, so a failed delete or reset leaves its confirmation dialog presented while the alert explains why nothing changed. `LoadProfileError` gained `LocalizedError` conformance with an `errorDescription` per case, and the sheet's `message(for:)` helper reads it (falling back to the old generic string for any non-`LoadProfileError`), so a newly added case explains itself instead of falling through. No view-test coverage was added — the store's throwing contract is already asserted in `LoadProfileStoreTests`, and the new user-facing strings are covered directly. The alert title is now "Couldn’t update load profiles" rather than "Couldn’t save profile", since delete/reset/select failures now share it.
- **Device check still owed.** The whole user-visible value of this fix rests on one unverified SwiftUI behaviour: the `.alert` at `LoadProfilesSheet.swift:95-102` is attached to the **same view chain** as the two `.confirmationDialog`s at `:55-75` and `:76-94`, so on a failure the alert has to present *over* a dialog that is deliberately still open. SwiftUI does not reliably stack an alert over an open `confirmationDialog` on the same view — the alert may be dropped, may replace the dialog, or may present behind it. That is not derivable from source and was **not** verified: the app gates every screen behind a real sign-in and no credentials were available in this environment, so no simulator check was possible. A device check would confirm that a failed delete leaves the delete dialog up with a readable explanation of why nothing changed, and the same for reset, on **both** iPhone and iPad if the presentation differs between the two (popover vs. sheet presentation is a plausible source of divergence). The `Log in` requirement is the same one that blocked §7.7's check.

### 5.11 Silent fallback to the production origin on configuration failure
- **Location:** `PWUsage/PWUsageApp.swift:24-46` (`init`, the former `(try? …) ?? (try! …)`); `PWUsage/Configuration/AppConfiguration.swift:5` (`defaultAPIOrigin`), `:65-82` (`fromBundle`) — re-derived after the fix
- **What:** `(try? AppConfiguration.fromBundle()) ?? (try! AppConfiguration())` swallowed any failure and substituted the production default. `fromBundle()` fell back to `defaultAPIOrigin` when `PWUSAGE_API_ORIGIN` was unset, and threw when it was set to something invalid.
- **Why:** In a Debug build an invalid origin silently produced a connection to **production** rather than beta — exactly the confusion `README.md:26` warns about. The failure was invisible: no log, no UI indication.
- **Action:** Done. The silent substitution is gone: `PWUsageApp.init` switches on the resolution instead of `??`-ing a default, and builds no client at all in the refusing case. `fromBundle` gained injectable `environment`/`isDebug` parameters and now logs a bad origin in **both** configurations (`AppConfiguration.swift:78`); Debug falls back to `debugFallbackAPIOrigin` (beta, never production) and records an `initializationError` on the configuration, Release rethrows. A Release refusal renders a `pwusage can't start` screen (via the existing `EmptyStateScreen`) instead of trapping or connecting. `PWUSAGE_API_ORIGIN` unset still resolves to production, which is correct: production is the Release host and is allowlisted.
- **Severity:** Medium
- **Status:** FIXED (PR pending)
- **Confidence:** High — the `try!` itself never could trap, because `AppConfiguration()` with the default origin always passes `validate`; the defect was the silent fallback, not the force-try. See §12.

---

## 6. Security

The security posture is genuinely strong and was verified end-to-end: PKCE/state/attempt are 32 random bytes from `SystemRandomNumberGenerator`; the callback is parsed against a strict allowlist (no user/password/port/fragment, duplicate and empty parameters rejected, `state` compared before anything else); the Solcast key uses `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` with `kSecAttrSynchronizable: false`; the state file is written atomically with `FileProtectionType.complete` and excluded from backup; `SolcastClient` uses an ephemeral session, no cookie storage, `reloadIgnoringLocalCacheData`, a redirect-rejecting delegate, and a post-response assertion that the final URL is still `https://api.solcast.com.au`; there are no ATS exceptions, no custom trust evaluation, and no `UIBackgroundModes`.

**On logging — this claim has changed since the audit.** At the time of the audit there were **zero** `print`/`debugPrint`/`os_log`/`Logger`/`NSLog` calls in the app. There are now exactly two `Logger` call sites, both added deliberately by §5.11 so that a bad API origin is no longer swallowed silently: `AppConfiguration.swift:21` (`logger.error` for an unusable `PWUSAGE_API_ORIGIN`, in both configurations) and `PWUsageApp.swift:49` (`.error` when a Release build refuses to launch). There are still **no** `print`, `debugPrint`, `os_log`, or `NSLog` calls anywhere in `PWUsage/`, and nothing logged carries a credential, an origin the user typed beyond the config value, or a user identifier. The findings below are the remaining gaps.

### 5.12 `try!` in test static initializers turns a fixture bug into a whole-process crash

> **Why this number sits here.** §5.12 is numbered in the §5 series — it was filed as part of the bug pass — but it is filed under **§6. Security** because that is where it was appended when the audit was written, and the no-renumbering rule at the top of this file forbids moving it to where the numbering would suggest. The number is stable for the same reason every other one is: PR descriptions and this branch's commits cite it. Read it as "the fifth series of bugs", filed in the security section.

- **Location:** `PWUsageTests/PWUsageAppModelTests.swift:271` (a `static let` fixture) and `:371` (inside `resumeLiveRequests()`); `PWUsageTests/MobileAuthServiceTests.swift:437` (inside `makeService`); `PWUsageTests/DashboardCoordinatorTests.swift:528` and `:533` (the `liveResponse`/`billResponse` fixture helpers) — re-derived against this tree
- **What:** Five `try!` sites, across four test helpers, build a fixture inside a `static let` initializer or a shared `makeService`/fixture helper. Any thrown error — a validation rejection, a decode failure — is an assertion failure, not a failing test.
- **Why:** The failure is scoped to the whole test binary rather than to the one test that caused it, and the diagnostics are unreadable. Observed concretely while fixing §6.2: an intermediate revision put the Release host allowlist inside `validate`, which rejected the `https://pwusage.test` fixtures, and each rejection became `_assertionFailure` → `SIGTRAP`. The result was 26 `PWUsage-*.ips` crash reports in `~/Library/Logs/DiagnosticReports`, roughly four seconds apart as each suite retried, and no test-level failure message pointing at the cause. A reader would have seen repeated process deaths rather than "these five fixtures use a host a Release build may not name".
- **Action:** Replace the `try!` sites with a throwing fixture helper, or build the fixture lazily inside each test so a bad payload fails one test. Do not reach for `fatalError` — the point is to contain the failure. Found while fixing §6.2; deliberately left out of that change to keep it reviewable.
- **Severity:** Medium
- **Status:** OPEN
- **Confidence:** High — reproduced; the 26 crash reports listed above came from exactly this mechanism.

### 6.1 `DEVELOPMENT_TEAM` is committed to `project.yml`, contradicting the README
- **Location:** `cmd/ios-app/project.yml:47` (the `CODE_SIGN_STYLE: Automatic` line the removed team ID sat beside; `DEVELOPMENT_TEAM` itself was at `:48` before the fix) and `:63` (the test target's equivalent signing block); `cmd/ios-app/README.md:16`, `:19`
- **What:** `DEVELOPMENT_TEAM: 6HQGHHRK87` was hardcoded in the committed XcodeGen spec. `project.yml` is git-tracked (confirmed via `git ls-files --error-unmatch project.yml`). `README.md:16` states "The project has no signing team configured" and `README.md:19` says "set `DEVELOPMENT_TEAM` in your local shell (do not commit it)".
- **Why:** Made a teammate's fork attempt a signed build against someone else's team, and the README and the spec actively disagreed, so a reader following the README would have been surprised.
- **Action:** Done. The `DEVELOPMENT_TEAM` line is removed from the committed spec, so the README is now accurate: there is no signing team configured and a local device build supplies it as the README describes. `CODE_SIGN_STYLE: Automatic` is unchanged. Verified safe for CI — `.github/workflows/ios.yml` runs `./run-tests.sh`, whose `xcodebuild` invocation sets `CODE_SIGNING_ALLOWED=NO` and names no team. The regenerated `PWUsage.xcodeproj` contains no `DEVELOPMENT_TEAM`; it is gitignored, so the removal only takes effect after `./generate.sh`.
- **Scope of this finding, recorded explicitly.** The remediation is about the **build configuration**, not about the string existing nowhere: the team ID is not a secret (it is an Apple Developer account identifier, and the `project.yml` blob carrying it is in git history regardless), and the two occurrences that remain — this entry and the one in §12's verified-lines list, plus the instruction in `docs/superpowers/plans/2026-09-29-ios-audit-high-findings.md` that named the line to delete — are the **record of what was removed**. Redacting them would destroy the only statement of what the defect was and where it lived, making the fix unverifiable, in exchange against a value that is already public. A whole-branch review asked whether the "leaks the signing team identity" rationale was only half-remediated; this bullet is the answer: the part that matters (no team in the committed build config) is done, and the part that does not matter was deliberately left legible. Git history was not rewritten.
- **Severity:** High
- **Status:** FIXED (PR pending)
- **Confidence:** High

### 6.2 Release origin validation accepts any HTTPS host, with no production allowlist
- **Location:** `PWUsage/Configuration/AppConfiguration.swift:96-115` (`validate`), `:19` (`releasedAPIOriginHosts`), `:65-82` (`fromBundle`) — re-derived after the fix
- **What:** `validate` checked scheme, non-empty host, no userinfo, empty path, no query, no fragment, and HTTPS-in-Release — but never constrained the **host**. Whatever `PWUSAGE_API_ORIGIN` resolved to was accepted.
- **Why:** The current `project.yml` Release value is correct, so this was not a live bug, but the safety property was much weaker than "Release requires HTTPS" reads. A build-configuration slip that leaves the Debug beta URL in Release — or points at any other host — shipped silently, and the `site_auth` session cookie is scoped to whatever origin the app talks to, so this was the one place where a wrong-server failure is quiet rather than loud.
- **Action:** Done, and the check is in `validate` itself rather than in one caller, so it cannot be bypassed by forgetting an argument. `isRelease: true` (the default for every public initializer) now implies the host must be an entry in `releasedAPIOriginHosts` (`pwusage.fm.rodeo`); Release therefore accepts `https://pwusage.fm.rodeo` and **rejects** `https://pwusagebeta.fm.rodeo`, and per §5.11 a rejected Release origin rethrows so the app refuses to launch rather than falling back. Debug (`isRelease: false`) is deliberately unconstrained, so `http://localhost:5174` and any other local host still work. The only escape is `allowUnlistedHost: Bool = false`, an explicit opt-out that defaults to the safe state, so a caller that skips the check has to say so in its own source; it is used only by test fixtures that name the stub host `pwusage.test`, and it waives the host allowlist alone, not the HTTPS requirement. An earlier revision put the allowlist in `fromBundle` and gave the initializers `allowedHosts: Set<String>? = nil`; that failed closed nowhere — `nil` meant "no allowlist", so a future Release caller got no host check for free. The five stub-host fixtures are recorded in the same commit as a follow-up finding: their `try!` static initializers turn any validation error into a process-wide `SIGTRAP` rather than one failing test, which is how the earlier revision's crash storm surfaced. That `try!` problem is pre-existing and out of scope for this fix.
- **Severity:** High
- **Status:** FIXED (PR pending)
- **Confidence:** High

### 6.3 Untested destructive keychain path
- **Location:** `PWUsage/Authentication/SolcastCredentialStore.swift:8`, `:98-124`; `PWUsage/State/SolarForecastStore.swift:644-651`
- **What:** `SolcastCredentialKeychain.deleteAll(accountScopeID:)` is a prefix-matched bulk delete with no production caller — `signOut` uses the broader `deleteAllCredentials()` (`SolarForecastStore.swift:341`) instead. The protocol requirement is satisfied only by a test fake. Similarly, `DeviceSolarForecastPersistence.clearConnections()` is never called.
- **Why:** A bulk credential wipe that no test exercises and no caller can reach is untested destructive security-adjacent code, and `clearConnections` is a second, weaker path for erasing credentials.
- **Action:** Delete both, or add tests that exercise them before keeping them.
- **Severity:** Low
- **Status:** OPEN
- **Confidence:** High

---

## 7. Performance

### 7.1 The forecast estimator re-runs on the main actor up to twice per body, every minute
- **Location:** `PWUsage/Views/LoadTimingView.swift:243`, `:285-286`, `:307-320`, `:328-354`; `PWUsage/Models/LoadTimingForecastEstimator.swift:93`, `:350`, `:367`, `:376-398`, `:417`, `:446` (re-derived after the fix; the estimator was not changed, and the pre-fix references in this entry were stale)
- **What:** `forecastOverlay` called `LoadTimingForecastEstimator.evaluate` at `:243` and was invoked from both `recommendationCard` and `explorerCard`, each of which also made its own `placement(...)` call — up to two estimator runs per body evaluation. The entire subtree was wrapped in `TimelineView(.everyMinute)`, so it re-ran every minute regardless of state change. `evaluate` calls `integrationBoundaries` four times in fixed code paths (`:350`, `:367`, `:417`, `:446`) plus once per candidate, each running a per-minute scan loop over its window and building/sorting a `Set<Date>`.
- **Why:** With ~50-60 candidate starts over a horizon that can reach 48 hours, this is on the order of 10⁵ main-thread operations per body evaluation, every 60 seconds, for a result that only changes when the balance or forecast changes. The inner lookups (`forecast.first(where:)`, `tariffs.first(where:)`, `context.slots.filter`) are linear scans repeated per midpoint, compounding the cost. The pre-fix timeline also discarded `context.date` in favour of a fresh `Date()`.
- **Action:** Evaluate once per `(balance, forecast, context)` tuple and cache the `Result` on the coordinator; narrow the `TimelineView` to the freshness/source-status labels that genuinely show a moving clock and pass `context.date` in.
- **Resolution:** Resolved without a cache or any new stored state, per the agreed design decision: the duplication is gone and the tick no longer drives the estimator. `body` resolves `placement(...)` once (`:307`) and derives a single `overlay` from it (`:318`) — both **outside** any timeline — and passes them into `recommendationCard` (`:418`) and `explorerCard` (`:548`); neither card calls `forecastOverlay` or `placement` on the hot path any more, and the second independent `placement` call is gone.
- **The tick now reaches the verdict, deliberately.** A first pass narrowed the timeline to the freshness labels alone. Review caught the consequence: `LoadTimingRecommendation.isFresh` (`LoadTimingRecommendation.swift:43`, `:138`) and `sourceStatus` (`:205`) apply the same 60-minute window to the same `energyDataThrough`, so with the verdict frozen the screen could show `Stale · updated 60 min ago` directly above a still-confident `Good fit now` — the most user-visible claim on the screen was the one thing that stopped moving. The verdict is *cheap* (no horizon search), unlike the overlay, so it was put back on the tick: a `TimelineView(.everyMinute)` now wraps **only the two cards** (`:328-354`), re-running one estimator-free `LoadTimingRecommendation.evaluate` per tick and passing `context.date` into it. It contains no scroll view and computes no forecast, so §7.7 stays fixed and the estimator stays off the tick. Per-minute cost drops from *2 × forecast evaluate + 2 × recommendation* to *1 × recommendation*.
- **The frozen overlay is guarded against mis-attribution.** Because the overlay is computed at body-pass time and the tick's recommendation is not, the two can disagree about which load the forecast describes — at the freshness boundary `.ready` → `.stale` the suggested profile changes, and an unguarded frozen overlay would be shown against a different profile's estimate. Each card therefore re-derives `placement` (cheap: it selects a profile and never estimates) via `currentPlacement(for:)` (`:478`) and shows the forecast only while that equals the `forecastPlacement` the overlay was computed for (`:432`, `:557`). `Placement` is `Equatable`, so an unchanged verdict keeps the forecast on screen and a changed one **withholds** it until the next body pass recomputes one that fits. A stale forecast is never shown against the wrong load.
- **Residual divergence, recorded rather than hidden:** the forecast overlay's *own* figures — cost now, recommended cost, savings, window, solar contribution, horizon, and source ages — are still computed at body-pass time and do **not** advance with the tick. They refresh when `body` re-evaluates (coordinator state, profiles, or exploration change). This is the accepted cost of the no-cache decision: the estimator's horizon start is a function of the clock, and freezing it is a behaviour change nobody asked for. The guard above bounds the blast radius to "the forecast section is absent for one tick" rather than "the forecast describes the wrong load".
- **Accessibility, verified against the pre-fix source.** The discarded `context.date` is gone: the old `_ in let now = Date()` no longer exists, the label uses its timeline's `context.date` (`:759-763`), and the cards use their own timeline's `context.date`. A review claimed the extracted label had silently dropped a `"Source freshness: …"` prefix from the metadata footer. That claim was checked against `587af15` and is **incorrect**: `git show 587af15:…LoadTimingView.swift` contains exactly one `"Source freshness: …"` `.accessibilityLabel`, at `:416` inside `recommendationCard`; the footer's `Text` at `:651` never had one. The `announcesFreshness` flag therefore preserves each call site's pre-fix VoiceOver output exactly — the card announces the prefix, the footer does not — and its comment now says so instead of claiming to avoid a nesting hazard. Whether wrapping a child in a `TimelineView` changes what `.accessibilityElement(children: .combine)` announces is **not answerable from this repository's source**; it is a SwiftUI implementation detail, and a device check is required to confirm (see §7.7).
- **Severity:** High
- **Status:** FIXED (PR pending)
- **Confidence:** High — for the code change. The minute-tick behaviour and the accessibility output are unverified on a device: the app gates every screen behind a real sign-in and no credentials were available, so no simulator check was possible.

### 7.2 `DateFormatter`/`NumberFormatter`/`ISO8601DateFormatter` allocated per call, including on the decode path
- **Location:** `PWUsage/Views/DashboardPresentation.swift:83-90`, `:166-176`, `:178-185`, `:217-224`; `PWUsage/Models/LoadTimingForecastEstimator.swift:230-237`; `PWUsage/Networking/SolcastClient.swift:99-105`; `PWUsage/Models/MobileContracts.swift:331-339`; `PWUsage/Models/SolarForecast.swift:113-123`; `PWUsage/Views/BillView.swift:83`, `:92`, `:105`
- **What:** Each helper constructs a fresh formatter on every invocation.
- **Why:** Formatter construction is among the most expensive Foundation operations, and these are on hot paths. `ISO8601DateFormatter.parse` is invoked **once per timestamp** by the custom date-decoding strategy, so a response with a few hundred timestamps allocates hundreds of formatters before a single view renders. `BillView` recomputes period title, balance, and currency for every row's accessibility label; `LoadTimingView` used to evaluate the same `sourceStatus(...)` call twice (status text plus accessibility label), though that one duplicate call was removed as a side effect of the §7.1 restructure, which extracted the label into a view that formats once.
- **Action:** Adopt `FormatStyle` (`Date.FormatStyle` / `FloatingPointFormatStyle`) — allocation-free, and the codebase already uses `.formatted(.number...)` elsewhere — or cache formatters keyed by locale/currency/timezone. Hold shared `static let` ISO-8601 formatters for the decode path, and share one timestamp parser between `MobileContracts` and `SolarForecast`.
- **Severity:** Medium
- **Status:** OPEN
- **Confidence:** High

### 7.3 `LoadProfileStore` is constructed — and writes to `UserDefaults` — from a view's `init`
- **Location:** `PWUsage/Views/LoadTimingView.swift:216`, `:222-227`; `PWUsage/State/LoadProfileStore.swift:34-46`
- **What:** `LoadTimingView.init` evaluates `LoadProfileStore()` eagerly as the `StateObject` argument; that initializer reads `UserDefaults`, JSON-decodes the saved collection, then unconditionally calls `persist()`.
- **Why:** `StateObject` discards every instance after the first, so each re-initialization of the view still pays a synchronous `UserDefaults` read, a JSON decode, and a `UserDefaults` **write** on the main actor. That is side-effecting I/O in `init`, which makes view construction non-idempotent. Previews also wipe shared defaults domains as a side effect of merely rendering (`DashboardPreviews.swift:156-168`, `SolarForecastPreviews.swift:176-199`).
- **Action:** Construct the store once outside the view and pass it in; persist on first mutation rather than in `init`.
- **Severity:** Medium
- **Status:** OPEN
- **Confidence:** High

### 7.4 Duplicate validation and summary formatting across the profile UI
- **Location:** `PWUsage/State/LoadProfileStore.swift:170-189` vs `PWUsage/Views/LoadProfilesSheet.swift:195-203`; `PWUsage/Views/LoadProfilesSheet.swift:169-183` vs `PWUsage/Views/LoadTimingView.swift:39-53`; `PWUsage/Views/LoadTimingView.swift:139-144` vs `PWUsage/Models/LoadTimingRecommendation.swift:57-59`
- **What:** The same capacity/SOC/duration rules are implemented in the store's private `validate` *and* in the sheet's `ProfileDraft.isValid`; the same chip title and accessibility label are produced by `LoadProfilesSheet.profileSummary`/`profileAccessibilitySummary` *and* by `LoadTimingPresentation.profileChipTitle`/`profileChipAccessibilityLabel`; `observedBalances` is built twice.
- **Why:** Two validators that must agree will drift — the Save button can enable itself for a profile the store then rejects, producing the generic "Enter valid profile settings and try again" alert. Two summary formatters can show different numbers for the same profile in the sheet and on the Load timing card.
- **Action:** Make the store's validation the single source; move the chip summary functions into one shared presentation type.
- **Severity:** Medium
- **Status:** OPEN
- **Confidence:** High

### 7.5 `URLSession` instances are created per Solcast refresh and never invalidated
- **Location:** `PWUsage/Networking/SolcastClient.swift:52-56`, `:27-31`; `PWUsage/State/SolarForecastStore.swift:234`, `:411`
- **What:** Every `SolcastClient` builds a fresh ephemeral `URLSession` with its own `RedirectRejectingDelegate`; the store creates a client per `discoverSites` and per `performRefresh`. There is no `finishTasksAndInvalidate` anywhere.
- **Why:** A `URLSession` retains its delegate until invalidated, so each session is a leaked resource until GC pressure reclaims it. With the daily budget capped at ten attempts the absolute growth is small but unbounded across the app's lifetime.
- **Action:** Hold one long-lived session per timeout value in the store and reuse it, or invalidate on completion.
- **Severity:** Low
- **Status:** OPEN
- **Confidence:** Medium

### 7.6 The estimator's `assumptions` are computed, tested, and never shown
- **Location:** `PWUsage/Models/LoadTimingForecastEstimator.swift:50`, `:221-226`; `PWUsageTests/LoadTimingForecastEstimatorTests.swift:442-443`; `PWUsage/Views/LoadTimingForecastPresentation.swift:105-106`
- **What:** The estimator produces four carefully worded assumption lines, and the UI independently hardcodes a different, shorter disclaimer instead of rendering them.
- **Why:** A test asserts on copy the app never displays, so the guarantee "the estimate states its assumptions" is not enforced for the user, and the two texts can drift silently.
- **Action:** Have `LoadTimingForecastPresentation` render `comparison.assumptions`, or delete the field and its test.
- **Severity:** Medium
- **Status:** OPEN
- **Confidence:** High

### 7.7 `refreshable` is attached inside a `TimelineView` that rebuilds its content every minute
- **Location:** `PWUsage/Views/LoadTimingView.swift:285-416` (`var body` through the closing brace) — re-derived after the fix
- **What:** The `ScrollView` and its `.refreshable` modifier lived inside `TimelineView(.everyMinute)`, which discarded and rebuilt the content closure on every tick.
- **Why:** Pull-to-refresh state lives on the scroll view, which is re-created each minute, so the refresh control's spinner/offset is reset on an unrelated schedule. I could not verify the exact SwiftUI behaviour; the layering is at minimum fragile and makes the minute tick the dominant invalidation path for the whole screen.
- **Action:** Keep `ScrollView` + `.refreshable` outside the `TimelineView` — which is the same restructuring §7.1 calls for.
- **Resolution:** Resolved as a side effect of the §7.1 restructure, not by a dedicated change to this finding. `LoadTimingView.body` is now a plain `ScrollView` (`:286`) with `.refreshable` attached to it directly (`:382`); the screen-wide `TimelineView(.everyMinute)` that used to wrap both is gone. Two timelines remain in the file, and **neither contains a scroll view**: one wraps only the two load cards (`:328-354`) to re-derive the cheap verdict each minute, and one lives inside `LoadTimingFreshnessLabel` (`:747-763`) for the freshness caption. What is verified here is the layering, by construction and by reading the resulting view tree. The specific interaction claim above remains **unverified**: no device check was possible, because the app gates every screen behind a real sign-in and no credentials were available in this environment.
- **Device check still owed**, and it would need to confirm: (a) pull-to-refresh shows its spinner and completes without a minute tick resetting it; (b) the freshness caption updates roughly once a minute and the verdict beside it flips in the same tick; (c) with VoiceOver on, the metadata footer is announced as one combined element whose freshness portion is the bare status text with no `"Source freshness: …"` prefix, and the recommendation card's caption *is* announced with that prefix — this is the check that would confirm the extracted label preserves the pre-fix tree, since whether a `TimelineView` child is transparent to `.combine` is not derivable from source; (d) VoiceOver focus is not thrown when the tick redraws a timeline nested inside a combined accessibility element.
- **Severity:** Medium
- **Status:** FIXED (PR pending)
- **Confidence:** Medium — the layering is confirmed by construction and by reading the resulting view tree; the SwiftUI interaction (the pull-to-refresh and VoiceOver claims above) is unverified on a device, for the reason given in the device-check bullet.

---

## 8. SwiftUI / UI

### 8.1 Accessibility labels assembled by string surgery on formatted output
- **Location:** `PWUsage/Views/DashboardPresentation.swift:124-132`; `PWUsage/Views/DashboardView.swift:370`, `:98-101`; `PWUsage/Views/LoadTimingView.swift:974`
- **What:** `loadRateAccessibilityLabel` formats a localized cents string, then deletes the `"¢/kWh"` substring to reuse it as speech, and pluralizes by comparing the result to the literal `"1"`.
- **Why:** In any locale with non-ASCII digits (Arabic-Indic) the `replacingOccurrences` no-ops and the `"1"` comparison never matches, so "1 cent" reads as "1 cents" and the unit is announced twice. With a grouping separator the stripped string is not a bare number at all.
- **Action:** Build the spoken string from the numeric values directly, never by editing a display-formatted string; use automatic grammar agreement for "cent/percents".
- **Severity:** Medium
- **Status:** OPEN
- **Confidence:** High — verified `:127` and `:129`.

### 8.2 Fixed point-size fonts break Dynamic Type
- **Location:** `PWUsage/Views/LoadTimingView.swift:952` (9pt "ACTIVE" badge); `PWUsage/Views/DashboardView.swift:78` (44pt battery glyph); `PWUsage/Views/SignInView.swift:16` (48pt logo); `PWUsage/PWUsageApp.swift:378`
- **What:** The tariff badge uses `.system(size: 9, weight: .bold)`; the decorative glyphs use 42-48pt fixed sizes.
- **Why:** The 9pt badge does not scale at all and is illegible for many users including at default text sizes. The decorative glyphs ignore accessibility sizes (though they are `accessibilityHidden`, so the impact is visual only).
- **Action:** Use relative text styles (`.caption2.weight(.bold)`) for the badge; `@ScaledMetric` or relative styles for the glyphs.
- **Severity:** Medium
- **Status:** OPEN
- **Confidence:** High

### 8.3 Third array toggle is silently rejected with feedback the user cannot see
- **Location:** `PWUsage/Views/SolarForecastSettingsSheet.swift:76-87`, `:168-184`
- **What:** `selectionBinding`'s setter refuses a third selection and writes "Select at most two arrays." into `statusMessage`, which renders in the "Connection" section ~40 lines above the toggle.
- **Why:** The tap appears to do nothing; the explanation is off-screen in a section the user has likely scrolled past, so the array list looks broken.
- **Action:** Disable or visually mark the remaining `Toggle`s once two are selected, and/or surface the message adjacent to the list.
- **Severity:** Medium
- **Status:** OPEN
- **Confidence:** High — verified `:168-184` and the `:76-87` call site.

### 8.4 Destructive dialog's button label ignores the profile it targets
- **Location:** `PWUsage/Views/LoadProfilesSheet.swift:55-71`
- **What:** The dialog title interpolates the profile name ("Delete Cedar Dryer?") but the destructive button is the fixed string "Delete Custom Load".
- **Why:** A user with several custom loads sees a generic button that does not name what will be removed — exactly the ambiguity a destructive confirmation exists to remove. The reset dialog at `:73-90` has the same shape but its button ("Reset to Defaults") is generic by nature, so the asymmetry only reads oddly for delete.
- **Action:** Build the button title from the pending profile so title and action agree.
- **Severity:** Low
- **Status:** OPEN
- **Confidence:** High — verified `:63-64`.

### 8.5 Staleness thresholds scattered as twelve-plus magic numbers, one reimplemented inline
- **Location:** `PWUsage/Views/DashboardView.swift:222` (inline `> 30 * 60`), `:127`, `:219`; `LoadTimingForecastEstimator.swift:6`; `MobileContracts.swift:185`; `DashboardPresentation.swift:187`, `:205`, `:212`; `LoadTimingView.swift:205`; `LoadTimingRecommendation.swift:43`; `LoadTimingForecastPresentation.swift:81`, `:162`; `SolarForecastStore.swift:81`; `DashboardCoordinator.swift:115`
- **What:** Twelve-plus independently written staleness thresholds across eight files, with `DashboardView:222` hand-duplicating a rule `DashboardPresentation.freshness(staleAfter:)` already encapsulates.
- **Why:** These are the load-bearing values the `Agents.md` freshness rules depend on, and a change to any one is not discoverable from any single place. The inline copy at `:222` is the most likely to be missed.
- **Action:** Define named constants (or a `DataFreshness` enum with named windows) and pass them to `freshness(staleAfter:)`; delete the inline recomputation at `:222`.
- **Severity:** Medium
- **Status:** OPEN
- **Confidence:** High

### 8.6 Freshness is derived two ways, by post-hoc string surgery on the display string
- **Location:** `PWUsage/Views/DashboardPresentation.swift:199`; `PWUsage/Views/DashboardView.swift:168`, `:219`
- **What:** `freshness` returns `"Stale · updated X ago"` or `"Updated X ago"`, and three call sites strip the `"Updated "` prefix to build a subtitle — reimplementing the distinction the function already made.
- **Why:** Fragile string coupling: rewording the freshness string silently breaks all three subtitles with no compile error, producing a double-prefixed or empty result.
- **Action:** Have `freshness` return a small struct (`isStale` + age text) and let callers compose the prefix.
- **Severity:** Medium
- **Status:** OPEN
- **Confidence:** High

### 8.7 Color chosen by string prefix
- **Location:** `PWUsage/Views/DashboardView.swift:251`
- **What:** The balance text is tinted green based on `balance.hasPrefix("Surplus")` — a test applied to an already-formatted display string.
- **Why:** Color is the only differentiator, and it depends on presentation-layer formatting staying in sync. It also ignores `accessibilityDifferentiateWithoutColor`.
- **Action:** Return a signed numeric balance alongside its label from `DashboardPresentation`, switch on the number, and add a glyph or text cue so the distinction survives without color.
- **Severity:** Medium
- **Status:** OPEN
- **Confidence:** High

### 8.8 `AnyView` used for a two-branch layout decision
- **Location:** `PWUsage/Views/DashboardView.swift:283-293`; `PWUsage/Views/LoadTimingView.swift:732-738`
- **What:** `adaptiveGrid` returns `AnyView` from both branches of an accessibility-size check.
- **Why:** `AnyView` erases the concrete type, defeating SwiftUI's structural diffing and view identity for a container that re-renders on every tick of the Load Timing timeline (§7.1).
- **Action:** Make the grid its own `View` and switch between `VStack` and `LazyVGrid` inside its `body`, or use a single `ViewThatFits`.
- **Severity:** Medium
- **Status:** OPEN
- **Confidence:** High

### 8.9 Index- and string-identified `ForEach`
- **Location:** `PWUsage/Views/DashboardView.swift:286`, `:290`; `PWUsage/Views/LoadTimingView.swift:530`, `:734`, `:736`, `:894`; `PWUsage/Views/BillView.swift:80`
- **What:** `ForEach(tiles.indices, id: \.self)` and `ForEach(Array(...enumerated()), id: \.offset)` identify rows by position; `ForEach(enhanced.sourceAges, id: \.self)` identifies `String`s by value.
- **Why:** Positional identity makes SwiftUI reuse the wrong tile when the underlying list changes length or order (the period grid and the bill period list), losing animations and briefly showing mismatched content.
- **Action:** Make the tile and row types `Identifiable` with a stable key and iterate the arrays directly.
- **Severity:** Medium
- **Status:** OPEN
- **Confidence:** High

### 8.10 Legacy C-style and hand-rolled number formatting
- **Location:** `PWUsage/Views/DashboardPresentation.swift:50`, `:65`, `:175`, `:184`
- **What:** `String(format: "%.1f kW", ...)` and `String(format: "%.1f kWh", ...)` use locale-insensitive Foundation formatting.
- **Why:** Decimal separators do not follow the user's locale. The rest of the codebase already uses `.formatted(.number.precision(...))`.
- **Action:** Use `.formatted(.number.precision(.fractionLength(1)))` consistently.
- **Severity:** Medium
- **Status:** OPEN
- **Confidence:** High

### 8.11 Hand-rolled empty and loading states instead of `ContentUnavailableView`
- **Location:** `PWUsage/Views/DashboardView.swift:117-121`, `:128-129`, `:160-162`, `:388-417`; `PWUsage/Views/BillView.swift:21-32`; `PWUsage/Views/LoadTimingView.swift:368-376`, `:577-581`, `:606-610`; `PWUsage/PWUsageApp.swift:286-294`, `:368-389`
- **What:** Six bespoke "symbol + title + message" stacks, plus three bespoke `ProgressView` + text cards, stand in for empty and loading states.
- **Why:** `ContentUnavailableView` gets correct VoiceOver semantics, Dynamic Type behavior, and Reduce Motion handling for free; the hand-rolled ones do none of that consistently, and the copies drift apart.
- **Action:** Replace the empty states with `ContentUnavailableView` and extract a single shared loading placeholder.
- **Severity:** Medium
- **Status:** OPEN
- **Confidence:** High

### 8.12 Hand-rolled `Binding(get:set:)` for dialogs and pickers
- **Location:** `PWUsage/Views/LoadProfilesSheet.swift:57-60`, `:74-77`, `:87-90`, `:321-339`, `:492-495`, `:520-523`; `PWUsage/Views/SolarForecastSettingsSheet.swift:168-184`
- **What:** Six custom bindings, three of which exist only to convert an optional item into an `isPresented` flag.
- **Why:** The picker binding's `get` returns a fallback ID while `set` writes an explicit ID, so picking the already-defaulted profile makes the view think the user diverged from the suggestion.
- **Action:** Drive dialogs from a `Bool` plus a separate pending item, or use `confirmationDialog(item:)`; replace the picker binding with a `String` selection state normalized on change.
- **Severity:** Medium
- **Status:** OPEN
- **Confidence:** High

### 8.13 Sheet and coordinator work triggered by `onChange` instead of `task(id:)`
- **Location:** `PWUsage/Views/SolarForecastSettingsSheet.swift:29`, `:103`, `:108`; `PWUsage/Views/LoadTimingView.swift:405-415`
- **What:** Forecast settings call `solarForecastSettingsDidEdit()` from three `onChange` handlers; Load Timing duplicates a `.task` load with an `onChange(of: coordinator.isForeground)` that spawns a raw `Task`.
- **Why:** The `onChange` handlers also fire on programmatic writes (the sheet clears `apiKey` at `:226` and rewrites the manual ID fields at `:194-195`), so they notify the coordinator for changes the user did not make. The duplicated foreground `Task` bypasses the structured cancellation the `.task` provides. Both of the coordinator methods they call are empty (§9.4), so the net effect today is a wasted invalidation.
- **Action:** Move the edit notification to a `.task(id:)` keyed on the value; express the foreground reload with a single `.task(id: coordinator.isForeground)`.
- **Severity:** Medium
- **Status:** OPEN
- **Confidence:** High

### 8.14 Values clipped by `lineLimit` + `minimumScaleFactor`
- **Location:** `PWUsage/Views/DashboardView.swift:354-359`; `PWUsage/Views/LoadTimingView.swift:956-960`; `PWUsage/Views/BillView.swift:57-61`
- **What:** Numeric values are pinned to one line and shrunk as low as 0.75×.
- **Why:** At larger Dynamic Type sizes the currency/rate digits become progressively smaller rather than wrapping, so the app counteracts the user's chosen text size — a direct contrast with §8.2, where fonts are too small at default sizes.
- **Action:** Allow two lines (`lineLimit(2, reservesSpace:)`) and drop the aggressive scale factor, or switch to a `LabeledContent` layout that stacks at accessibility sizes.
- **Severity:** Low
- **Status:** OPEN
- **Confidence:** High

### 8.15 `accessibilityAddTraits(.updatesFrequently)` misused on a static error
- **Location:** `PWUsage/Views/SignInView.swift:30-36`
- **What:** The sign-in error message is given `.updatesFrequently`, a trait meant for frequently changing content such as timers.
- **Why:** It makes VoiceOver re-announce a static error and misleads users about whether the text is live.
- **Action:** Drop the trait; consider moving the message to an `.alert` so it is announced once.
- **Severity:** Low
- **Status:** OPEN
- **Confidence:** High

### 8.16 `.hoverEffect()` on a phone-first app
- **Location:** `PWUsage/Views/DashboardView.swift:200`, `:277`; `PWUsage/Views/SignInView.swift:49`; `PWUsage/Views/SitePickerView.swift:32`
- **What:** `hoverEffect()` is applied to rows and buttons.
- **Why:** A no-op on iPhone; only fires for pointer input on iPad.
- **Action:** Remove, or keep only if iPad pointer feedback is an explicit design goal.
- **Severity:** Low
- **Status:** OPEN
- **Confidence:** High

### 8.17 Preview gaps
- **Location:** `PWUsage/Views/DashboardPreviews.swift:181-258`; `PWUsage/Views/SolarForecastPreviews.swift:212-244`
- **What:** Previews cover the dashboard, bill, sign-in, and load timing well (including accessibility size variants), but there is none for `LoadRunDetailsSheet`, `SolarForecastSettingsSheet`, `SitePickerView`, or the car-charge section of `ProfileEditorSheet`.
- **Why:** Those sheets contain the most conditional layout in the app and the only non-`List` form, and they are never visually checked. The README also notes previews "were not visually inspected in this run because the Mac UI session was locked."
- **Action:** Add previews for those views, at least one at an accessibility text size.
- **Severity:** Low
- **Status:** OPEN
- **Confidence:** High

### 8.18 An unknown battery charge renders `--` beside a full-battery glyph
- **Location:** `PWUsage/Views/DashboardView.swift:306-319` (`batterySymbol`), `:315-316` (the `else` branch), `:71` (the numeric text), `:75` (the accessibility label), `:77` (the glyph), `:107` (the Battery `MetricTile` symbol, same function)
- **What:** `batterySymbol(_:stateOfCharge:)` switches on `Int(stateOfCharge.rounded())` when the charge is non-`nil`, but its `else` branch — the `nil` case — sets `level = "100percent"`. So when `stateOfCharge` is `nil` the dashboard shows the text `--` (`DashboardView.swift:71`) with the accessibility label "Battery charge unknown" (`:75`), and immediately beside it draws a **full** battery (`:77`). The same function supplies the Battery tile's symbol at `:107`, so the full glyph appears twice.
- **Why:** The screen contradicts itself in the one place it must not: the text and the VoiceOver label say "we know nothing", the glyph says "100%". The default reads as deliberate for a *discharging* battery whose charge is unknown — a plausible design choice for the icon — but that is a different proposition from "we have no reading at all", and the `nil` branch cannot distinguish the two. **This branch made it much more common.** Before §5.4, `stateOfCharge == nil` was reachable only when the server omitted or sent an unreadable field. §5.4 deliberately made it reachable in two further cases (an undated reading, and a reading stamped in the future), because `AGENTS.md` forbids presenting an unvouchable SoC as fresh. §5.9 added a third (out of range). So a previously rare path is now the outcome for every battery on a device whose clock is skewed, whose server omitted `stateOfChargeAt`, or whose contract has drifted — and the user sees a full battery the whole time. §5.4 and §5.9 are both correct fixes to the *number*; neither one reached the *glyph*, and §5.9's `Fix` bullet briefly claimed otherwise (corrected in place).
- **Action:** Decide what an unknown charge should show, then make `batterySymbol` honour it. This is deliberately **not** filed as a one-line fix, because the decision is a product one: the options are meaningfully different (a neutral `battery.0percent` / question-mark glyph; an outline glyph with no fill; keeping the current full glyph for the discharging case and introducing a second, distinct one for "no reading"; or suppressing the icon entirely when the charge is unknown and showing only `--`). Whichever is chosen, `batterySymbol` needs the distinction passed in as an input, because `nil` alone cannot carry it. To make it testable at all, `batterySymbol` has to move off the view: it is a `private func` on `DashboardView` (`:306`), while its sibling `batteryDirection` already lives on `DashboardPresentation` (`DashboardPresentation.swift:19`) and is directly unit-tested — so the fix is to relocate the symbol mapping there and assert against it, rather than duplicating the switch in a test. The outcome is a rendered glyph, so pair it with a device check.
- **Severity:** Medium — user-visible, but not a data-integrity or safety defect. It shows an icon that is wrong rather than a number that is wrong, and the honest `--` and the honest VoiceOver label are both already on screen, so a sighted user is misinformed rather than left with nothing. It is **not** Low because the contradiction is immediate and unavoidable once the path is taken, and because this branch measurably widened the path: the same branch that §5.4 records as a High-severity fix deliberately funnels two new classes of reading into `nil`, so the icon is now wrong far more often than it was. It is **not** High because nothing downstream of the display consumes the glyph, the numeric and spoken output are correct, and no stale value is being presented as a value.
- **Status:** OPEN
- **Confidence:** Medium — the code path is **confirmed by reading it**: `DashboardView.swift:315-316` is an unconditional `else { level = "100percent" }`, `:71` and `:75` are the `nil`-rendering text and label, and `:77`/`:107` both call the same function. What is **not** verified is the *visual* result: no snapshot test, no preview, and no device or simulator run was available for this finding (the app gates every screen behind a real sign-in and no credentials were available), so the rendered glyph and its spacing beside the `--` are described from the source, not observed on screen.

---

## 9. Dead code / duplication / refactor

### 9.1 Dead estimator API kept alive only by tests (~100 production LOC)
- **Location:** `PWUsage/Models/LoadTimingEstimator.swift:147-173` (`Verdict`, `Pricing`, `Cost`, `Profile`), `:175-178` (`profiles`), `:180-186` (`carChargeKwh`), `:188-192` (`chargeTargetPercent`), `:195-199` (`carHeadroomKwh`), `:201-204` (`boundedInput`), `:206-208` (`shouldEstimateCarCharge`), `:210-236` (`costToRun`), `:238-241`, `:243-245`
- **What:** A superseded "headroom/verdict" design. Grepping all of `PWUsage/` shows no reference to any of it — the live surface is only `carChargeEstimate`, `estimateStartNow`, and the `StartNow*` result types.
- **Why:** Readers assume these are live, and the associated ~90 lines of `LoadTimingEstimatorTests.swift:165-252` give a false sense of coverage of code the app never runs.
- **Action:** Delete the cluster and its tests, or move it to a clearly-marked experimental file.
- **Severity:** Medium
- **Status:** OPEN
- **Confidence:** High

### 9.2 `LoadTimingAffordance` is a whole production file with no production caller
- **Location:** `PWUsage/Models/LoadTimingAffordance.swift:1-24`
- **What:** A 24-line type whose `evaluate` merely forwards to `LoadTimingEstimator.estimateStartNow`; nothing in `PWUsage/` references it, and the app reaches that function directly via `LoadTimingRecommendation.evaluate` (`LoadTimingRecommendation.swift:71`). The only caller is `LoadTimingViewTests.swift:105-106`.
- **Why:** Two names for one operation invites drift, and the type reads as the app's canonical "one profile's result" wrapper when it is not.
- **Action:** Delete the file and the two test call sites, or adopt the type in the recommendation path.
- **Severity:** Medium
- **Status:** OPEN
- **Confidence:** High

### 9.3 `lastErrorDescription` is written in eleven places and never read by any view
- **Location:** `PWUsage/State/SolarForecastStore.swift:100` (assigned at `:154`, `:310`, `:317`, `:338`, `:364`, `:375`, `:383`, `:424`, `:444`, `:450`, `:453`)
- **What:** The property is `private(set)` on an actor, so assignment triggers no SwiftUI update either. The only readers are the unit tests.
- **Why:** The most specific diagnostics the store produces — including the storage-failure and quarantine messages, which are exactly what §5.5 needs — can never reach the user. The UI is driven entirely by the coarser `SolarForecastUnavailableCause` enum, so several failure modes present generic text.
- **Action:** Surface it on the coordinator so the settings sheet can show it, or fold the distinct messages into `SolarForecastUnavailableCause`.
- **Severity:** Medium
- **Status:** OPEN
- **Confidence:** High

### 9.4 Empty coordinator methods called from view bodies as if they did something
- **Location:** `PWUsage/State/DashboardCoordinator.swift:447-448`; called at `SolarForecastSettingsSheet.swift:29`, `:103`, `:108`, `:181` and `LoadTimingView.swift:406`
- **What:** Both `solarForecastSettingsDidEdit()` and `loadProfileDidEdit()` have empty bodies. Calling a method on an `ObservableObject` does not emit `objectWillChange`, so all six call sites have no effect whatsoever.
- **Why:** Reads as "we invalidate the cached forecast when the key changes" when nothing is invalidated. The `onChange` in `LoadTimingView` exists solely to call one, costing a view invalidation on every profile edit.
- **Action:** Delete both methods and their call sites, or give them the invalidation the comment at `:446` implies.
- **Severity:** Medium
- **Status:** OPEN
- **Confidence:** High

### 9.5 Dead coordinator state written on every response but never read
- **Location:** `PWUsage/State/DashboardCoordinator.swift:98` (`lastSuccess`), `:100` (`unavailableStatusCode`) — written at `:599`, `:601`, `:616`, `:618`, reset at `:105-107`
- **What:** Two `DashboardEndpointState` fields are populated on every live and bill response and on every failure, but no view, presentation type, or coordinator method reads them. Only `DashboardCoordinatorTests.swift:139-184` does.
- **Why:** The tests are asserting on an implementation detail rather than behaviour. `unavailableStatusCode` in particular would genuinely improve the availability banner by distinguishing "server returned 503" from "no network".
- **Action:** Surface the status code in the banner, or delete both fields and the assertions that only exist to cover them.
- **Severity:** Medium
- **Status:** OPEN
- **Confidence:** High

### 9.6 Preview-only code in the release target, and a test target that depends on Debug-only sources
- **Location:** `PWUsage/Views/LoadProfilesSheet.swift:350-367`; `PWUsageTests/PreviewFixtureTests.swift:12`, `:26`, `:58-60`, `:78`, `:92-95`
- **What:** Two large `#Preview` blocks with no `#if DEBUG` guard sit in a file compiled into the shipping target (contrast `DashboardPreviews.swift:1` and `SolarForecastPreviews.swift:1`, which are correctly guarded). The committed test file references `DashboardPreviewAPI`, `PreviewPlanningAPI`, and `PreviewForecastStore`, which only exist under `#if DEBUG`.
- **Why:** Preview fixture data (a `UserDefaults` suite name, "Workshop heater"/"Garden pump" profiles) is compiled into the release binary, and `xcodebuild test -configuration Release` will fail to build the entire test target.
- **Action:** Move the `LoadProfilesSheet` previews into a `#if DEBUG`-guarded file alongside the other two; consider moving the preview doubles into a shared test-support target.
- **Severity:** Medium
- **Status:** OPEN
- **Confidence:** High

### 9.7 Solar forecast state file has no schema version
- **Location:** `PWUsage/State/SolarForecastStore.swift:31-37`, `:617-642`; contrast `LoadProfileStore.swift:135`, `:143`, `:192`
- **What:** `SolarForecastPersistedState` carries no `version` field, unlike `LoadProfileStore`, which versions its payload with `schemaVersion` and discards on mismatch.
- **Why:** Any future change to `SolarForecastCredential`, `SolarForecastBatch`, or `SolarForecastBudget` makes `loadState` throw, `loadIfNeeded` fails for every call, and the entire Solcast feature silently stops working with no migration path and no user-visible reason — the `try?` at `:166`, `:189`, `:206`, `:276` swallows the cause.
- **Action:** Add a `version` field and either migrate or discard-and-reconnect explicitly on mismatch, mirroring `LoadProfileStore.loadCollection`.
- **Severity:** Medium
- **Status:** OPEN
- **Confidence:** High

### 9.8 `SolarForecastStore.swift` is a 660-line actor covering five responsibilities
- **Location:** `PWUsage/State/SolarForecastStore.swift:78-603`, plus `:607-652` (`DeviceSolarForecastPersistence`) and `:654-660` (`SolarForecastStoreSessionCleanup`)
- **What:** One actor owns keychain access, on-disk JSON persistence, request budgeting, Solcast network calls, and user-facing failure classification, and the file mixes an actor, a second actor, and a `@MainActor` struct.
- **Why:** `discoverSites` (`:212-256`) and `performRefresh` (`:387-440`) each repeat the same five-step sequence of generation check → budget reserve → persist → re-check generation → catch-and-classify, so any change to the safety protocol must be made twice.
- **Action:** Split out the persistence actor and the session-cleanup adapter, and factor the repeated sequence into one private helper.
- **Severity:** Medium
- **Status:** OPEN
- **Confidence:** High

### 9.9 `LoadTimingView.swift` is an 877-line file mixing four concerns
- **Location:** `PWUsage/Views/LoadTimingView.swift:3-209` (a 200-line `LoadTimingPresentation` enum of pure string-building), `:211-739` (the main view), `:747-792` (`LoadTimingFreshnessLabel` and its announcement modifier), `:805-935` (`LoadRunDetailsSheet`), `:937-976` (`LoadTimingPeriodTile`), `:978-1002` (`LoadTimingCard`)
- **What:** Presentation logic, the main screen, a detail sheet, a tile, and a card container all live in one file.
- **Why:** The 200-line enum is the most-tested unit in the repo (`LoadTimingViewTests.swift` is 1018 lines) yet is invisible from the filename — which is why the test file is named for a View it never touches.
- **Action:** Extract each into its own file; rename the test file to match.
- **Severity:** Medium
- **Status:** OPEN
- **Confidence:** High

### 9.10 Three near-identical titled card container views
- **Location:** `PWUsage/Views/DashboardView.swift:331-339` (`StatusCard`); `PWUsage/Views/BillView.swift:133-148` (`BillInformationCard`); `PWUsage/Views/LoadTimingView.swift:978-1002` (`LoadTimingCard`)
- **What:** Three private generics each wrap content in a titled `Label` header plus a padded, corner-rounded `secondarySystemGroupedBackground` rectangle, with padding 16/17/17 and corner radius 22/20/20.
- **Why:** Three subtly different copies of the app's most-repeated visual pattern; the drift is already visible.
- **Action:** Promote one shared `CardContainer` and delete the other two.
- **Severity:** Medium
- **Status:** OPEN
- **Confidence:** High

### 9.11 Duplicated per-point validation and double processing in `SolarForecast.combine`
- **Location:** `PWUsage/Models/SolarForecast.swift:181-189` vs `:199-207`
- **What:** The identical ten-line finite/ordering/duplicate guard appears twice, and the first element of `selectedArrays` is fully validated and keyed at `:180-191` then walked again in the loop at `:195-208`.
- **Why:** The two copies must stay in sync or one array will be accepted that the other rejects. The redundant pass is wasted work on the refresh path.
- **Action:** Extract the guard-and-key into one private helper returning the keyed dictionary, and seed the loop from the first array's result.
- **Severity:** Medium
- **Status:** OPEN
- **Confidence:** High

### 9.12 `LoadTimingViewTests.swift` is named for a View it never touches
- **Location:** `PWUsageTests/LoadTimingViewTests.swift:1-1018` — suites `LoadTimingViewTests` (`:5-6`, testing `DashboardPresentation`/`LoadTimingPresentation`) and `LoadTimingForecastPresentationTests` (`:285-286`, testing `LoadTimingForecastPresentation`); no `View` type is instantiated
- **What:** A 1018-line file whose name implies view tests but which only exercises two static presentation enums, holding two independently-named suites.
- **Why:** `run-tests.sh` targets suites by name, so `./run-tests.sh LoadTimingViewTests` runs neither `LoadTimingForecastPresentationTests` nor anything view-related — the tool's documented workflow misleads here.
- **Action:** Split into `LoadTimingPresentationTests.swift` and `LoadTimingForecastPresentationTests.swift`, matching the source files.
- **Severity:** Low
- **Status:** OPEN
- **Confidence:** High

### 9.13 Test assertions depend on the device locale
- **Location:** `PWUsageTests/LoadTimingViewTests.swift:17-18` (`"12¢/kWh"`), `:41`, `:55-58` (`"48.5 cents per kilowatt-hour"`), `:190-192` (`"Estimated €1.00 more…"`); `PWUsageTests/DashboardPresentationTests.swift:59-61`
- **What:** Exact-equality assertions on strings produced through `NumberFormatter` with `Locale.current`, with no locale pinned.
- **Why:** These pass on a US-English simulator and fail on any simulator with a different region or currency format — a green local run can hide a red CI run. This is the same locale coupling as §8.1.
- **Action:** Pass an explicit `Locale(identifier:)` into the presentation calls under test (the parameter already exists on `currency` and `loadRate`) and assert against fixed-locale output.
- **Severity:** Low
- **Status:** OPEN
- **Confidence:** High

### 9.14 Three hand-rolled `MobileDashboardDataAPI` stubs and two auth fakes
- **Location:** `PWUsageTests/DashboardCoordinatorTests.swift:311` (`DashboardAPISpy`); `PWUsageTests/SolarForecastCoordinatorTests.swift:748` (`ForecastDashboardAPISpy`); `PWUsageTests/PWUsageAppModelTests.swift:202` (`ApplicationAPISpy`); plus `MobileAuthServiceTests.swift:307` and `SolarForecastStoreTests.swift:796`
- **What:** Three private spies implement the same two-method protocol independently; two fakes implement the three-method auth protocol independently; none are shared between files.
- **Why:** A protocol change requires three edits in three files, which is why the coordinator tests grew to 382 lines.
- **Action:** Extract one configurable test double per protocol into a `PWUsageTests/Support/` file.
- **Severity:** Low
- **Status:** OPEN
- **Confidence:** High

### 9.15 Stale doc comment on `maximumCarCapacityKwh`
- **Location:** `PWUsage/Models/LoadProfile.swift:22-23`; contrast `LoadTimingForecastEstimator.swift:108-120`
- **What:** The comment claims a Level 1 charge "fits inside the seven-day tariff timeline", but the estimator now bounds the horizon by `endOfTomorrow` and the billing cycle. The ad-hoc `250` ceiling at `LoadProfileStore.swift:149` also has no named constant beside the 200 kWh one.
- **Why:** The stale comment would mislead anyone reasoning about the 200 kWh cap.
- **Action:** Update the comment to describe the actual horizon bound; hoist the `250` ceiling to a named constant.
- **Severity:** Low
- **Status:** OPEN
- **Confidence:** High

---

## 10. Cross-cutting recommendations

1. **Centralize the freshness windows.** Twelve-plus magic numbers (§8.5) and three sites doing string surgery on a freshness string (§8.6) are the highest-leverage cleanup. A `DataFreshness` enum with named windows, passed into a structured-result `freshness(...)`, would fix §8.5, §8.6, and part of §8.7 at once.

2. **Take `FormatStyle` as the default.** It resolves §7.2 (per-call formatters), §8.10 (C-style formatting), and §8.1 (the currency-string surgery) together, and the codebase already uses `.formatted(.number...)` in places — it is an inconsistency, not an unknown technique.

3. **Cache anything expensive per-body, per-minute, or per-timestamp.** §7.1 (estimator), §7.2 (formatters), §7.3 (`UserDefaults` write in `init`). The `TimelineView(.everyMinute)` wrapper is the amplifier: it turns any body-time work into per-minute work.

4. **Make the load-bearing invariants client-enforced, not server-enforced.** The two-hour SoC rule (§5.4) and the origin allowlist (§6.2) are both defended in exactly one place. The SoC case is explicitly called out in `Agents.md` as a rule the app must never violate.

5. **Adopt `@Observable` when convenient, not as a sweep.** §4.1 is a Medium, not a High, and the four types are small. Migrate opportunistically rather than as a dedicated change.

6. **Delete the write-only state.** `lastErrorDescription` (§9.3), `lastSuccess`/`unavailableStatusCode` (§9.5), and the dead estimator cluster (§9.1) exist for tests, not for behavior. Some should be surfaced in the UI instead of deleted — but they should not stay in the middle state.

7. **Reconcile `project.yml` with the README.** §6.1 is a two-line fix and the README is currently wrong.

8. **Migrate to `swiftui-pro` and `swift-concurrency-pro` as living references.** The idioms they describe (structured `.task`, `@Observable`, `FormatStyle`, `ContentUnavailableView`, `ContinuousClock` for cadence) are the ones behind most of §4, §7, and §8.

---

## 11. What was NOT audited

- **Algorithmic correctness of the estimator's economics.** §5.1 confirms a *labelling* defect; whether the marginal-cost model itself (foregone export, surplus treatment, tariff-period cost accumulation) is economically right is a domain question requiring product sign-off, not a code audit.
- **Server-side behaviour.** `cmd/next-app/src/app/api/mobile/*` and `buildMobileDashboardContract` were read only to cross-check DTO field names and types (all matched, including `periodKey` identity and the `/api/site-live-data?view=mobile` route path). Server business logic, RLS, and the `load-planning-context` route itself were not reviewed.
- **The server half of the 5-minute balance-offset assumption** (§5.10-adjacent, at `LoadTimingForecastEstimator.swift:108-112`). The iOS side documents the assumption in a comment; whether the server's `getUsageByTOU` actually folds in the final five-minute sample is unverified. Listed here rather than as a finding because it cannot be settled from the iOS source.
- **Test coverage assessment.** A quick scan confirmed Swift Testing is used exclusively and identified duplication issues (§9.12-9.14), but no coverage analysis was performed.
- **Performance profiling.** §7 identifies potential hot paths; no Instruments traces were run. The §7.1 severity is based on arithmetic, not measurement.
- **Localization correctness.** Untranslated strings were not assessed.
- **Build settings, scheme configuration, Xcode project structure** beyond what is visible in `project.yml` and the generated `Info.plist`.
- **The `Observed` interval-count claim in the README** ("a recent last-known battery charge may be shown with its source age") was traced into code and matches §5.4, but real-device cookie renewal and logout checks remain release gates per the README and were not exercised.

---

## 12. Verification

Every High finding was re-verified by opening the cited lines. Four claims raised as Critical or High by the audit passes **did not survive** and were demoted or dropped:

> **Line numbers in this section are as of the audit, not as of `fix/ios-audit-high-findings`.** They describe the code the audit actually read, which is the point of a verification record — re-deriving them would mean asserting that pre-fix code still sits at those lines, which it does not. Where an entry's own `Location` has been corrected to the current tree, this list still shows what was read. For the *current* code, use each finding's `Location`.

- **DROPPED — "Household profile is applied at the wrong granularity across a DST spring-forward hour"** (`LoadTimingForecastEstimator.swift:378-386`). Claimed that the absolute 60-second scan misses half-hour boundaries in the skipped local hour. Opened `:378-386`: the scanner walks *absolute* time and tests `calendar.component(.minute, from: cursor)` in the site timezone. The instant at which local time jumps 01:59:59 → 03:00:00 *does* exist in absolute time and *does* have local minute 0, so a boundary is inserted. The comment at `:379-380` ("Scan minute boundaries so non-hour offsets and DST transitions are honored") is accurate. **The claim is wrong; dropped entirely.**
- **DEMOTED — "Force-try in the `App` initializer can crash at launch"** (`PWUsageApp.swift:16`). Opened `AppConfiguration.swift:8-11` and `:35-47`: the fallback `AppConfiguration()` uses `defaultAPIOrigin` (`:4`), which is `https` with an empty path and passes every `validate` check, so `try!` cannot trap. Reframed as §5.11, whose actual defect is the *silent production fallback*, not a crash.
- **DEMOTED — "Estimator's 5-minute balance offset is an undocumented assumption"** (`LoadTimingForecastEstimator.swift:108-112`). The comment at `:6-10` and `:109-110` explicitly documents the reasoning ("its timestamp marks that interval's start, so the cycle balance already includes the interval beginning at `balanceSourceTime`"). This is a documented, deliberate assumption, not an oversight. The unverifiable server half is listed in §11 instead.
- **DEMOTED — `LoadTimingView` `TimelineView`/`.refreshable` interaction** (§7.7). The layering is real and verified, but the specific interaction claim (spinner reset mid-gesture) is unverified SwiftUI behaviour. Confidence marked Medium; the restructuring it recommends is independently justified by §7.1.

Verified lines for each High finding:

- **§3.1** — `DashboardCoordinator.swift:212-215` (`authenticationInvalidated` sets only `forecastGeneration` and forecast state; does not touch `requiresSignIn` or `isForeground`); `:653-660` (timer loop guard `self.isForeground, !self.requiresSignIn`); `PWUsageApp.swift:181-196` (`signOut` sets `coordinator = nil` with no `scenePhaseChanged`); `grep -rn "deinit" PWUsage/` → no matches.
- **§3.2** — `PWUsageApp.swift:108-123` (`didBootstrap` latch set on entry, `catch` sets `.unavailable` only for errors escaping `bootstrap`); `:220-258` (`installAuthorizedSites` populates `sites` at `:221`, reaches `.signedIn` at `:257`).
- **§3.3** — `MobileAuthService.swift:114-140` (no `withTaskCancellationHandler`; `start() == false` branch resumes the local continuation at `:136` after storing it at `:117`; `[weak self]`-nil path resumes at `:123`); `:171-218` (`completeSignIn` at `:213-217` is idempotent but is not used by those two paths).
- **§5.1** — `LoadTimingForecastEstimator.swift:461-474` (`total = Σ(loadedCost - baselineCost)`); `LoadTimingForecastPresentation.swift:131-134` (`"Start now: \(money(comparison.costNow))"`), `:148-149` (`savings` is a difference of deltas — correct).
- **§5.2** — `DashboardCoordinator.swift:379` (`loadPlanningContext != nil` in the success guard; no context re-fetch in this function); `:523-530` (`loadTimingDetailRefreshed` routes to `refreshSolarForecast(manual: true)` unless `.notConnected`).
- **§5.3** — `DashboardCoordinator.swift:319` (`async let billRefresh: Void = refreshBill(force: true)`, unconditional), `:233` (`selectSite`), `:579` (cadence check bypassed); `LoadTimingView.swift:411` (`.task`), `:412-415` (`onChange` → `Task`).
- **§5.4** — `MobileContracts.swift:68` (`try container.decodeIfPresent(Double.self, forKey: .stateOfCharge)` — no validation), `:53` (`stateOfChargeAt` decoded), `:68` context; `DashboardView.swift:71` (renders unconditionally); `DashboardPresentation.swift:209-215` (`chargeAgeLabel` returns a caption string only).
- **§6.1** — `project.yml:48` (`DEVELOPMENT_TEAM: 6HQGHHRK87`); `git ls-files --error-unmatch project.yml` → tracked; `README.md:16` and `:19` (contradict it).
- **§6.2** — `AppConfiguration.swift:35-47` (`validate` checks scheme/host-emptiness/userinfo/path/query/fragment; never compares `components.host` against an allowlist); `:20-29` (`fromBundle` defaults to `defaultAPIOrigin` at `:23`).
- **§7.1** — `LoadTimingView.swift:243` (`evaluate` call), `:273` (`TimelineView(.everyMinute) { _ in`), `:274` (`Date()` not `context.date`), `:407` and `:488` (both cards call `forecastOverlay`); `LoadTimingForecastEstimator.swift:365-387` (per-minute scan loop), invoked at `:339`, `:356`, `:406`, `:435`.
- **§4.1** — `PWUsageApp.swift:2` (`import Combine`), `:13`, `:18`, `:33`; `DashboardCoordinator.swift:111-129`; `LoadProfileStore.swift:5`.

**Compiler ground truth confirms the concurrency findings are the only Swift-compiler-detectable class present, and the build is clean of them.** No concurrency warnings exist, which is itself a finding: the issues in §3 are the ones Swift 6 strict checking does not catch — lifecycle, cancellation propagation, and cross-object state invalidation.

---

*Generated by the `ios-code-audit` skill (read-only; no source files were modified). Reference passes: `swiftui-pro`, `swift-concurrency-pro`, `swift-testing-pro` from `twostraws/Swift-Agent-Skills`, and `jazzychad/ios-code-audit`.*
