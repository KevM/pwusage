# Reserve synchronization on hold start (2026-10-02)

- [x] Trace start reads and reproduce a recently restored hold's stale Tesla reserve in regression tests.
- [x] Validate the original reserve before commands and guard a one-minute start settling window, as requested.
- [x] Expose a recoverable reserve-sync message in native and web controls.
- [x] Review the guard and document its bounded cache-freshness limitation.
- [x] Verify web tests (978 passed, one existing skip), lint and build.
- [x] Verify full native tests (448 passed), including preview scene startup, and commit/push the draft PR update.

# Compact Battery Hold control and beta deployment (2026-10-02)

- [x] Replace toolbar text with a battery/lock badge and confirmed hold-reserve percentage.
- [x] Keep an explicit accessible Battery Hold controls label; hide stale percentages.
- [x] Resolve the main-branch conflict preventing PR workflows from running.
- [x] Verify merged web tests (964 passed, one existing skip), lint and production build.
- [x] Verify native tests (447 passed) and toolbar renders.
- [ ] Push the draft update and verify beta deployment.

# Battery hold clarity and monitoring (2026-10-02)

- [x] Finish approved toolbar and stop-action wording; remove permanent refresh button.
- [x] Automatically recover missing charge data on sheet entry and retain Try Again/pull-to-refresh.
- [x] Persist actual cron monitoring with estimated excess kW, reading age and next scheduled check.
- [x] Add optional native monitoring decoding, status copy and countdown/overdue behavior.
- [x] Validate migration and monitoring round trip in an isolated local PostgreSQL database.
- [x] Verify web tests (949 passed, one existing skip), lint and production build.
- [x] Verify full native suite (445 tests), review final previews and commit.

Deployment note: server migration and deployment are needed for beta monitoring;
rebuild the native app for toolbar/sheet wording. Existing holds receive telemetry
at their next cron check. No real Tesla commands were sent during verification.

# Native iOS battery hold (2026-10-02)

- [x] Review the website flow and approve the native toolbar/sheet design.
- [x] Record the design and implementation plan.
- [x] Implement typed hold contracts and authenticated GET/POST transport.
- [x] Add coordinator state, stale-status guards and site/session invalidation.
- [x] Build native hold controls, restore confirmation, notices and reconnect.
- [x] Verify previews, the full native suite, and web lint/build/tests (443 native tests; 942 web tests, one existing skip).
- [x] Review the implementation and correct the manual-restore confirmation.
- [x] Commit the verified implementation.

# Database reduction planning (2026-10-01)

- [x] Inspect retention, inactive-user handling, production-to-dev restore, and relevant design decisions.
- [x] Run read-only production and dev size, row-count, index, and job-history audits.
- [x] Agree on retained history and downgrade grace; inactive-user cleanup is separate.
- [x] Compare approaches; choose 90/365-day detailed history without summaries in the first version.
- [ ] Identify the provider and billing window for reported 50% log-ingestion usage; include source breakdown, growth forecast, and alert thresholds in the capacity plan.
- [x] Review and approve the design; save the agreed design in docs/plans.
- [x] Prepare the implementation plan after design approval.

Retention decisions from the user: default accounts retain 90 days of detailed
energy history; premium accounts retain one year. Extended history is assigned manually through an internal setting/script. The
user deferred premium-tier UX and monetization, including new admin screens.
The 30-day downgrade grace and design are approved; all tariff versions, seasons,
and schedules must remain permanent. Design and implementation plan are saved
under docs/plans/2026-10-01-tiered-history-retention*.md. Retention must be enforced on historical imports as
well as cleanup; current sync/import/analysis routes can request older windows.

Audit snapshot (decimal MB, current database only): production 289.1 MB;
dev 535.5 MB. Production EnergyData is 264.9 MB, including 164.7 MB of
indexes, with 836,586 rows. Revoked users own 69,146 of those rows.
There are 22 users with readings in the last seven days (user's estimate: 18).
Dev cron.job_run_details occupies 253.6 MB and contains 171,613 rows;
dev EnergyData occupies 251.9 MB. Two sites are named Harrison, but only
site 2252268092126997 has readings (52,167). Existing cleanup defaults to
365 days; the prod-to-dev workflow copies all production data.
Measurements are a moving snapshot, not reclaimed-size guarantees.
No application changes or database mutations were made during this audit.

Follow-up scheduled-job comparison: prod has only restore-reserve-trigger
(every 15 minutes). Dev also has rollup-trigger (hourly) and
index-history-trigger (every minute). Both projects have cron.log_run and
cron.log_statement enabled. Dev's current index-history job accounts for
150,961 runs, including 132,372 failures, and about 111.3 MB of repeated
command text. Production has 12,194 history records for its sole job.

Approved dev cleanup executed on 2026-10-01: unscheduled rollup-trigger
and index-history-trigger, then truncated cron.job_run_details. Dev database
fell from 535,547,027 to 281,947,283 bytes; job-history allocation fell to
16,384 bytes. restore-reserve-trigger remains active every 15 minutes.
No production data or jobs were changed. After CLI authentication, Supabase's
configuration API rejected cron.log_run as an unrecognized key. Recording
therefore remains enabled. To prevent renewed buildup without restarting dev,
installed dev-job-history-cleanup at 03:07 UTC daily, with command
TRUNCATE TABLE cron.job_run_details. Executed the same cleanup successfully.
This clears history and releases its table allocation every day; it does not
disable recording or erase log-ingestion usage already counted.
Premium/default energy retention and dev data filtering remain separate,
unimplemented planning work.

Planning verification: lint passed; 942 unit tests passed with one skipped;
production build passed. No retention application code or migrations were changed.

Egress intersection reviewed after user notice: PR #125 landed as e9ca3f24
on 2026-10-01 and is present in origin/main, but not this planning checkout.
Plans now require that base and preserve getDailyCoverage's per-day summaries.
Retention clamps must precede both ensureDataForRange and auditRange coverage
queries/planning; expired windows must terminate rather than trigger repair/retry
loops. Add compact request-reused entitlement reads, coverage/query-count tests,
and the real-Postgres differential gate if coverage SQL changes. SQL aggregation
reduces returned data, not the stored EnergyData footprint.

Initial rollout clarified and approved: existing users currently have 365-day
retention and must receive notice plus 30 days before trimming to 90. New users
start at 90 days. Explicitly initialize existing-account grace; a migration that
defaults their setting to 90 must not bypass the transition. Manual 365-day
exceptions remain. Notification delivery and destructive production rollout
require their own concrete review/authorization; neither has happened here.

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
  with `grep -c "warning:"` = **1** on a clean build. The single hit is the
  `appintentsmetadataprocessor` "Metadata extraction skipped" toolchain line that
  `CODE_AUDIT.md`'s header documents as the sole permitted exemption. An
  incremental build may report **0** because the metadata processor does not
  re-run; that is a DerivedData artifact, not a stricter result, and both figures
  have been measured on this branch.
  `generate.sh` left no
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
- [x] docs(ios): correct the ledger, the plan and the design after the review — the second review pass's citation and claim corrections
- [x] fix(ios): report a failed budget write as a save failure, not a network one — the second review pass's Finding 1
- [x] docs(ios): re-derive the citations the budget fix moved and make the warning gate durable
- The three commits above are **named by subject and not by SHA**, where every other entry in this list carries one. They were rewritten after they landed, so a SHA recorded here would be dead on arrival — and the repo's own rule already says to subject-identify a commit rather than cite it, precisely because forward references break on every amend. The rewrite was not cosmetic: the commit carrying the §5.5 behaviour change did not carry its own reversal. `CODE_AUDIT.md` and this file went on asserting, for one commit, that the two budget saves still mark the scope failed and that `reservationPersistenceFailureDisablesCache` pins it, while the code in the same commit had already stopped marking it and had renamed the test. That is the exact defect `CODE_AUDIT.md:3` exists to prevent — a ledger correction batched into a later commit instead of made alongside the fix — and it was invisible precisely because the three commits were the branch tip. Nothing was pushed, so the rewrite was free; after it, no commit in the branch asserts a behaviour its own code contradicts.
- One of the three had its **commit message rebuilt in place** before the rewrite, after it was found to claim a re-record of the zero-warning figure that its own diff did not contain — the same shape as the spec's struck item 2. It now names the omission and points at the commit that fixed it. All three were then rewritten together so that the §5.5 reversal rides with the commit that made it necessary.
- **Two of those three commit messages carry claims their own diffs do not, and they are now immutable.**
  They would need another rebase of the tip to correct, so — for the same reason and in the same
  spirit as `3a7a98d`'s subject above — they are recorded here rather than left for the next reader
  to discover. Neither is a behavioural defect; both are the D7 shape (a message asserting a
  correction its diff does not contain), and neither was caught by the round-3 re-review.
  - **`1efd8c8` (`docs(ios): correct the ledger, the plan and the design after the review`).** Its
    message says *"Three of its five ranges ended on the wrong line and a fourth was off by one"*,
    about §9.8's ranges. **False in both readings, and both readings are checkable.** At its *own*
    tree — where `SolarForecastStore.swift` is 740 lines and byte-identical to its parent's — three
    of the five ranges are **exact** (`82-683`, `687-732`, `735-740`) and only the two function
    ranges in `Why:` are wrong, ending at `:267` where `discoverSites` ends at `:281` (off by
    **14**) and at `:487` where `performRefresh` ends at `:507` (off by **20**). At its *parent*
    `cb5e5f7` all **five** ranges existed and **all five ends** were wrong — by 80, 80, 80, 25 and
    67 lines — and **none** was off by one. The "three and a fourth" reading matches neither. The
    same message then says the heading *"had been softened from '660-line' to '600+-line'";* its own
    diff did the **opposite**, replacing the parent's `660-line actor` with `740-line file whose
    602-line actor`. The `600+` heading it describes existed only in the pre-rebase chain, and the
    rebase substituted the value underneath a narrative it carried forward — §9.8's `Why:` is
    corrected on that point, and the ledger's claim that the tree it sits in was ever vaguer is
    withdrawn.
  - **`05f9ceb` (`docs(ios): re-derive the citations the budget fix moved and make the warning gate
    durable`).** Its message says *"9.8's Location pointed at the actor's conformance extension
    rather than the actor."* **False.** `82-683` starts exactly at `actor SolarForecastStore` and
    ends **24 lines inside** it: the actor runs to `:707`, and the conformance extension is at
    `:709`, which the range never touches. Its companion claim — that `Why:` pointed into two
    functions rather than their ends — is **correct**: `223-267` and `425-487` both fall inside
    `discoverSites` (`226-284`) and `performRefresh` (`428-521`). One of a message's two claims is
    enough to mislead a reader checking the other, which is why both are recorded rather than only
    the one that reads well.
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
  **REVERSED in the branch's second review pass — this ruling was wrong on the merits, and the
  test it leaned on turned out to encode the wrong behaviour rather than guard a right one.** The
  argument's premise was its own undoing: the disk that would have recorded the budget is the
  disk that just failed, so `failedScopes` is not persisted either and the marking is
  session-only. It delivered none of the cross-relaunch protection it was cited for, while
  `isRecommendationUsable` gating on it hid a good forecast for the rest of the session, and a
  disk fault surfaced to the user as "Solcast could not be reached". Both budget saves now
  return `.failed(.saveFailed)` and mark nothing, and the test was rewritten to pin that.
  The tripwire rule was misapplied the first time and correctly *not* applied the second: it
  protects correct behaviour, and that assertion was the behaviour under review. Cost if wrong:
  on a device whose disk is failing, the on-disk request counter can drift by every reservation
  made since the last successful write — bounded and self-correcting, and the same class of
  staleness as losing the whole cache — against which a working forecast is always shown.
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

## Rebase onto `main` (PR #117 landed first)

`main` moved two commits while this branch was open — most importantly **PR #117, "close the 17
highest-severity audit findings"**, which is the **squash of this branch's own first 13 commits**.
So a plain `git rebase origin/main` tried to replay 31 commits and conflicted on files it was
re-adding. The correct target was `git rebase --onto origin/main 19ce8bf`: replay only the 18
correctness-tail commits, since #117 already delivered the 13 below them.

Two real conflicts, and one collision that no tool could resolve:

1. **`PWUsageAppModelTests.swift`** — #117 added `supersededBootstrapAttemptCannotOverwriteNewerState`
   *and* a `try!` config stub; this branch had already converted that stub to a throwing factory for
   §5.12. Resolved by keeping #117's test and this branch's helper. That left the new call site
   missing `try`, caught by `./run-tests.sh` and fixed in its own commit.
2. **`CODE_AUDIT.md` §3.15** — **both branches independently filed §3.15 for different findings.**
   `main`'s is overlapping-bootstrap ordering (`FIXED`, from #117); this branch's was
   `ContinuousClock` cadence anchoring (`OPEN`, re-filed from §5.7 part (c)). The ledger forbids
   renumbering, so the collision is real. Resolved by renumbering **this branch's** finding to
   **§3.16**, because `main`'s is already merged and cited by other documents while ours had never
   left the branch — which is exactly the case the no-renumbering rule protects. An HTML comment
   above §3.16 records the provenance, and all 13 references in the plan, spec and this file were
   updated.

One of the discarded conflict sides also carried a round-3 citation fix
(`LoadTimingForecastPresentation.swift:83-89` → `:95-102`) that was **not** re-applied automatically.
Caught by spot-checking rather than by a test, which is the fourth time on this branch that a
mechanical merge step dropped a correction that no assertion covered.

**Merged state:** 77 findings (76 from `main` + §3.16), 52 `OPEN` / 24 `FIXED` / 1 `WON'T FIX`.
Suite is **394 tests in 21 suites** (390 here + 4 from #117), clean build with the one permitted
`appintentsmetadataprocessor` warning, 0 crash reports. Every cited SHA resolves.

## Second merge: PR #119 landed mid-PR

`main` moved again while PR #120 was open — **PR #119, "show live power supply and receive roles"**,
which relocates `batterySymbol` from `DashboardView` into `DashboardPresentation` and replaces the
four-tile `adaptiveGrid` with `LivePowerFlowCards`. Rather than rebase (which would replay 18 commits
and force the §3.15 collision to be resolved a second time), this was a **merge**, so the 20 already-pushed
SHAs and PR #120's history stayed valid and the conflict was resolved once in its final state.

One file conflicted, `DashboardView.swift`, in three hunks, and the two sides were **both** needed:

- The hero `Image(systemName:)` call — took #119's `livePowerIsCurrent` guard, which stops a stale power
  value from producing a wrong direction glyph, routed through **this** branch's §8.18
  `DashboardPresentation.batterySymbol` (the `guard let stateOfCharge else { return "battery.0percent" }`).
- The tile grid — #119's `LivePowerFlowCards` won; the old `adaptiveGrid` is gone.
- The two private helpers — **both became dead**. `batterySymbol` had moved to `DashboardPresentation`
  in §8.18's fix, and `gridDirection`'s only caller was a `MetricTile` in the grid #119 replaced. Both
  deleted rather than kept, since keeping unreachable code is what §9.8 is about.

### What the merge staled, and one error it exposed that predates it

PR #119 shifted line numbers in `DashboardView.swift`, so the citations this branch had re-derived
four times went stale *again*. Caught by re-deriving rather than by any test — the fifth time on this
branch that a mechanical step has dropped something no assertion covered. Fixed: §8.18's `Location`
and `Confidence`, §5.7's survey, §5.4's hero block, §5.9's `Location`.

§5.9's was a **pre-existing error the merge made visible**: it cited
`DashboardView.swift:306-319 (batterySymbol)`, but that range held `gridDirection` even *before* #119 —
`batterySymbol` had already moved to `DashboardPresentation` when §8.18's fix relocated it. A citation
that survived four rounds of review because nobody re-read it against a tree that had shifted under a
*different* commit than the one that broke it.

**Merged state:** 402 tests in 22 suites (394 + 8 from #119, including its new `LivePowerFlowLayoutTests`
suite), clean build with the one permitted `appintestsmetadataprocessor` warning, 0 crash reports.

## PR #120 review: clock advice shown for errors no clock can fix

One `P2` comment on `LoadTimingForecastPresentation.swift:268`, and it was correct.

§5.8's fix had made the `.contextInvalid` note point at the device's own date and time, which is
the right advice for `asOf` skew. But nothing enforced that the failure *was* skew: `validating`
checked the age bounds inside the same large `invalidSource` guard as units, timezone, history
bounds and slot validity, and the coordinator mapped every `ContractError` to `.contextInvalid`. So
an unsupported version, a site mismatch, wrong units or malformed history all produced "check this
device's date and time" — advice that cannot possibly help, for a cause the evidence does not
support. A user's fix attempt would fail, and the next failure would be further from the truth.

Split into `ContractError.timestampSkew` versus `invalidSource`, mapped to `.contextInvalid` versus a
new `.contextMalformed`, whose note says only that the payload could not be read and to retry.

Two notes on how this was verified. The new tests were checked against a reverted one-line
discrimination and three assertions fail, so they pin behaviour rather than the existence of a new
enum case — a review pattern that has already earned its place on this branch (the `try` lost in a
conflict, a discarded rebase side). And `contractRejectionIsReportedDistinctly` was retargeted to
`.contextMalformed` instead of deleted: its purpose was "distinct from a missing profile", which
still holds, and keeping it preserves the malformed-payload coverage this PR had before the split.

**Gates:** 405 tests in 22 suites (402 + 3), clean build with the one permitted warning, 0 crashes.


# Bill calculation seasonal netting

- [x] Reproduce Harrison's surplus/charge discrepancy with failing calculation tests.
- [x] User confirmed seasonal boundaries do not settle the billing energy bucket.
- [x] Fix cycle-wide netting consistently for web, mobile, and TRMNL.
- [x] Review billing tests and add meaningful edge-case coverage; record remaining configuration gap.
- [x] Tests: 1008 passed, one existing skipped; lint and production build passed. Diff reviewed; commit verified changes.

## Compact energy prototype — 2026-10-07

- [x] Record agreed design and implementation plan.
- [x] Add lossless archive, DST/gap/irregular-time and rollup tests.
- [x] Implement bounded Float64 archive codecs and tariff-period rollups.
- [x] Benchmark bounded read-only development samples and synthetic fixtures.
- [x] Record findings and production follow-up work.
- [x] Verify full tests, lint, build; commit.

## Broader sampling and isolated storage validation

- [x] Historical tariff attribution tests and audit.
- [x] Broader bounded read-only sample.
- [x] Private local PostgreSQL storage fixtures and roundtrip validation.
- [x] Record measured storage and investigate anomalies.
- [x] Full tests, lint, build; commit.

## Compact historical reader integration

- [x] Test mixed history, range boundaries, integrity failures and missing data.
- [x] Implement coherent snapshot reader and optional repository dependency.
- [x] Verify downstream billing, chart and analysis parity.
- [x] Record limitations; full tests, lint, build; commit.

## Compact archive persistence and finalization

- [x] Generated migration with RLS and mutation invalidation.
- [x] Local integration tests for finalization, revisions, rollback and concurrency.
- [x] Snapshot store and raw-retaining finalizer.
- [x] Local migration/role verification, review, full checks and commit.

## Compact coverage and summary billing

- [x] Coverage/gap-planner tests and opt-in repository delegates.
- [x] Generated metadata migration and finalizer digest.
- [x] Verified summary-only billing with partial-day fallback.
- [x] Local integration tests, review, full checks and commit.

## Database egress activation gates

- [x] Record limited database egress as an explicit design requirement.
- [x] Remove archive/raw dual reads from normal detailed history queries.
- [ ] Reuse coherent request snapshots and tariff metadata; avoid duplicate range reads.
- [ ] Measure returned database bytes/query counts for charts, bills, coverage, freshness and maintenance.
- [ ] Review transfer costs before activating archive readers in application callers.

## Egress-efficient archive reads

- [x] Separate normal one-source detail reads from explicit verification reads.
- [x] Avoid partial-day raw/archive duplication; preserve mutation consistency.
- [x] Reuse a request snapshot for billing and coverage.
- [x] Measure database response bytes/query counts on the local production archive.
- [x] Review, full checks and remove temporary restored data.
- [x] Commit verified egress checkpoint.

Egress checkpoint: five sites / 150 days / 42,605 samples. Daily/monthly chart response bytes fell 79.4% / 83.4%; monthly coverage/billing were within 1% / 3.5% of scalar baselines. Partial-day bill boundaries cost 142% more and remain explicitly documented. Database-native metadata verification avoids transferring full summaries for coverage; independent mandatory verification rejects missing summaries. Review found no remaining actionable issues. Request-scoped tariff reuse, freshness/maintenance measurements and hosted-budget review remain open before activation.

Validation: 1,078 tests passed / one skipped; lint and production build passed. Function execution grants confirmed anon/authenticated denied and service_role allowed. Temporary restored PostgreSQL cluster and extracted data removed; supplied backup zip retained.

## Compact freshness and request reuse

- [x] Scalar latest timestamp across raw and archived sources, legacy fallback and integrity tests.
- [x] Share site/tariff/today inputs for cycle and today totals without changing netting.
- [x] Local transfer bound, review, full checks and cleanup.
- [x] Commit staged freshness and caller integration.

Staged opt-in factory wired into web usage, mobile billing and importer coverage audits. Exact `COMPACT_HISTORY_READS_ENABLED=true` is required; it has not been configured. Disabled/default and injected repository behavior covered. Complete archived coverage plans zero paid imports; corruption stops before any import. Synthetic archived-only freshness transfers under 1,500 backend protocol bytes / two SELECTs even when the selected chart payload exceeds 1,500 bytes. Modern metadata is verified; legacy freshness decodes only its selected day. Cycle/today shares site, historical tariff lookups and raw samples, with independent netting; historical/future/identical/reversed range parity verified.

Validation: 1,094 tests passed / one skipped; lint, type check and production build passed. Independent review found no blocking issues. Disposable synthetic PostgreSQL cluster removed. Live/TRMNL/analysis/setup reader mapping, coverage windows exceeding 366 days, maintenance measurements, bounded repair and verified trimming still gate activation. No PR opened or environment switch enabled.

## Remaining compact history consumers

- [x] Bounded multi-year scalar reads with site-local window boundaries.
- [x] Remaining site reader wiring, retaining disabled default and authorization.
- [x] Historical navigation avoids implicit paid recovery when archive reads are enabled.
- [x] Review, full checks and commit.

Consumer checkpoint: site setup/has-data and usage service, live page, live-data API, TRMNL, analysis and mobile planning now use the site-scoped opt-in factory. Disabled live-data requests preserve parallel query behavior. Multi-year coverage/billing/combined reads use contiguous local-midnight partitions, each <=360 local days, capped at 32 windows before reading; detail remains limited to 366 days. Each window is coherent independently, not one snapshot across all years. Historical/future analysis navigation skips Tesla-client creation and implicit import when enabled; current-day overlap and explicit force preserve existing behavior. Authorization checked before reads.

Validation: 1,111 tests passed / one skipped, including real PostgreSQL multi-year parity; lint and production build passed. Independent review found no blocking issues. Synthetic cluster removed. No switch configured, PR opened, Tesla requests made or production changes performed. Remaining gates: stale latest-power/SOC behavior at archive/buffer boundaries, replacement of legacy destructive cleanup (including preserving useful LoadTags), bounded maintenance/repair cost, verified trimming, backup/restore and activation review.

## Compact boundary freshness and cleanup safety

- [x] Checksummed latest sample / SOC projection and generated migration.
- [x] Repository delegates, archive/raw selection, as-of/null/staleness and corruption tests.
- [x] Scalar transfer bounds and finalization retry integrity.
- [x] Legacy cleanup skips destructive energy/tag removal in compact mode or once archives exist, with first-finalization race protection.
- [x] Review, full checks, local cleanup and commit.

Boundary checkpoint: latest power/last-known charge projections have independent CEL1 integrity checks and preserve original freshness timestamps. Modern power/charge reads stay below 3,000 synthetic backend protocol bytes (two/three SELECTs); legacy charge projections require rebuild before activation. As-of regression rejects reliance on unverified coverage timestamps. Cleanup uses an exclusive maintenance claim across archive detection and atomic energy/tag deletion; finalization takes the matching shared claim before its site claim. Busy claims skip safely, archive presence prevents cleanup after read-switch rollback, and empty-history legacy behavior remains covered.

Validation: 1,127 tests passed / one skipped; lint and production build passed. Independent review found no remaining actionable issues after fixing the as-of filter and first-finalization race. Synthetic cluster removed; supplied production backup zip retained. No PR, switch activation, deployment, production connection or Tesla request. Remaining gates: bounded rollup/repair runner, maintenance egress and updated storage measurement, archive-preserving trim protocol, historical tag policy, recovery rehearsal and activation review.

## Compact staged PR readiness

- [x] Bounded site-scoped scalar maintenance preview and raw-retaining apply/rebuild.
- [x] Existing gap audit reuse, strict limits, editable buffer and resumable reports.
- [x] Maintenance transfer and updated allocation on local production archive.
- [x] Whole-branch independent review and resolve findings.
- [x] Full tests/lint/build, fixture removal and commit.
- [x] Local draft PR description and concrete rollout gates; no PR opened.

Readiness: bounded site/date CLI previews scalar coverage, verifies compressed payload plus metadata inside PostgreSQL, finalizes at most seven days per invocation and reports resulting billing attribution and remaining dates. Two recent completed days are held; a 45-second soft budget is checked between days. Explicit rebuild uses retained raw data; no Tesla repair, automatic cron, raw pruning or tag removal is activated.

All five migrations applied to an isolated October 2 backup fixture. Three-site/90-day maintenance sample: 3,359 response bytes per initial 30-day preview, 4,800 per completed repeat, about 32.2 KB/day first rollup; current archive+summary allocation projects 2.19 MB/site/year. Separate 30-site parity validation recovered 20,256 samples across 77 days exactly; one attribution-incomplete day stayed explicit. Raw counts retained. Reports and limitations are in the maintenance operating guide.

Validation: 1,148 tests passed / one existing skip, lint and build passed. Whole-branch independent reviews found no blockers; fetched origin/main is already included. Disposable source fixture removed and backup zip retained. Local draft PR description prepared; no PR opened. Ready for a raw-retaining staged draft PR. Operational storage reclamation still requires correction-safe trimming/recovery, recent raw-only consumer coverage, paid repair budgets, fresh backup/restore rehearsal and explicit first-trim approval.

## Compact trim and recovery primitives

- [x] Generated pruning marker and database write/timezone guards.
- [x] Reviewed-revision trim with full parity/integrity and recent-day buffer checks.
- [x] Lossless bounded restoration and atomic partial late writes.
- [x] Finalization and maintenance preserve authoritative pruned sources.
- [x] Opt-in repository delegation with default behavior retained.
- [x] Integrity/concurrency/rollback/egress tests, independent review and full checks.
- [x] Document remaining operator/rollback/backup gates, remove fixtures and commit.

Validation: 1,166 tests passed / one existing skip; lint and production build passed. Independent persistence review found no blockers after the partial-source finalization fix and scalar parity optimization. All six migrations applied to the isolated source-table backup fixture. Ten selected days / 2,859 samples passed exact trim/read/restoration and partial-correction checks; response transfer averaged 6.8 KB/day for trim and restore. Disposable fixture removed, backup zip retained. No PR, production connection, Tesla request, deployment or activation. Ready for a staged draft PR; remaining production gates include an operator trim workflow, recent raw-only consumer review, paid repair budgets, fresh recoverable backup/full restore rehearsal and explicit first-trim approval.

## Compact flag-on Dev timeout repair

Harrison's site and live-data requests hit Dev's 10-second runtime limit after enabling compact reads. A mixed monthly read performed 31,684 timezone conversions for 6,336 raw samples; projected overlap checks recomputed local midnight per sample and summary. Precompute validated scalar/coverage day bounds and reuse sorted sample day boundaries during rollup. Regression retains exact totals and bounds conversions below 100. All 1,167 tests passed / one existing skip, lint and build passed; independent reader review found no blockers. Dev billing read measured about 0.8 seconds after the change versus about 5 seconds before. Flag remains scoped to this PR preview; raw samples retained. Deployment/page verification follows.
