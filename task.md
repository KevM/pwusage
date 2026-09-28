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
- [ ] Task 7: Integration verification and handoff.

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
unit.
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

## Notes

- Sol coordinates; Luna implements one bounded task at a time.
- Native tests run only through `cmd/ios-app/run-tests.sh`, sequentially.
- No live Solcast quota use in automated verification.
- Solcast keys/resource IDs/forecasts remain device-local.
