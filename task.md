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

## Notes

- Sol coordinates; Luna implements one bounded task at a time.
- Native tests run only through `cmd/ios-app/run-tests.sh`, sequentially.
- No live Solcast quota use in automated verification.
- Solcast keys/resource IDs/forecasts remain device-local.
