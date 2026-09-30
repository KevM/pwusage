# iOS Audit Correctness Tail — Design Spec

**Date:** 2026-09-30
**Branch:** `fix/ios-audit-correctness-tail` (stacked on `fix/ios-audit-high-findings`, PR #117)
**Source:** [`CODE_AUDIT.md`](../../CODE_AUDIT.md) — 57 findings OPEN after PR #117

## Goal

Close the remaining **confirmed** defects in `cmd/ios-app` and the self-contained cleanup that
§2 of the audit already scoped, then hand the rest of the audit to later branches with an accurate
ledger.

This is the second batch. PR #117 took the 10 High findings plus 3 coupled Mediums. This batch
takes the five defects whose code paths were confirmed by reading them, plus §2's quick wins.

## Non-goals

- **§3 Concurrency (8 findings), §4 API modernity (5), §7 Performance (5), §8 UI modernization (17
  remaining), §9 Dead code (15).** Each is an independent sub-project needing its own spec. §3 in
  particular is the racy one and is deliberately left to a branch that can spend a whole cycle on
  it.
- **§5.6's fix** (re-gridding Solcast arrays onto a union interval grid). Deferred — see D2.
- **§5.7's `ContinuousClock` migration.** Deferred to the §3 batch — see D3.
- Any `@Observable` migration (§4.1). Not coupled to a defect.
- The server half of anything. Every finding here is client-side.

## Constraints carried from the repo

- All iOS tests use Swift Testing (`import Testing`, `@Suite`, `@Test`, `#expect`, `#require`). No
  XCTest. — `AGENTS.md`
- Every native test run uses `./run-tests.sh`, never `xcodebuild test` directly. — `AGENTS.md`
- The build must stay at **zero Swift compiler warnings**; the audit captured this as ground truth
  and it is a regression gate.
- Battery SoC must never be presented as fresh when stale; if too old, show unknown (`--`).
  — `AGENTS.md`, the TRMNL route rules
- No `any`. Explicit types for all parameters and returns. — `AGENTS.md`
- A budgeted-request discipline: avoid per-request live/history fetches. — `AGENTS.md`
- `-only-testing` filters on the suite **type**, not the file. A run naming a file can silently skip
  a sibling suite and report a false green. Full-suite and explicit-suite runs are both required.
  — recorded in `task.md` after the previous branch's review

## Tracking

[`CODE_AUDIT.md`](../../CODE_AUDIT.md) stays the **live cross-PR tracking list**. Every finding this
branch touches gets its `Status` bullet flipped **in the same commit that fixes it** — never
batched into a cleanup. Section and finding numbers are stable and are never renumbered; a finding
dropped rather than fixed keeps its number and states the reason.

`task.md` remains the per-session ledger for *why* a decision was made. A `Ruling:` line there
explains a departure from the audit's recommendation; the `Status` bullet records completion. They
are not duplicates.

Because the audit's `Location` lines were re-derived after PR #117's edits, this branch re-derives
them again in each fixing commit. Cite the amended code, not the pre-fix code the audit read, and
say so in the `Confidence` bullet — the convention PR #117's whole-branch review established.

## Decisions settled with the reviewer

Seven questions were settled before this spec was written. The reasoning, not just the outcome, is
what a future reader needs.

### D1 — §8.18 shows a blank battery, matching the TRMNL surface

The audit filed this as "decide what an unknown charge should show", correctly refusing to reduce a
product decision to a one-line fix. The decision is to render a **blank** battery — outline drawn,
no fill — with no `.bolt` suffix, in a neutral tint.

The justification is cross-surface consistency, and it is not a guess. All three battery renderers
in `cmd/next-app/src/lib/trmnl/components.ts` do the same thing when `soc` is null
(`:50`, `:83`, `:116`):

```ts
const hasData = soc !== undefined && soc !== null;
const level = hasData ? Math.max(0, Math.min(100, soc!)) : 0;   // → 0
const text = hasData ? Math.round(level).toString() : '--';
const fillWidth = (level / 100) * 18;                            // → 0
```

So the e-ink dashboard already renders `--` beside an **empty** battery and never a full one. The
iOS app should say the same thing on the other surface. The iOS equivalent of `fillWidth = 0` is
`battery.0percent`.

This also dissolves the objection that a 0% glyph asserts a value. It does not: the blank fill says
*no fill*, and the adjacent text carries the meaning — which is precisely how TRMNL distinguishes
them. A genuine 0% reading renders `0%` beside the same blank glyph on both surfaces.

Two refinements follow from lining up with TRMNL, neither of which TRMNL needs because its SVG is
hand-built and always neutral:

- **No `.bolt` when the charge is unknown.** `batterySymbol` currently appends `.bolt` when
  charging; a bolt beside a blank battery asserts flow that the blank fill denies.
- **Neutral tint when unknown.** `DashboardView.swift:79` hardcodes `.foregroundStyle(.green)` and
  the Battery `MetricTile` passes `tint: .green` (`:107`), so a blank-but-green battery still reads
  "healthy". Unknown renders `.secondary`.

A provenance enum was considered and rejected. `validatedStateOfCharge`
(`MobileContracts.swift:115-121`) collapses four distinct no-reading reasons — omitted, out of
range, undated, future-dated — into a bare `nil`, and a new wire-contract type would have existed
only to separate cases the display treats identically. One `nil`, one glyph.

### D2 — §5.6 is WON'T FIX, not fixed

The audit's `Action` is to align arrays onto the union of their interval boundaries, bucketing and
re-weighting each array's kW onto a common grid. The mechanism is real: each array is a **separate
sequential HTTP request** (`SolarForecastStore.swift:414-418`), so the interval key sets come from
different wall-clock times and can legitimately differ. `SolarForecast.combine`
(`SolarForecast.swift:209`) requires an exact set match, so one differing interval throws
`incompleteCoverage` and voids the whole forecast.

It is not being fixed because the audit states plainly that "the frequency of key divergence is
inferred from Solcast's API contract, **not observed**", and because the fix lands in the energy and
cost math — the most correctness-critical code in the app. The requests are seconds apart on a
fixed epoch grid, so identical key sets are the overwhelmingly likely outcome. Writing
re-weighting logic against an unobserved trigger is speculative, and speculative changes to cost
math are worse than a known sharp edge.

Recorded as `WON'T FIX` with the condition for revisiting: if a device is ever observed returning
`incompleteCoverage` with a divergence that is not a genuine empty array, re-open it.

### D3 — §5.7 splits; the `ContinuousClock` migration is re-filed as §3.15

§5.7 bundles three things of very different sizes:

| Part | Site | Size | Disposition |
| --- | --- | --- | --- |
| (a) A backwards clock silently **stops all polling** | `isDue`, `DashboardCoordinator.swift:636-639` | one line | **this branch** |
| (b) A backwards clock makes **any forecast age look fresh** | `LoadTimingForecastPresentation.swift:96` | one line | **this branch** |
| (c) Anchor cadence to `ContinuousClock` | `lastAttempt` stamps across the coordinator | structural | **§3 batch** |

(c) is deferred because it is the same `lastAttempt` bookkeeping as §3.7 ("cadence timestamps are
stamped before the request runs"), which is in the §3 batch. Doing (c) here means touching those
lines twice, and the two changes belong together: a monotonic clock makes §3.7's "stamp after the
request" rule meaningful, because a pre-request stamp on a monotonic timeline is exactly the
problem.

It is **re-filed as a new §3 finding (§3.15)** rather than left as a note, because the no-renumbering
rule makes `§5.7` the stable handle for "device-clock trust", and part (c) would otherwise be lost
behind a `FIXED` status on a partially-fixed finding.

### D4 — §5.5 keeps the forecast visible and adds its own note

The audit's `Action` is: "on a persist failure, keep the in-memory cache, mark the scope failed, and
surface a distinct 'could not save' state — without deleting the Keychain item." **Marking the scope
failed would hide the very cache the same sentence says to keep**, because
`isRecommendationUsable` (`SolarForecastStore.swift:200`) gates on
`!state.failedScopes.contains(scope)`, and a failed refresh drives the coordinator to
`.failedWithBasic`, which the overlay builder refuses by requiring
`enhancement == .enhanced` (`LoadTimingForecastPresentation.swift:95`). The Action is
self-defeating as written.

**Decision:** a save failure is not an unavailability. The forecast stays on screen, and the user
is told the truth about durability in a note of its own.

This is why `SolarForecastUnavailableCause` cannot carry it: `causeNote`
(`LoadTimingForecastPresentation.swift:252-273`) prefixes **every** message with
`"Solar forecast unavailable — using tariff and balance data."`, which would be false — the
forecast is available, it just is not on disk.

### D5 — §5.8 needs no counter, and gets its own skew constant

Two halves, both worth fixing, and the audit's instructions for both needed correction.

**Negative skew.** The audit says to widen the allowance "to match the live contract's tolerance",
but the live contract has *zero* negative tolerance — `MobileContracts.swift:120` requires
`age >= 0`, which is **stricter**, not more lenient. The two cases are not comparable. A
future-stamped SoC *reading* is suspect data; `asOf` is a *server* timestamp compared against a
device clock, and a device running fast makes it look future-dated without the data being wrong.
So `asOf` gets its own named constant with a generous negative bound, and the 24h positive bound
stands. The bound is asymmetric on purpose: the cost of leniency is that `asOf` freshness is
computed slightly wrong for a bounded window; the cost of strictness is a permanently broken
feature with a message that blames the server.

**Eviction needs no counter — and may need no eviction at all.** The audit's "evict the cache entry and
refetch once" implies a failure counter, because `validating` is a pure function that cannot know it has
failed before. It does not need one. The poison path is the **cached** entry at
`DashboardCoordinator.swift:506`. A cached entry can fail re-validation while the lifetime check at
`:504` still passes, because `asOf <= fetchedAt`, so `asOf` crosses the 24h bound slightly *before*
`fetchedAt` does. And when a fresh response also fails at `:538`, `:543` never overwrites the cache,
so the poisoned entry lingers and re-fails on every read forever. Evicting on re-validation failure
would be sufficient: control flow falls through to a refetch, a successful refetch re-caches at `:543`,
and a failed refetch leaves the entry absent so the next read simply fetches again.
`planningContextTasks` (`:513`) already dedupes concurrent fetches, so there is no loop risk.

**Amended 2026-09-30, while writing the implementation plan:** re-reading the cache-hit block shows
the audit's "re-rejects the same bad entry on every read **rather than refetching**" is inaccurate.
`if let validated = try? …` is part of the cache-hit *condition*, so a re-validation failure drops
through to the fetch that follows, and `:543` overwrites the entry on success — the cache self-heals.
Since the skew constant is what actually fixes the reported failure, the eviction may fix nothing.
The plan therefore makes Step 5 an **experiment that re-derives the claim before any code changes**,
with the eviction conditional on that experiment failing. If it passes unmodified, the eviction is
skipped, the experiment is kept as a regression test for the self-healing property, and §5.8's `Fix:`
bullet records that the audit's claim was inaccurate. Adding a code change whose necessity cannot be
demonstrated is how a fix stops being a fix.

### D6 — §2's quick win #1 and §9.4 are wrong as audited

Both propose deleting `solarForecastSettingsDidEdit()` and `loadProfileDidEdit()` as dead code. They
are not dead. `SolarForecastCoordinatorTests.swift:552-611` uses them as a deliberate
**synchronization seam**: three tests call them *mid-flight* to model "the user typed in the
settings sheet while a refresh was in progress", then assert the in-flight work still completes
correctly.

The tests are named for the invariant they protect — *"Profile comparisons and settings edits
perform no requests"*, *"Unsaved settings edits do not strand a loading enhancement"*, *"Unsaved
settings edits do not supersede a disconnect in progress"*. **The emptiness is the contract under
test.** It is a tripwire: a guard that a future edit does not quietly add network work to a local
edit. Deleting the methods deletes three regression tests.

The legitimate half of the finding is the four **view** call sites, which fire a no-op per keystroke
(`.onChange(of: apiKey) { coordinator.solarForecastSettingsDidEdit() }`).

**Decision:** keep both methods and all three tests; delete the four view call sites; record in
§9.4 that the methods are an intentional no-op seam, so the next reader does not file the same
finding again.

### D7 — §2's quick win #2 is already fixed

The audit proposes removing the no-op `do { … } catch { throw error }` from `PWUsageAPI.swift`. It
is gone: §6.2's rewrite replaced it with meaningful `catch let error as MobileLiveResponse.ContractError
{ throw error }` / `catch { throw PWUsageAPIError.invalidResponse }` pairs
(`PWUsageAPI.swift:49-51`, `:57-60`). Note the file also moved from `PWUsage/Services/` to
`PWUsage/Networking/`, so the audit's path is stale. The quick win is struck rather than
implemented.

## Commit sequence

One commit per finding, ordered so the most damaging defect is first and stays independently
cherry-pickable. §5.5 destroys a working credential; §5.12's change is test-only; the quick wins
touch files the defect commits also touch, so they go last to keep every earlier commit
bisectable.

| # | Commit | Findings | Files |
| --- | --- | --- | --- |
| 1 | `fix(ios): stop discarding a working Solcast key on a save failure` | §5.5 | store, coordinator, presentation |
| 2 | `fix(ios): draw an unknown battery charge as blank, not full` | §8.18 | `DashboardView`, `DashboardPresentation` |
| 3 | `test(ios): contain fixture failures to one test` | §5.12 | 4 test files |
| 4 | `fix(ios): tolerate a fast device clock on the planning context` | §5.8 | contracts, coordinator |
| 5 | `fix(ios): stop a backwards clock stalling polls and faking freshness` | §5.7 a+b | coordinator, presentation |
| 6 | `refactor(ios): take the audit's self-contained quick wins` | §2 | 8 files |
| 7 | `docs(ios): reconcile the audit ledger with the correctness tail` | ledger | `CODE_AUDIT.md`, `task.md` |

## Per-finding design

### §5.5 — a save failure must not destroy a working key

**Defect.** In `performRefresh`, the cache is written and then `try await persist()`
(`SolarForecastStore.swift:427`) throws. That sits inside the same `do` block as the fetch, so it
lands in the generic `catch` at `:434`, which calls `persistFailureState` (`:442-456`); if persisting
*again* fails there, `quarantineCredential` (`:458-476`) **deletes the Keychain item**. The only
fault is a disk or write failure, not a bad credential and not a bad response, yet the user's
working API key is destroyed and must be re-entered.

**Why quarantine exists at all**, and why narrowing it is safe: if a *failure state* cannot be
persisted, the on-disk state still advertises a healthy credential, so the next launch would retry
with data already judged unusable. The quarantine is a safety valve for "we cannot record that this
credential is bad" → destroy it rather than keep using it. For §5.5 the reasoning inverts: the
fetch **succeeded**, the data is good, and destroying the key is the wrong trade.

**Change.**

*Store.* Lift the post-fetch `persist()` out of the fetch's `do` block so a save throw cannot reach
the request-failure `catch`. Add `SolarForecastRefreshFailure.saveFailed`. On save failure: keep
`state.caches[scope]` (already assigned in memory), do **not** insert into `failedScopes`, do
**not** call `persistFailureState` or `quarantineCredential`. Return `.failed(.saveFailed)`.

The budget-reservation persist at `:403-406` already performs exactly this separation for the same
reason. The fix applies the existing shape to the second call site; no new mechanism.

*Coordinator.* `SolarForecastUnavailableCause.init(_ failure:)` (`:50`) becomes **failable**,
returning `nil` for `.saveFailed`, with a comment stating that a save failure is not an
unavailability. Making it failable is deliberate: the non-exhaustive `switch` is a compile error
until the decision is made, so the choice cannot be forgotten. `refreshSolarForecast` special-cases
`.saveFailed` ahead of the `guard refresh == .refreshed || refresh == .alreadyFresh` at `:417` and
takes the success branch. Add `@Published private(set) var solarForecastSaveFailure`, set beside
`.enhanced`, cleared in `resetForecastEnhancement` and the sign-out / invalidation resets so a stale
warning cannot outlive a session.

*Presentation.* Add a `saveFailed` input to the overlay builder. When set, the note is the save note
under its own prefix — never `unavailableNotePrefix`. Copy: *"Forecast fetched, but it could not be
saved to this device. It will be retried on the next refresh."*

**Tests.**

- A save failure after a successful fetch returns `.failed(.saveFailed)`.
- The credential is **still loadable** from the keychain afterwards — the regression this finding is
  about.
- The in-memory cache is still served: `cachedBatch` is non-`nil` and `isRecommendationUsable` is
  `true`.
- **Tripwire:** a *request* failure that cannot be persisted still quarantines. Without this the fix
  could silently disable the safety valve it is narrowing, which is the most likely way to get this
  wrong.
- Coordinator: `.saveFailed` yields `solarForecastState == .enhanced`, `solarForecastBatch != nil`,
  `solarForecastUnavailableCause == nil`, `solarForecastSaveFailure == true`.
- Presentation: the note is the save note and does **not** contain "unavailable".

### §8.18 — an unknown battery charge draws blank

**Defect.** `batterySymbol` (`DashboardView.swift:306-319`) switches on the rounded charge when it is
non-`nil`, but its `else` branch sets `level = "100percent"`. So an unknown charge renders `--`
(`:71`) with the accessibility label "Battery charge unknown" (`:75`) beside a **full** battery
(`:77`), and the same function supplies the Battery `MetricTile` symbol (`:107`), so the full glyph
appears twice.

**Change.** Per D1:

- Move `batterySymbol` to `DashboardPresentation`, beside `batteryDirection` (`:19`), which is
  already directly unit-tested. It is currently a `private func` on the view, so this relocation is
  what makes the mapping testable at all; duplicating the switch in a test is the alternative and is
  worse.
- `nil` → `battery.0percent`, with no `.bolt` suffix.
- `DashboardView.swift:79` and the tile's `tint:` (`:107`) both resolve to `.secondary` when the
  charge is unknown, `.green` otherwise.
- `--` and "Battery charge unknown" are already correct and stay untouched.

**Tests** (in the existing `DashboardPresentation` suite): `nil` → blank glyph with no `.bolt`;
`0` → the same glyph, distinguished by the text, as TRMNL does; the existing band boundaries
(12/13, 37/38, 62/63, 87/88) unchanged; charging and discharging suffixes unchanged for a known
charge.

**Device check owed**, recorded in the finding the way §5.10's is. The outcome is a rendered glyph
and its spacing beside the `--`; no snapshot test or preview verifies that, and the app gates every
screen behind a real sign-in, so it was not observable in the audit environment.

### §5.12 — `try!` in test fixtures

**Defect.** Five `try!` sites across four helpers build a fixture inside a `static let` initializer
or a shared `makeService`/fixture helper: `PWUsageAppModelTests.swift:271` and `:371`,
`MobileAuthServiceTests.swift:437`, `DashboardCoordinatorTests.swift:528` and `:533`. Any thrown
error — a validation rejection, a decode failure — becomes `_assertionFailure` → `SIGTRAP`, killing
the whole binary instead of failing one test.

This was reproduced while fixing §6.2: an intermediate revision put the Release host allowlist inside
`validate`, rejected the `https://pwusage.test` fixtures, and produced 26 `PWUsage-*.ips` crash
reports roughly four seconds apart as each suite retried, with no test-level message naming the
cause. A reader would have seen repeated process deaths rather than "these five fixtures name a host
a Release build may not name".

**Change.** Replace the `try!` sites with a throwing fixture helper that each test calls with `try`.
**Not** `fatalError` — the point is to *contain* the failure, and `fatalError` reproduces the exact
mechanism.

**Verification.** This is test infrastructure, so the proof is a mutation check: deliberately break
one fixture's payload, run the suite, and show the run reports **one named failing test** rather
than a crash storm. Then restore and confirm green. Recording the crash count before and after is
the evidence; a claim that the helper "throws now" is not.

### §5.8 — planning-context skew and cache eviction

**Defect.** `validating(siteID:now:)` (`MobileContracts.swift:219-231`) requires `sourceAge` within
`[-(5 * 60), maximumAge]`. A device more than five minutes fast rejects **every** server response as
`contextInvalid`, permanently, and the cached re-validation at
`DashboardCoordinator.swift:506` re-rejects the same entry on every read rather than refetching. The
note shown points at the wrong component: *"The server sent household data this app could not
read. Please report this."*

**Change.** Per D5:

- Extract a named negative-skew constant beside `stateOfChargeMaximumAge` (matching the file's
  existing style) and widen the bound to `MobileLoadPlanningContextResponse.maximumNegativeAgeSkew`
  = **1 hour**. Keep the 24h positive bound. Document why the two directions are asymmetric.
  One hour is chosen because a phone is NTP-synced to within seconds, so anything past a few
  minutes is a broken clock, while the thing being protected — a household profile that is already
  cached for 24h — changes slowly enough that an hour of mis-measured freshness costs nothing.
- Evict `planningContextCache[siteID]` when re-validation of a **cached** entry fails — **only if the
  plan's Step 5 experiment shows it is needed.** See the amendment above. Leave the fresh-response
  path (`:538`) alone either way: it already declines to cache an invalid response.
- Correct the user-facing diagnosis for this case so it does not tell the user to report a server
  bug that is really a device clock.

**Tests.**

- A response whose `asOf` is ahead of `now` by more than the old 5 minutes still validates.
- A response whose `asOf` is ahead by an absurd amount (e.g. a year) does **not** validate — the
  tolerance is bounded, and this pins the bound.
- A cached entry that fails re-validation is evicted, and the subsequent read fetches.
- A cached entry that fails re-validation is replaced by a fresh valid response — **or, if the
  plan's experiment shows the cache already self-heals, a test pinning that self-healing instead.**
  Either way assert the **outcome** (a usable context, no `contextInvalid`), not the internal
  dictionary: a test against `planningContextCache` would be rewritten by any correct refactor.
- The note shown for a skew-rejected context does **not** tell the user to report a server bug.
  Copy is presentation-level; assert it in `LoadTimingForecastPresentationTests` rather than
  asserting only that a reason enum changed.

### §5.7 (a) and (b) — the device clock

**(a) `isDue` (`DashboardCoordinator.swift:636-639`).** `date.timeIntervalSince(lastAttempt) >= interval`
means a backwards clock jump makes the 5-minute live poll and 30-minute bill poll stop **entirely**,
with no error and no UI indication. Fix: treat a negative elapsed interval as due, and guard
finiteness, matching `isRecommendationUsable`'s existing `age.isFinite` house style.

The asymmetry is the whole point: a spurious poll costs one request, a stalled poll freezes live and
bill data indefinitely and silently.

Test through the public surface — the coordinator already takes an injectable `now:` and a
`timerInterval:`, so the test moves the clock backwards and asserts via `refreshDue()` that a
refresh still happens. No test-only seam on the private helper.

**(b) The overlay gate (`LoadTimingForecastPresentation.swift:96`).** The guard is
`now.timeIntervalSince(fetchedAt) <= maximumForecastAge` with no `>= 0`, so a backwards clock makes
*any* age look fresh. Add the bound.

`LoadTimingRecommendation.isFresh` (`:139`) already does `age >= 0 && age <= detailFreshnessWindow`,
so this is aligning an outlier with the codebase's existing convention, not inventing a rule.

Tests: a forecast stamped in the future yields a non-forecast-aware overlay; a forecast inside the
window still yields one. The existing suite already covers the upper bound from the previous
branch's review, so this is the sibling case.

### §2 — the surviving quick wins

| Item | Change | Note |
| --- | --- | --- |
| #1 | Delete the 4 view call sites; keep both methods + 3 tests | D6 — §9.4 gets a note |
| #2 | — | D7 — already fixed by §6.2 |
| #3 | `fetchSites` (`PWUsageAPI.swift:42`) → `MobileContractDecoder.make()` | `:42` is the only bare `JSONDecoder()` among the four contract decodes; `:79`/`:117` decode `SessionResponse`/`ErrorResponse`, which are not contracts |
| #4 | Consolidate 3 scattered `extension PWUsageAPI:` conformances | `PWUsageApp.swift:11`, `DashboardCoordinator.swift:10`, `:17` |
| #5 | Interpolate `SolarForecastStore.totalAttemptsPerUTCDay` at `SolarForecastSettingsSheet.swift:122` | removes a duplicated literal of `:83` |
| #6 | Rename `SitePreviewTimeZone` → `SITE_PREVIEW_TIME_ZONE` | `SolarForecastPreviews.swift:8` |
| #7 | Move the closing brace at `LoadTimingForecastPresentation.swift:76` | |
| #8 | Drop unused `CaseIterable` from both preview-mode enums | `DashboardPreviews.swift:4`, `SolarForecastPreviews.swift:12`; `allCases` appears nowhere |
| #9 | Delete `LoadProfile.isBuiltIn` | no callers; the real built-in/custom distinction is id comparison at `LoadProfileStore.swift:109` |

All eight are mechanical. The one with a behavioural consequence is #3: routing `fetchSites` through
`MobileContractDecoder.make()` injects the clock into `decoder.userInfo`, which `[MobileSite]` does
not read, so the decode is unchanged — but it is verified by the existing site-fetch tests rather
than assumed.

## Testing strategy

TDD per finding, in commit order, as PR #117 did it.

- **RED first.** Each fix starts from a test that fails for the stated reason. A compile error is the
  normal Swift red for a brand-new type and is acceptable; a test that fails for an unrelated reason
  is not.
- **Mutation-check the load-bearing assertions.** A test that passes both before and after the fix
  proves nothing. PR #117 established the pattern — force `isForecastAware: true` in the fallback
  branch and show 4 tests fail, then revert and show 15/15. The three fixes where a green test could
  pass vacuously are §5.5 (must confirm the key survives), §5.7 (a) (must confirm a refresh actually
  happens, not merely that nothing throws), and §5.8 (must confirm eviction, not just that validation
  is lenient).
- **Full-suite runs, not just targeted ones.** `-only-testing` filters on the suite *type*, not the
  file, so naming a file can silently skip a sibling suite and report a false green. This exact trap
  produced a false 19/19 on the previous branch.
- **Regression sweep.** The §5.5 and §5.7 changes touch `SolarForecastStore` and
  `DashboardCoordinator`, whose existing suites are the densest in the project. All of
  `SolarForecastCoordinatorTests`, `DashboardCoordinatorTests`, `MobileContractsTests`,
  `LoadTimingForecastPresentationTests`, and `LoadTimingForecastEstimatorTests` must stay green.
  The estimator suite in particular is the guard on the cost math that §5.6's deferral relies on
  remaining untouched.
- **Build gate.** `xcodebuild ... CODE_SIGNING_ALLOWED=NO build` must report **zero Swift compiler
  warnings** after every commit, not just at the end.

## Verification gates

1. `./run-tests.sh` — full suite, green, no process crashes in
   `~/Library/Logs/DiagnosticReports` (the §5.12 evidence).
2. Zero-warning build.
3. `./run-tests.sh <Suite>` for each suite named above, explicitly.
4. `CODE_AUDIT.md` shows every finding in this spec with an accurate `Status`, and the
   `Progress` / count table reconciles.
5. No `try!` remains in `PWUsageTests/` outside the five sites this branch replaced.
6. `grep -rn "isBuiltIn" PWUsage/ PWUsageTests/` returns nothing.

## Audit ledger updates

In `CODE_AUDIT.md`, in the same commit as each fix:

| Finding | New status | Note to record |
| --- | --- | --- |
| §5.5 | `FIXED (PR pending)` | Save failure no longer quarantines; the forecast stays visible with its own note. Record that the audit's `Action` was self-defeating (D4). |
| §5.7 | `FIXED (PR pending)` | Parts (a) and (b) only. Record that part (c) moved to §3.15, and that the audit's `Action` bundled three sizes of change (D3). |
| §5.8 | `FIXED (PR pending)` | Named skew constant + eviction, no counter. Record the correction to "match the live contract's tolerance" (D5). |
| §5.12 | `FIXED (PR pending)` | Record the mutation check, including the before/after crash count. |
| §8.18 | `FIXED (PR pending)` | Record the TRMNL precedent, the neutral-tint and no-bolt refinements, and that the device check is still owed. |
| §5.6 | `WON'T FIX` | D2's rationale and the condition for revisiting. Number stays in place. |
| §9.4 | stays `OPEN`, gains a note | D6: the methods are an intentional no-op seam with three tripwire tests; the four view call sites are gone. |
| §3.15 | **new finding** | `ContinuousClock` cadence anchoring, filed so part (c) of §5.7 is not lost behind a `FIXED` status. Severity Medium. |
| §2 | strike #2, mark #1 corrected | D7 and D6. |

Counts move from **57 OPEN / 17 FIXED** to **52 OPEN / 22 FIXED / 1 WON'T FIX**, over 75 tracked
findings: five findings flip to `FIXED` (§5.5, §5.7, §5.8, §5.12, §8.18), §5.6 leaves `OPEN` for
`WON'T FIX`, and §3.15 is added as a new `OPEN` finding. §9.4 stays `OPEN` with a note, and §2 is
not a numbered finding so it does not move any count.

In `task.md`, a Ledger section for this branch with the seven `Ruling:` lines (D1-D7), matching the
established format: what was decided, why, and what it costs if the ruling is wrong.

## Risks

- **§5.5 is the one that can lose user data if it is wrong in the other direction.** Narrowing
  quarantine is deliberate; the tripwire test that a request failure still quarantines is what keeps
  it safe. If that test is skipped, the fix has removed a safety valve without a replacement.
- **§5.7's tolerance widening trades a bounded wrong-freshness window for a bounded wrong-staleness
  window.** Both are wrong; the choice is which one the user is more likely to hit and which one
  points at the wrong component. Named constant, documented asymmetry, and a test that pins the
  bound are what keep it honest.
- **§5.8's eviction changes cache behaviour on a path the estimator depends on.** The
  `LoadTimingForecastEstimatorTests` suite is the guard and must be run explicitly, not just as part
  of the full suite.
- **The quick-win commit touches files the defect commits touched.** It goes last for that reason, so
  every earlier commit stays bisectable and reviewable on its own.
- **Two device checks remain owed** after this branch and cannot be discharged here: §8.18's rendered
  glyph, and §5.10's alert-over-dialog presentation from PR #117. Both need a real sign-in, which
  this environment does not have.
