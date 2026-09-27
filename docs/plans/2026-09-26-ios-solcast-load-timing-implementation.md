# iOS Solcast Load Timing Implementation Plan

> **For Sol (coordinator) and Luna (implementer):** Use `superpowers:executing-plans` to execute this plan task-by-task in a separate session. The user explicitly requested Luna implementation coordinated by Sol. Do not start implementation in the planning chat.

**Goal:** Recommend the lowest estimated cost start time for a selected iOS load using device-local Solcast forecasts, with estimated solar contribution and a reliable existing-estimate fallback.

**Architecture:** iOS owns Keychain credentials, direct Solcast requests, array selection, persistent forecast cache, quota accounting, and a pure comparison engine. A bounded authorized mobile endpoint supplies historical household/battery profiles from stored data only. Compare candidates over the same horizon using incremental per-period netting cost.

**Tech Stack:** SwiftUI, Foundation URLSession, Security Keychain, Swift Testing; existing Next.js mobile API, TypeScript and Vitest for planning context. Design: `docs/plans/2026-09-26-ios-solcast-load-timing-design.md`.

**Required progressive behavior:** The existing estimator renders immediately and remains usable without a Solcast key. A key enables optional forecasting automatically once its inputs are valid. Failed Solcast requests or unusable forecast/context inputs automatically restore the basic estimate; successful recovery restores the enhancement. No separate feature toggle, mandatory setup, or blocking forecast error. Preserve profile selection and the original basic pricing semantics throughout.

---

## Coordination and prerequisites

1. Sol reads root/local AGENTS instructions, `Authentication.md`, `DesignDecisions.md` section 4, the design above, and the configurable profiles design/implementation plans dated 2026-09-25. Inspect current Git state; preserve unrelated work.
2. Verify configurable profiles, wall energy/duration, and tariff timeline have landed. They were not implemented at planning time. If absent, identify this as a prerequisite and complete the already-written profiles plan as a distinct work package before these dependent tasks; do not substitute fixed-energy profiles without duration. Keep its commits separate.
3. Use a suitable managed worktree for implementation. Sol should run as `gpt-6-sol`; delegate bounded tasks to `gpt-6-luna`, using the actual available model identifiers in that session. No simultaneous edits to shared files and no overlapping iOS test runs. Sol owns integration, review of billing math/privacy, and final verification. Luna implements one task at a time and reports files, tests, assumptions, and commit.
4. Track task status in `task.md` for this substantial work. Retrieve current relevant library/API docs with Context7 first; if it has no official source, use official documentation. Recheck provider response fields before implementing the decoder. Do not consume live API quota in automated tests.

## Task 1: Typed provider contract and interval aggregation

**Create:** `cmd/ios-app/PWUsage/Models/SolarForecast.swift`, `cmd/ios-app/PWUsage/Networking/SolcastClient.swift`, `cmd/ios-app/PWUsageTests/SolcastClientTests.swift`, `cmd/ios-app/PWUsageTests/SolarForecastTests.swift`.

1. Add synthetic decoding tests for discovery `sites`, resource IDs, tags, names, forecast power, period end/duration, fractional and nonfractional UTC timestamps, optional percentile fields, missing/nonfinite values and error responses. Do not copy the user's account response into fixtures.
2. Run `./run-tests.sh SolcastClientTests` from `cmd/ios-app`; expect new assertions to fail before implementation.
3. Implement an injected transport against the fixed `https://api.solcast.com.au` origin: discovery at `/rooftop_sites?format=json`, forecasts at `/rooftop_sites/{resourceID}/forecasts?format=json`. Encode/validate resource IDs as path components. Bearer header only; separate ephemeral session with no cookie storage, no disk response cache, no redirects, bounded timeout and no automatic retries. Errors expose status/category, never raw response bodies or credentials.
4. Add pure aggregation keyed by interval start/end. Test shuffled arrays, 4 kW over 30 minutes = 2 kWh, partial run overlaps, explicit nighttime zero, duplicates, gaps, selected-array absence, and mismatched periods. Reject incomplete coverage rather than double-counting or treating absence as zero. Central estimate only; do not invent combined probabilistic confidence by adding percentile bounds.
5. Run `./run-tests.sh SolcastClientTests` and `./run-tests.sh SolarForecastTests` sequentially; expect pass. Sol reviews request isolation and interval arithmetic. Commit `feat(ios): add typed Solcast forecast client`.

## Task 2: Local credentials, selection, cache and request budget

**Create:** `cmd/ios-app/PWUsage/Authentication/SolcastCredentialStore.swift`, `cmd/ios-app/PWUsage/State/SolarForecastStore.swift`, `cmd/ios-app/PWUsageTests/SolarForecastStoreTests.swift`.
**Modify:** `cmd/ios-app/PWUsage/Authentication/MobileAuthService.swift` for cleanup integration after confirming its existing logout flow.

1. Write state tests with fake clock, transport, Keychain and file storage: concurrent refresh deduplication, UTC rollover, quota reservation for two arrays, retries consuming budget, 401/429 behavior, stale cache, failed second array preserving the previous complete batch, account/site switching, key replacement, sign-out and disconnect.
2. Run `./run-tests.sh SolarForecastStoreTests`; expect failure.
3. Implement device-only, non-synchronizing Keychain storage. Keep the real key out of ordinary persistence. Scope mappings and cache by app account/site and a nonsecret credential identifier. Exclude app-owned persisted files from backup and protect them on disk. Reject late network completions after disconnect/account change using a generation token.
4. Implement the design defaults: three-hour foreground refresh threshold, six-hour recommendation freshness, eight automatic attempts and ten total attempts per UTC day. Persist reservations before dispatch and reserve the full selected-array request count. Conservatively count discovery and failures. Retain only nonsecret budget bookkeeping across reconnect; treat key replacement as a different credential, without claiming knowledge of account-wide usage. On 429 defer until Retry-After or UTC reset. Do not fetch estimated actuals.
5. Rerun the suite; expect pass. Sol checks that neither logging nor persistence can leak the key and that forecast data remains device-local. Commit `feat(ios): store solar forecasts and credentials locally`.

## Task 3: Bounded historical planning context

**Create:** `cmd/next-app/src/lib/load-planning-context.ts`, `cmd/next-app/src/lib/load-planning-context.test.ts`, `cmd/next-app/src/app/api/mobile/load-planning-context/route.ts`, `cmd/next-app/src/app/api/mobile/load-planning-context/route.test.ts`.
**Reuse:** `cmd/next-app/src/lib/energy-repo.ts` (`getRawEnergyData`), `cmd/next-app/src/lib/auth-checks.ts`, existing mobile route patterns. Add a repository method only if necessary to keep reads bounded.

1. Sol verifies stored energy/power units, timestamp semantics, battery sign and sampling coverage from repository/importer code before Luna writes aggregation. Document these in helper comments and explicit test fixtures; do not infer units from field names.
2. Write fixtures for 14 local days, missing intervals, fewer than five usable days, DST repeated/missing hours, a discretionary-load outlier, positive charging and negative discharge. Expect 48 local half-hour profile slots with nullable estimates, sample counts and coverage; absent data is not zero.
3. Run `npm run test -- --run src/lib/load-planning-context.test.ts` from `cmd/next-app`; expect failure.
4. Implement medians per local half-hour using the design's coverage rules and one vote per local day. Fetch only the previous 14 complete site-local days, bounded server-side; no client-specified arbitrary range. Return version, site ID/timezone, `asOf`, history start/end, and slots containing `localMinute`, `homeKw`, `batteryNetChargeKw`, and sample counts. Return an explicit unavailable result if insufficient. No SOC forecast or provenance changes.
5. Implement GET with required site authorization before data access, fixed limits, private/no-store response caching, and existing request context/error conventions. Test 400 missing site, 401 denied, 404 missing site, authorized bounded reads, insufficient history, valid units and no Tesla calls. The response cannot accept or return Solcast inputs.
6. Run both new test files; expect pass. Sol reviews auth, bounded data access and signs/units. Commit `feat(mobile): expose historical load planning context`.

## Task 4: Pure lowest-cost comparison engine

**Create:** `cmd/ios-app/PWUsage/Models/LoadTimingForecastEstimator.swift`, `cmd/ios-app/PWUsageTests/LoadTimingForecastEstimatorTests.swift`.
**Reuse:** prerequisite `LoadProfile` and `LoadTimingEstimator` wall-energy/duration logic; extend typed contracts as needed in `cmd/ios-app/PWUsage/Models/MobileContracts.swift`.

1. Write hand-calculated tests before implementation. Example: baseline period balance +2 kWh, load 3 kWh, buy 0.30, sell 0.05 gives incremental cost 0.40. Baseline -2 kWh with that load gives 0.90. A period with ample forecast surplus prices extra consumption at foregone export credit, not zero. Check zero/negative rates without rejecting finite valid rates.
2. Add cases for repeated tariff periods, cross-period runs, candidate order independence, same-horizon comparison, source-time overlap, stale source, forecast gaps, array gaps, DST, run ending exactly at H, no fitting run, cycle cutoff, incompatible rate changes, missing historical slots, zero car charge, and conservation of profile wall energy.
3. Run `./run-tests.sh LoadTimingForecastEstimatorTests`; expect failure.
4. Implement the exact Bbase/BwithLoad and C(B) equations in the design. Build boundaries from forecast/context/tariff intervals; integrate overlap seconds. Do not reallocate historical surplus per candidate or charge baseline costs to the selected load. Require the entire selected run and projection to share complete coverage. Reject incomplete baseline rather than using partial totals. Handle the <=30-minute source-to-now gap only where baseline coverage exists.
5. Enumerate now, valid half-hour boundaries, tariff transitions and transition-minus-duration starts. Choose the minimum, ties earliest. Compare waiting savings against the currency minor unit. Return typed unavailable reasons, cost-now, recommended start/end/cost, savings, estimated solar contribution, horizon and assumptions. Define recommendation as best among evaluated starts, not an exact continuous-time optimum.
6. Test that changing solar within a netted period need not change its incremental load cost, and that high export value can make a sunny window worse than another period. This is a billing recommendation, not a solar-peak finder.
7. Rerun the suite; expect pass. Sol independently checks three numerical fixtures and the common-horizon invariant. Commit `feat(ios): compare forecast load timing costs`.

## Task 5: Connection settings and foreground orchestration

**Create:** `cmd/ios-app/PWUsage/Views/SolarForecastSettingsSheet.swift`, `cmd/ios-app/PWUsageTests/SolarForecastCoordinatorTests.swift`.
**Modify:** `cmd/ios-app/PWUsage/Networking/PWUsageAPI.swift`, `cmd/ios-app/PWUsage/State/DashboardCoordinator.swift`, `cmd/ios-app/PWUsage/PWUsageApp.swift`, `cmd/ios-app/PWUsage/Views/LoadTimingView.swift`.

1. Add coordinator tests for independent Solcast/PWUsage transports, zero Solcast/context requests without a key, context fetch only when configured/needed, no added live-dashboard polling, stale or failed context, logout during fetch, and switching sites while requests complete. Test basic -> loading-with-basic -> enhanced -> request-failed-with-basic -> recovered-enhanced -> disconnected-basic. A failed refresh must select basic even if a previously valid batch remains stored; a late completion must not restore enhancement after disconnect.
2. Run `./run-tests.sh SolarForecastCoordinatorTests`; expect failure.
3. Add typed planning-context decoding/API fetch. Cache historical context locally for up to 24 hours with site/source validation; fetch on entering the configured detail screen. Use the existing bill/tariff refresh path for fresh balances. Profile edits and start comparisons perform no network requests.
4. Build settings with secure key input, connection/error status, explicit array checkboxes, tags as hints, Save and Disconnect. No real key in previews. Offer manual resource-ID entry if discovery is unavailable, without silently selecting unrelated resources. Respect the same request budget for validation and refresh.
5. Wire refresh to foreground/detail entry, not a promised background schedule. Show local request usage as this device's attempts, not account-wide remaining quota. Rerun coordinator/store tests sequentially and review settings at large Dynamic Type. Commit `feat(ios): connect device-local solar forecasting`.

## Task 6: Recommendation presentation and fallback

**Modify:** `cmd/ios-app/PWUsage/Views/LoadTimingView.swift`, `cmd/ios-app/PWUsage/Views/DashboardPreviews.swift`, `cmd/ios-app/PWUsageTests/LoadTimingViewTests.swift`; add a pure presentation helper if the view would otherwise own business logic.

1. Write tests for recommend now, recommend later, insignificant savings, no full run in horizon, no key, incomplete array selection, first-load pending, invalid key, timeout, 429, partial-array failure, stale/missing forecast, context failure, insufficient baseline, key removal, recovery, and zero-charge car. Assert every unavailable/pending forecast state retains the prerequisite estimate and selected profile without labeling it forecast-aware. Assert basic total and breakdown match the unenhanced estimator exactly, and no forecast setup/error state blocks its controls. Missing tariffs remain a basic-estimator unavailable state, not a fabricated fallback cost.
2. Run `./run-tests.sh LoadTimingViewTests`; expect new assertions to fail.
3. Show start-now and recommended costs, savings, finish time, estimated solar contribution, data ages and actual comparison horizon when enhanced inputs are valid. Otherwise render the existing estimator immediately. Keep connection setup optional; show a small informational fallback note only when relevant to a configured connection. Do not show forecast-derived savings/solar values beside a basic cost after failure. Detail text says typical household/battery behavior is assumed and final bill cost may differ. Do not promise battery refill or precise forecast confidence. Preserve cycle balances as observed data; never replace them with predicted balances in the existing cards.
4. Add synthetic previews for East/West combined data, tariff crossing, long charge, stale cache, incomplete array and missing context. Check VoiceOver order, currency formatting, date/timezone wording and accessibility sizes. Rerun the suite; expect pass. Commit `feat(ios): show solar-aware load timing recommendations`.

## Task 7: Integration verification and handoff

1. Sol reviews the final diff against the design, especially credential locality, request budget, history signs/units, equal horizons, signed deficits, billing-cycle boundaries and explicit battery assumptions. Resolve findings before calling it complete.
2. From `cmd/ios-app`, run `./run-tests.sh` once. All native runs must use that script; inspect retained artifacts and simulator state on timeout before changing code. No concurrent native runs. This also provides native build verification.
3. From `cmd/next-app`, run `npm run lint`, `npm run test -- --run`, and `npm run build`; expect exit code zero. Inspect any failures rather than changing unrelated code blindly.
4. Inspect the simulator screens and mocked request recordings: PWUsage calls contain no Solcast key/resource/forecast; Solcast calls contain no PWUsage cookies. Test disconnect and sign-out during an in-flight request. Verify forecast cache is excluded from backup and Keychain sync is disabled.
5. Default to fixtures. A manual live smoke test may use a key entered by the user on the device and at most one complete refresh; do not import the repository `.env` into app builds or automated tests. Report live verification separately if it was not performed.
6. Run `git diff --check`, verify no credentials/account fixtures appear in tracked changes, update `task.md`, and commit verified changes with conventional messages. No automatic deployment, release, or vendor contact. Report implementation/test results and the remaining vendor-terms uncertainty.

## New-session starting prompt

Use Sol as coordinator and Luna as implementer for `docs/plans/2026-09-26-ios-solcast-load-timing-implementation.md`. Read its companion design and repository instructions first. Verify/complete the configurable-load-profile prerequisite as a separate work package. Work in an isolated managed worktree, delegate bounded tasks to Luna, review each task before proceeding, and run the required verification. Keep Solcast keys and forecasts exclusively on-device. Do not deploy or release.
