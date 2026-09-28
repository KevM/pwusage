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

## Notes

- Sol coordinates; Luna implements one bounded task at a time.
- Native tests run only through `cmd/ios-app/run-tests.sh`, sequentially.
- No live Solcast quota use in automated verification.
- Solcast keys/resource IDs/forecasts remain device-local.
