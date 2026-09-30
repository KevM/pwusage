# iOS Solcast load timing

- [x] Restart from `origin/main` with configurable load profiles/tariff timeline from PR #115.
- [x] Reapply the Solcast design and implementation plan commits.
- [x] Baseline verification and prerequisite review.
- [x] Task 1: Typed provider contract and interval aggregation. (`37c5e54`)
- [x] Task 2: Local credentials, selection, cache, and request budget. (`b757511`)
- [x] Task 3: Bounded historical planning context. (`39daa1b`)
- [x] Task 4: Pure lowest-cost comparison engine. (`0008ef1`)
- [x] Task 5: Connection settings and foreground orchestration. (`72b57ee`)
- [x] Task 6: Recommendation presentation and fallback.
- [x] Task 7: Integration verification and handoff.

## Ledger

- Ruling (setup): plan lives in `docs/plans/` and predates the superpowers plan
  format, so `executing-plans`' brief/ledger scripts do not apply. Using this file
  as the ledger, as `AGENTS.md` prescribes. Cost if wrong: none; same content.
- Ruling (setup): `task.md` checkboxes alone were insufficient to record why Task 5
  was reopened, so this Notes-backed Ledger section exists.
- Task 6: Ruling: added `Comparison.bestAlternativeSavings` to the Task 4 estimator
  type. The plan requires an "insignificant savings" case, but `savings` is zeroed
  whenever start-now is recommended, so "nothing cheaper exists" and "waiting would
  save a rounding error" were indistinguishable. The new field is the raw saving of
  the cheapest non-now start and changes no cost math. Cost if wrong: one unused
  field.
- Task 6: Ruling: modified `DashboardCoordinator.swift`, which Task 6's Modify list
  does not name. The plan's test list distinguishes invalid key / timeout / 429 /
  partial-array failure, but the coordinator collapsed every failure into
  `failedWithBasic`. The store already carried a typed `SolarForecastRefreshFailure`,
  so publishing it plus a `SolarForecastConnectionState` plumbs existing values with
  no new business logic. Without it the four per-cause tests would be four identical
  tests. Cost if wrong: two extra published properties on the coordinator.
- Task 6: Ruling: a configured connection whose forecast inputs are unusable shows
  the informational note, including the missing-tariff case; an unconfigured device
  and a zero-charge car show none. The design asks for a note "when a configured
  connection fails" and a missing tariff still leaves the connection configured.
  Cost if wrong: one note appears next to a basic-estimator unavailable state.
- Task 6: Ruling: time assertions normalize U+202F/U+00A0. iOS 17+ `DateFormatter`
  puts a narrow no-break space before AM/PM; the copy is correct and only the test
  fixture was locale-brittle. Cost if wrong: assertions become slightly looser.
- Task 6: note on TDD — the first RED was a compile failure, which is the normal
  Swift red for a brand-new type. The safety test was separately mutation-checked:
  forcing `isForecastAware: true` in the fallback branch fails 4 tests, and reverting
  restores 15/15.
- Task 6: `-only-testing` filters on the suite *type*, not the file. Running
  `LoadTimingViewTests` silently skipped the new `LoadTimingForecastPresentationTests`
  suite and reported a false 19/19 green. Full-suite and explicit-suite runs are
  both required from here on.

## Final review (independent reviewer, branch 73fbb05..89355d7)

No Critical findings. Credential locality, request isolation, cost math,
authorization, and the additive-fallback structure were confirmed correct against
the design. Eight Important findings entered one fix pass, each TDD-verified:

1. Final: fixed budget-exhausted/deferred showed a stale-forecast note and told the
   user to retry an exhausted allowance — `SolarForecastUnavailableCause` added;
   test `A spent daily allowance is not mistaken for a stale forecast` RED->GREEN.
2. Final: fixed site switch never re-ran the enhancement and misreported the
   connection as unconfigured — test `Switching sites re-runs the detail load for
   the newly selected site` RED->GREEN.
3. Final: fixed a >6h-old forecast still producing fresh recommendations on the
   minute tick, against the design's explicit rule — tests `A forecast older than
   the recommendation window cannot produce a new recommendation` and `A forecast
   inside the recommendation window still produces a recommendation` RED->GREEN.
4. Final: fixed stale/missing balance and no-fitting-run being blamed on the
   forecast — tests `A stale billing balance is reported as stale energy data, not a
   Solcast problem` and `A run longer than the search horizon says so instead of
   blaming the forecast` RED->GREEN.
5. Final: fixed a seasonal tariff boundary permanently disabling the feature —
   a period with no observed balance now truncates the horizon at its start, and
   only an already-elapsed unbalanced period rejects — tests `A tariff season
   boundary truncates the horizon instead of disabling the comparison` and `A
   missing balance for a period already under way still rejects the comparison`
   RED->GREEN. All 45 pre-existing estimator tests still pass.
6. Final: fixed an exact-millisecond join in `load-planning-context` that turned
   any sub-minute timestamp drift into a silent total outage — rows now attach to
   the nearest grid interval within 60s, each interval claimed at most once, with a
   distinguishable `timestamp-misaligned` reason. 5 new web tests RED->GREEN.
7. Final: fixed `.textContentType(.password)` on the Solcast key field, which lets
   the system offer to sync the key into the user's iCloud Keychain and so breaks
   the device-only guarantee. Not unit-testable (declarative view modifier).
8. Final: fixed `PWUsageAppModel` bypassing its injected store so signing out in a
   test deleted the real shared store's key — tests `Signing out clears the
   injected forecast store rather than the shared one` and `A failing forecast
   sign-out is reported to the user instead of silently ignored` RED->GREEN.

Final: minor (deferred): a sub-minor saving renders as "waiting would save about
$0.00, which is not worth delaying"; the branch tests `> 0` rather than the minor
unit. **Fixed after review** — the branch now requires the saving to exceed the
currency's minor unit, so anything that would render as $0.00 falls through to
"no cheaper start was found".
Final: fixed — the forecast section was wired to `recommendation.suggested`, which
is nil whenever no load fits the observed surplus, when observations are stale, or
when any period lacks a balance. A household in deficit therefore saw no forecast
UI at all, which is the common case for someone timing loads. Placement is now
derived by `LoadTimingForecastPresentation.placement` from the load the user is
actually viewing, and the section renders in exactly one card (recommendation when
it matches the suggestion, explorer otherwise). Tests `The forecast is still shown
when no load fits the observed surplus`, `The forecast sits on the recommendation
card when it matches the suggested load`, `The forecast moves to the explorer when
a different load is chosen`, and `There is nowhere to place a forecast when the
user has no load profiles` RED->GREEN; the visibility test was mutation-checked
against the original `suggested != nil` guard.
Final: minor (deferred): `refreshSolarForecast(manual:)` has no UI caller, so the
"Retry" wording in failure notes points at an action the app does not offer.
Final: minor (deferred): `Comparison.assumptions` is computed and never rendered,
so users are not told the recommendation is an enumerated search, not an optimum.
Final: minor (deferred): `DeviceSolarForecastPersistence.clearConnections` is dead
code and `generations` is never pruned.
Final: minor (deferred): `load-planning-context` per-slot 90% coverage is
effectively "all six" five-minute samples on ordinary days.
Final: minor (deferred): the 7-day minute-sampled tariff timeline is a new
per-request cost on the hottest mobile route.
Final: minor (deferred): orphaned Keychain items survive a lost `state.json` until
the next sign-out.

## iOS audit high findings (`fix/ios-audit-high-findings`)

- [x] Baseline: audit read, spec written, 10 High findings scoped.
- [x] Group A — §3.12, §3.13, §3.14, §3.3 (auth continuation safety).
- [x] Group B — §5.3 (cadence), §5.2 (context recovery), §7.1 (estimator/body).
- [x] Group C — §5.4, §5.9 (battery SoC provenance).
- [x] Group D — §5.11, §6.1, §6.2, §5.10, §7.7 (config, signing, origin, errors).
- [x] Whole-branch review follow-ups (ledger reconciliation, §8.18 filed).

- D1: Ruling: §5.1 keeps the marginal delta and fixes the wording; no estimator
  change, no `absoluteCost` field. The audit filed the defect as High on the
  claim that the displayed number could be an order of magnitude too small, but
  re-reading the code the maths is right — `Σ (cost(withLoad) − cost(baseline))`
  is the correct answer to "what will running this cost me?", and when the load
  is served by stored surplus the correct answer *is* zero, because that energy
  was already paid for. The defect was the label, not the number, so the severity
  was overstated and is recorded as demoted to Low in `CODE_AUDIT.md` §5.1's two
  Correction bullets. Adding an absolute cost would have been free
  (`loadedCost` is already in scope) and would have hidden the one fact the
  marginal figure exists to convey. Cost if wrong: the labels read oddly for a
  case where the absolute cost is what the user expected.
- D3: Ruling: §5.3 becomes a 5-minute debounce, not the 30-minute cadence the
  audit proposed. The audit's recommendation was to make `loadTimingDetailAppeared`
  respect the documented `billInterval`; doing that literally would make the Load
  timing screen's numbers go stale on a 30-minute timer while the user is looking
  at them, which is a worse product than the unbudgeted request it fixes. Instead
  the `force: Bool` parameter is replaced by a three-case `BillRefreshTrigger`
  (`.userGesture`, `.screenAppearance`, `.scheduled`) and `.screenAppearance`
  carries a 5-minute floor. `README.md` was rewritten in the same commit to
  describe the real behaviour rather than the "at most every 30 minutes" claim the
  audit filed against. Consequence recorded in `CODE_AUDIT.md` §5.3: the
  appearance path's bill-freshness test had to widen from "a new success" to
  "under five minutes old", or the enhancement would be dropped every time the
  screen reopened inside the floor. Cost if wrong: up to five minutes of extra
  staleness on the Load timing screen, in exchange for the 30-minute claim in the
  README no longer being a fiction.
- Group B: Ruling: the ⌘R / View ▸ Refresh menu was audited as one of the
  `force: true` sites it was actually about. It is not. `PWUsageApp` calls
  `refreshDue()`, which routes to `.scheduled`, so ⌘R has always respected the
  cadence. Recorded in `CODE_AUDIT.md` §5.3 so the next reader does not go
  looking for a bypass there.
- Review: Ruling: `DashboardView.batterySymbol`'s `nil` branch renders a
  full-battery glyph, so §5.4 and §5.9 fix the number and the spoken label
  while leaving the icon contradicting them. §5.9's `Fix` bullet had claimed the
  glyph symptom was resolved; that overclaim is corrected in place, and the
  defect is filed as §8.18 rather than fixed here. What an unknown charge
  *should* draw — a neutral outline glyph, a second glyph distinct from the
  discharging default, or no glyph at all — is a product decision, and
  `batterySymbol` needs the distinction passed in as an input, because `nil`
  alone cannot carry it. Cost if wrong: a full battery shown beside `--` and
  "Battery charge unknown", on a path this branch made materially more common
  (undated, future-dated, and out-of-range readings all now land on `nil`).
- Review: Ruling: `LoadProfilesSheet`'s fixed errors depend on an `.alert`
  presenting over a still-open `.confirmationDialog` on the same view chain,
  which SwiftUI does not reliably do. Not fixed, not claimed fixed — recorded as
  a device check owed in §5.10, alongside §7.7's equivalent disclosure. Cost if
  wrong: a failed delete silently leaves the dialog up with no explanation, which
  is the original defect in a narrower window.
- Review: Ruling: the `DEVELOPMENT_TEAM` value remains in `CODE_AUDIT.md` (§6.1
  and §12) and in the plan. Deliberate. It is an Apple account identifier, not a
  secret, and it is in git history regardless; the load-bearing half of §6.1 —
  no signing team in the committed build config — is done. Redacting the record
  would destroy the only statement of what was removed and where it lived.
  §6.1 now says this explicitly. Cost if wrong: the identifier stays readable in
  tracked files.

## iOS audit correctness tail (`fix/ios-audit-correctness-tail`)

Ten commits, against the seven the plan and spec tabulate. The spec's table counts this
ledger commit; it therefore predicted **six** code commits and the branch has **nine**.

- [x] `395c15b` fix(ios): stop discarding a working Solcast key on a save failure — §5.5.
- [x] `a3d3f3b` fix(ios): draw an unknown battery charge as blank, not full — §8.18.
- [x] `3589ac2` test(ios): contain fixture failures to one test — §5.12.
- [x] `8c44dc9` test(ios): clear three pre-existing test-target warnings — *(not in the
  spec's table; see the commit-count ruling below).*
- [x] `3a7a98d` fix(ios): tolerate a fast device clock on the planning context — §5.8.
  **The subject says "fast" and is wrong** — §5.8 rescues a device whose clock is *behind* the
  server, not one running fast (see §5.8's `Why:`). A commit subject cannot be corrected without
  rewriting the branch, which would invalidate every reference to this SHA, so the error is
  recorded here instead. The direction is corrected everywhere it is editable: this ledger, the
  code comment, the test name, and both the plan and the design.
- [x] `089e3b0` fix(ios): stop a backwards clock stalling polls and faking freshness —
  §5.7 parts (a) and (b).
- [x] `3a367bb` fix(ios): stop blaming a stale forecast for a backwards clock — *(not in
  the spec's table; see the commit-count ruling below).*
- [x] `fcabe56` refactor(ios): take the audit's self-contained quick wins — §2 items 1
  and 3-9.
- [x] `03c41d5` refactor(ios): remove the no-op do/catch in the API transport — §2 item
  2, which the spec struck (see D7 below).
- [x] This commit — `docs(ios): reconcile the audit ledger with the correctness tail`.
  Counts 75 tracked / 52 OPEN / 22 FIXED / 1 WON'T FIX.

- **Branch gate, re-run at the final commit** *(not a task, and deliberately not a checkbox —
  the ten `- [x]` lines above are one per commit and counting them should yield ten)*. The
  branch's rule is that the gate is checked after every task, and this is the last one:
  `cd cmd/ios-app && ./run-tests.sh` exits **0**, **380 tests in 21 suites** passing.
  `./generate.sh && xcodebuild -project PWUsage.xcodeproj -scheme PWUsage -destination
  'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build` prints **BUILD SUCCEEDED**
  with `grep -c "warning:"` = **0**. `CODE_AUDIT.md`'s header documents the one
  `appintentsmetadataprocessor` "Metadata extraction skipped" toolchain line as the expected
  warning; it did **not** appear in this run, so the count is 0 and not 1.
  `ls ~/Library/Logs/DiagnosticReports/ | grep -c "^PWUsage-"` is **0**. `generate.sh` left no
  tracked change. The §5.12 `373 tests in 21 suites` figures are time-scoped to that commit
  and have since grown with the tests later commits added.

- D1: Ruling: §8.18's product decision is a **blank** battery (`battery.0percent`, no
  `.bolt`, `.secondary` tint) rather than a one-line guard, and the precedent is the
  TRMNL renderer rather than taste. All three of `components.ts`'s battery renderers
  compute `level = soc == null ? 0` and then `fillWidth = (level / 100) * 18`, so an
  e-ink dashboard already renders `--` beside an *empty* battery and never a full one.
  That also dissolves the standing objection that a 0% glyph asserts a value: the blank
  fill says *no fill* and the adjacent text carries the meaning, which is how TRMNL
  distinguishes `0` from `--`. A provenance enum was considered and rejected —
  `validatedStateOfCharge` collapses four distinct no-reading reasons into one `nil`, and
  a new wire type would exist only to separate cases the display treats identically. The
  Action's suggestion to pass the discharging-with-unknown-charge distinction in as a
  separate input was declined: a second glyph for "no reading while discharging"
  re-introduces the same ambiguity in the other direction. Cost if wrong: an unknown
  charge draws a blank battery where a reader expected something more legible, and the
  rendered spacing beside the `--` is still unverified on screen (the device check
  §8.18 records as owed could not be discharged without a real sign-in).
- D2: Ruling: §5.6 is `WON'T FIX`, not fixed. The mechanism is real — each array is a
  separate sequential request, so the key sets come from different wall-clock times and
  can differ — but the audit's own confidence note says the divergence is inferred from
  Solcast's contract and **never observed**, the requests are seconds apart on a fixed
  epoch grid, and the `Action` lands in the energy and cost math. Speculative
  re-weighting logic written against an unobserved trigger is worse than a known sharp
  edge. Recorded with a reopen condition: a device observed returning
  `incompleteCoverage` for a reason other than a genuinely empty array re-opens it. Cost
  if wrong: on a device that *does* hit the trigger, a whole day's forecast renders as
  "An array returned no usable forecast" until someone reads this ruling and writes the
  fix.
- D3: Ruling: §5.7 splits rather than landing as one commit. Part (a), a backwards clock
  silently stopping *all* polling, is a one-line boolean and lands here. Part (b), a
  backwards clock making any forecast age look fresh, is a missing bound and lands here.
  Part (c), anchoring cadence to `ContinuousClock`, is structural and is **re-filed as a
  new §3.16** rather than deferred as a note, because the no-renumbering rule makes
  `§5.7` the stable handle for "device-clock trust" and part (c) would otherwise be lost
  behind a `FIXED` status on a partially-fixed finding. (c) is the same `lastAttempt`
  bookkeeping as §3.7, and the two belong together: a monotonic clock is what makes
  §3.7's "stamp after the request" rule meaningful. Cost if wrong: a user who moves the
  clock still causes one spurious poll per interval, and the cadence model stays on
  `Date` — a latent defect, not a visible one, until the clock is moved again.
- D4: Ruling: §5.5's `Action` was self-defeating and is not followed literally. It says
  "on a persist failure, keep the in-memory cache, **mark the scope failed**, and surface
  a distinct 'could not save' state" — but `isRecommendationUsable` gates on
  `!state.failedScopes.contains(scope)`, so marking the scope failed hides the very cache
  the same sentence says to keep, dropping the enhancement back to `failedWithBasic`: the
  bug's visible outcome, reached by a different route. A save failure is therefore not an
  unavailability; the forecast stays on screen with its own note, and a new
  `SolarForecastRefreshFailure.saveFailed` keeps it out of `SolarForecastUnavailableCause`
  (whose every message is prefixed "Solar forecast unavailable — using tariff and balance
  data", false here). The audit's instruction to mark the scope failed is recorded as
  wrong. Cost if wrong: a save failure is visible to the user but the in-memory batch is
  served without quarantine ever being consulted, so a genuinely bad credential that also
  cannot be written to disk would be retried rather than disabled.
- D5: Ruling: §5.8 needs **no** counter and — re-derived before any code was written —
  needs **no eviction either**. The audit's "evict the cache entry and refetch once"
  implies a failure counter, which `validating` cannot hold because it is a pure function;
  no counter is needed, because a re-validation failure is part of the cache-hit
  *condition*, so control flow falls through to the fetch and a successful refetch
  overwrites the entry. The experiment (`revalidationFailureInsideTheLifetimeRefetchesAndReplaces`)
  was run first, unmodified, and it passed, so the eviction was skipped and the experiment
  kept as a regression test. The audit's second instruction, to widen the allowance "to
  match the live contract's tolerance", is corrected: the live contract has **zero**
  negative tolerance, which is stricter, not more lenient. The two cases are not
  comparable — a future-stamped SoC *reading* is suspect data, while `asOf` is a *server*
  timestamp whose "future" is a statement about the local clock — so `asOf` gets its own
  named `maximumNegativeAgeSkew` of one hour, deliberately asymmetric with the 24h
  positive bound. Cost if wrong: a device whose clock is behind the server gets up to an hour of
  mis-measured `asOf` freshness instead of a permanently broken feature that blames the
  server; and if the cache ever stops self-healing, the retained test fails loudly rather
  than silently.
- D6: Ruling: §2 quick win #1 and §9.4 are wrong as audited, so only the **view** call
  sites were deleted and both methods and all three tests were kept. The audit and §9.4
  both propose deleting `solarForecastSettingsDidEdit()` and `loadProfileDidEdit()` as
  dead code. `SolarForecastCoordinatorTests` calls them **mid-flight** as a
  synchronization seam, in three tests named for the invariant they protect; the
  emptiness *is* the contract under test, and deleting the methods deletes three
  regression tests. Five view call sites go (four in the settings sheet, one in
  `LoadTimingView`); three of those were whole `.onChange` bodies, so the wrappers went
  with them and the modifier lists stayed intact. §9.4 stays `OPEN` for the method half
  only and carries a note so this is not filed a third time. Cost if wrong: a future edit
  that gave these methods real invalidation work would land without the three tripwire
  tests noticing, and this branch's own earlier reasoning had already shown how easy that
  is to get wrong.
- D7: Ruling: **the spec was wrong, and item 2 was implemented rather than struck.** D7
  claimed the no-op `do { … } catch { throw error }` in `perform(_:)` was "already fixed
  by §6.2", on two premises, both false. (i) It was not already fixed: the wrapper was
  still in `perform(_:)` at `PWUsage/Networking/PWUsageAPI.swift:109-110` at the start of
  this branch, so the audit's citation was exactly right and only the reasoning written
  around it was wrong. (ii) No prior finding could have removed it: `perform(_:)` had not
  been edited since the Solcast commit `c05947b`, and this branch's own preceding commit
  `fcabe56` edited the same file only for `fetchSites` and the consolidated conformances.
  The `catch let error as …ContractError` / `catch { throw …invalidResponse }` pairs
  D7's reasoning pointed at are the `fetchLive` (`:50-51`) and `fetchBill` (`:59-60`)
  decodes: real error mapping, not this item, and predating the branch. `03c41d5` removes
  the wrapper, collapsing the declaration to a single `session.data(for:)` call. A
  rethrow is the identity, so no behaviour changed and **no test was added** —
  `PWUsageAPITests` covers the request path, and a test distinguishing a `rethrow` from
  no `rethrow` could only assert the compiler. Cost if wrong: two lines of dead code
  survive in the transport, and the standing risk was never the code — it was the
  precedent, because a design document had already recorded a specific line number as
  fixed when it was not, and a later reader inheriting that document would have skipped
  the item a second time.
- Commit count: Ruling: the branch carries **ten** commits, not the seven the spec's table
  lists, and the three extra ones each have a reason recorded here rather than being left
  as unexplained count drift. `8c44dc9` (three pre-existing test-target warnings) was added
  because the branch's own ground rule is zero warnings but the gate the plan measures
  builds the app target only, so every test run reported a non-pristine build; two of the
  three were dead code and were deleted, and the third was live intent whose binding is now
  read. `3a367bb` was split out of `089e3b0` because §5.7(b) suppressed the forecast panel
  but left the panel's own accurate string "Source time is in the future" replaced by the
  generic "too old or incomplete" fallback — two false claims shown to the user, which the
  a+b commit did not notice and which needed its own test. `03c41d5` is §2 item 2, which the
  spec struck and D7 above reinstates. Cost if wrong: a reader reconciling the branch
  against the spec's seven-commit table finds three commits with no entry, which is the
  failure mode this ledger exists to prevent; the reverse error, folding them into their
  neighbours, would hide that a test-target warning was a behavioural trap rather than
  dead code, and that a user-visible string was wrong.

## Whole-branch review pass (`6ddea83`..HEAD)

Seven findings, all of them the same shape: a fix or a claim that was correct
in isolation and wrong in company. Ten task-scoped reviews each had no reason
to look for them, because each lives in the seam between two correct commits.

- [x] `672dec4` fix(ios): close the two destructive save-failure paths 5.5 left open
- [x] `aa88d26` fix(ios): keep the promise the save-failure note makes
- [x] `e64c052` test(ios): remove the last two try! from the preview fixtures
- [x] `cb5e5f7` fix(ios): close the load-timing staleness site 5.7's survey missed
- [x] This commit — docs and ledger corrections.
- Review: Ruling: §5.5's fix is **complete only once both refresh paths agree**, and they did not
  until this pass. `refreshSolarForecast(manual:)` learned that a save failure is not an
  unavailability; `loadTimingDetailAppeared` never did, so it failed its guard, niled the batch
  and rendered "The forecast was too old or incomplete to use" after a *successful* fetch of a
  brand-new forecast — the exact symptom the finding exists to remove, through the door the first
  fix left unlocked, and on the *dominant* path rather than the exception. Both budget saves also
  escalated a write failure to `persistFailureState`, whose own failing write deletes the
  Keychain item; the one in `discoverSites` is the first-run path, so two failed writes destroyed
  the key the user had just typed. Cost if wrong: a working Solcast key is still destroyable by a
  disk failure, which is the one outcome §5.5 exists to make impossible, and the false "too old"
  note is back on every screen open.
- Review: Ruling: on the two budget saves the scope is still marked failed, unlike the post-fetch
  save, and that asymmetry is deliberate. An unpersisted *budget* means the daily request
  allowance cannot be enforced across a relaunch, so failing closed is the honest direction;
  `reservationPersistenceFailureDisablesCache` pins it and passes unmodified. Dropping the
  escalation while rewriting that test was available and was rejected: widening quarantine is not
  the point, and a tripwire rewrite is exactly what §5.12 warns against. Cost if wrong: a device
  with a transient disk fault shows no forecast recommendation until the next successful refresh
  clears the marking — conservative, visible, and self-healing.
- Review: Ruling: the save-failure note's promise is **kept, not withdrawn**. The alternative —
  delete "It will be retried on the next refresh" — was rejected because the promise was the
  honest description of what the user should expect, and the defect was that nothing implemented
  it. A `dirtyScopes` set now records a write left pending and the `.alreadyFresh` short-circuit
  attempts it, returning `.refreshed` on success and `.failed(.saveFailed)` on failure. The retry
  is a file write only: no request is charged, no Solcast call is made, and it cannot spin,
  because a failed retry returns without refetching so the cache is not re-stamped. Cost if wrong:
  a permanently failing disk is written to once per refresh call instead of not at all — a small,
  bounded cost against a warning that would otherwise lie.
- Review: Ruling: the preview fixtures' `try!` pair is fixed by **decoding inside the two
  `fetch` methods rather than by making `init` throwing**. Both were available. A throwing `init`
  would have forced `try` into all nine construction sites — four of them inside `#Preview` bodies
  with nowhere sensible to handle it — and would have made a preview that cannot be constructed
  fail to render at all. Decoding in the already-`throws` fetches puts the failure on the one call
  that needed the value and hands the caller the `DecodingError`. Cost if wrong: the JSON is held
  rather than the decoded value, so each `fetch` re-decodes — irrelevant for a preview, and the
  trade is invisible if the API is ever used in a hot path.
- Review: Ruling: §5.7's title says "**All** cadence and staleness decisions", which is a
  completeness claim, so the survey is written into the finding and is checkable rather than
  asserted. Eleven sites make an age decision and all eleven now handle a negative age. Verifying
  it turned up two things the review that prompted it had wrong: the estimator's balance guard is
  split across two lines (so grepping the staleness line for `>= 0` finds nothing and the site
  reads as unguarded), and `chargeAgeLabel` has the same upper-bound-only shape and is provably
  *not* a defect — a negative age returns `nil`, which is correct, and widening it would
  *introduce* the bug. Cost if wrong: a future reader trusts the survey instead of redoing it,
  and either opens a non-bug or misses the next one; the survey is a floor, not a substitute for
  looking.
- Review: Ruling: §5.8's skew direction was **wrong in the wrong direction to be harmless**.
  `sourceAge` compares the server's `asOf` to the *device's* clock, so `asOf` looks future-dated
  only when the device is **behind**; a fast clock was never in the affected population. The
  reasoning and the code were always right, and the error is inherited from the pre-branch audit.
  Corrected in this ledger, the code comment, the test name, and both the plan and the design
  after a claim-grep found eight further instances the review had not listed. Cost if wrong: a
  user with a fast clock reads §5.8, sees their own symptom described as fixed, and never learns
  the real cause is the opposite one — the most expensive kind of wrong prose, because it is
  indistinguishable from being helped. The landed commit subject still says "fast" and cannot be
  corrected without rewriting the branch; that is recorded rather than silently left.
- Review: Ruling: §8.18's `Fix:` bullet is corrected on **what the precedent does**, and the
  product decision is not reversed. The blank fill matches all three TRMNL renderers and the web
  tile; the direction glyph does not — TRMNL picks `CHARGING_ICON`/`DISCHARGING_ICON` from the
  `status` argument alone and emits it regardless of `soc`, and the web tile does the same, while
  iOS folds direction into the glyph name. The previous wording claimed TRMNL "is always neutral"
  and that a bolt "asserts flow the blank fill denies", conflating level with direction. Cost if
  wrong: a reader deciding this later is misled about the precedent, which is the one input the
  decision actually rests on; the choice itself survives either way, and the tint change does not
  depend on the precedent at all.

## Notes

- Sol coordinates; Luna implements one bounded task at a time.
- Native tests run only through `cmd/ios-app/run-tests.sh`, sequentially.
- No live Solcast quota use in automated verification.
- Solcast keys/resource IDs/forecasts remain device-local.
