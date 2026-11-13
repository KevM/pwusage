# Solar degradation accuracy plan

Results: [`2026-11-13-solar-degradation-backtest-results.md`](./2026-11-13-solar-degradation-backtest-results.md).

Start from `main` after PR #368 lands. The first deliverable is a reproducible, on-device backtest and a decision about whether the shipped trend needs to change.

The current estimator takes the median of annualized changes between successive observations of the same calendar month. Its finding uses a −0.8%/year threshold and confidence based on the span of available months. Preserve that estimator as the baseline in every comparison.

## 1. Establish usable history

- Use the owner's manually entered site. Verify nameplate, roof faces, tilt, azimuth, install dates and known inverter, shading or panel changes against production history. Record uncertain dates and divide the history into stable configurations before looking at trend results.
- Use Solar System’s **Load More History** if needed. Tabulate clear days per calendar month and roof direction where the fit separates directions. Mark missing production, missing weather, excluded snowfall days and months that lack a match in another year.
- Start with `cmd/ios-app/PWUsage/State/Solar/SiteHistoryDebug.swift` and the existing health pass. Keep site readings and exact geometry on-device. Record aggregate results and the settings needed to reproduce them.
- Aim for at least two years of stable history with matching months across seasons. If coverage is thinner, report which comparisons are possible and what history would make the trend testable.

## 2. Backtest expected daily energy

- Compare the shipped 85% effective-output reference with a single site-wide factor fitted on the earliest well-covered period with a stable configuration. Freeze the calibration dates and factor before scoring. Run both models through the same clipping and clear-day rules in `cmd/ios-app/PWUsage/Models/Solar/Health/SolarHealthYearFit+Reference.swift`.
- Score on later, held-out clear days. Report sample count, mean absolute kWh error and signed kWh bias overall and by season. Keep the factor fixed across later years so calibration preserves decline. If a season has too few observations, mark the comparison inconclusive.
- Advance calibration only if it lowers held-out error and avoids introducing a material seasonal bias. Agree on what counts as material before inspecting held-out results. A better kWh forecast alone provides no evidence of a better decline estimate.

## 3. Backtest historical irradiance

- Fetch hourly global horizontal, direct normal, and diffuse irradiance from the [Open-Meteo archive](https://open-meteo.com/en/docs/historical-weather-api) for the owner's existing calibration and holdout periods. Use the same archive model across years. Send coordinates rounded to two decimals and do the roof calculation on-device.
- Use the existing `OpenMeteoArrayModel` to project irradiance onto each entered roof face. Sum expected AC energy using the active layout and inverter limits. Join each preceding-hour weather average to production from that same UTC interval, then sum matched hours into site-local days. Report missing hours and skip incomplete daylight comparisons.
- Compare weather-based and clear-sky expected kWh on the same held-out clear days first. Then score cloudy days separately to see how much coverage historical irradiance adds. Freeze any calibration before scoring and keep snowfall and configuration filters consistent.
- Compare matching-month trends from actual divided by expected kWh. Keep the clear-sky trend as the benchmark. Grid-scale weather may miss clouds over one roof, so review daily error, seasonal bias, and year-to-year stability before proposing a change to findings. Keep the first pull scoped to the backtest so the results can inform whether to cache irradiance in the app.

## 4. Validate the annual decline

- Reproduce the shipped estimate from `cmd/ios-app/PWUsage/Models/Solar/Health/SolarHealthClassifier+Aging.swift`. Report annual decline, the matching months and year gaps behind it, and each month's clear-day count. Run sensitivity checks for dropping a season, omitting a roof direction where separable, including snowfall days in a diagnostic run, and excluding periods with known shading or hardware changes.
- Use `cmd/ios-app/PWUsageTests/Fixtures/SyntheticSolarSite.swift` and `cmd/ios-app/PWUsageTests/SolarHealthClassifierPassTests.swift` for histories with 0%, −0.5%, and −1.5% annual decline. Add sparse overlap, changing shade and an installation step. Record estimation error in percentage points per year and whether the aging finding appears.
- Investigate estimator changes only when the baseline shows a reproducible failure. For example, if a long span with very few matching months produces a confident finding, compare a minimum matched-month rule on the same cases. A candidate must improve the target failure, preserve the known decline rates, and avoid increasing false aging findings on stable synthetic sites.

## 5. Decide what ships

- If the frozen factor improves held-out kWh error while the shipped trend holds up, scope any production change to the expected-energy reference. If a trend candidate also clears the synthetic and real-history checks, review it as a separate change with its evidence and regression tests.
- Evaluate temperature correction only if held-out errors still show a repeatable seasonal bias after checking coverage and shading. Fit on the calibration period, score on the same held-out days, and rerun the known-decline cases before proposing a change.
- Publish an aggregate backtest summary with the baseline and candidate results, coverage gaps, and a decision. An inconclusive result can close the backtest with a concrete data requirement and no product code change.

For any implementation that follows, use `./cmd/ios-app/lint.sh` and `./cmd/ios-app/run-tests.sh --full` before committing.
