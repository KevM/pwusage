# Open-Meteo review assessment

The external review identifies runtime issues and also proposes changes to the tested forecasting model. Those require different validation. Preserve the beta's prospective release gate; a retrospective Harrison backtest does not establish performance across households or forecast issue times.

## Modeling and calibration

| Finding | Verified assessment and decision |
|---|---|
| Raw forecast bias/cold start | Real limitation, but there is no `minimumOverallSamples = 15`. The all-day fallback starts after one eligible completed hour; five samples are needed only for a specialized clock-hour factor. A new fingerprint starts with identity. Raw pooled daily absolute error beat history (22.34% vs 31.60%); mean hourly nMAE was slightly worse (82.26% vs 81.24%). Keep corrected and cold-start performance separate in prospective scoring. |
| Redetection resets correction | Changed geometry/location/model version resets history intentionally. An unchanged layout with a new detection timestamp invalidates cache but retains history. Server geometry already rounds to 0.1 degree and 0.01 kWp. Reprojecting archived issued weather under a new layout is a possible future migration; simply relaxing fingerprint precision can combine incompatible forecasts. |
| Bootstrap with past_days=14 | Do not record retrospective weather as earlier-issued day-ahead predictions. Open-Meteo's past weather is not the original issued forecast. A separately labelled physical-scale bootstrap needs its own evaluation. One HTTP request is not necessarily one quota unit when the requested span exceeds two weeks. |
| Same-day cohort starvation | Genuine sampling limitation. Elapsed hours fetched in the afternoon cannot retrospectively become valid morning forecasts. The existing fetchedAt-before-target-hour rule stays. Sparse per-hour training uses its cohort's all-day ratio; no-data uses identity. Cross-cohort borrowing requires a lead-aware backtest, rather than silently mixing forecast errors. |
| Physics differs from detector | Correct. The Swift model intentionally reproduces the already-backtested model: 0.86 system multiplier, 0.25 albedo and beam IAM. Detector assumptions differ; the 0.85/0.86 difference alone does not explain the observed bias. Diffuse IAM, temperature and shading changes must be a versioned model experiment with new parity fixtures and rerun backtests. The stored horizon/selection mask is not established as a production-loss model. |
| Two-day horizon and no cautious percentile | Correct current scope. Extending the API request to seven days is possible, but correction after lead one remains identity and longer leads have not been validated against history. Do not invent percentile forecasts. Retain documented history beyond the two-day forecast until longer-lead skill is measured. |
| Free-tier terms | The owner explicitly confirmed non-commercial use in the original handoff. Free App Store distribution does not itself reverse that determination. Revisit if the app's commercial use changes. |

References: [Previous Runs semantics](https://open-meteo.com/en/docs/previous-runs-api), [forecast API](https://open-meteo.com/en/docs), [pricing and usage accounting](https://open-meteo.com/en/pricing).

## Runtime fixes implemented in this follow-up

- Beta availability must offer automatic forecast setup/status, never a hidden Solcast connection flow.
- Preserve the checking gate while a forecast operation is pending; use history after the operation finishes without a usable forecast.
- Keep refresh outcome and safe diagnostics even when no forecast can be published; distinguish request/deferred/budget/invalid-response failures.
- Use provider-neutral forecast connection state for measured-energy aging.
- Retain available elapsed local-day radiation intervals plus the previous day's final hour for projectionStart; validate requested forecast coverage and keep issuance-time eligibility for correction.
- Coalesced callers need independent cancellation. Cancel the shared request only after the final waiter exits. Count requests already sent toward the rate budget; cancellation does not undo provider usage.
- Track visible solar surfaces independently so dismissing one does not leave a phantom timer or stop another surface's timer.
- Attribute Open-Meteo in Bill and Smart Shift only when their calculation actually uses its forecast, with a source link.

These implementation changes do not alter physics, train on retrospective weather, mix lead cohorts, or extend the forecast horizon. Those modeling proposals remain separate experiments, not unverified accuracy fixes.


## Verification record

The review fixes have regression coverage for failure diagnostics, automatic setup/checking, provider-neutral energy age, independent surface lifetime, actual-use attribution, elapsed-hour projection, and shared-request cancellation. Additional stale-state cases cover operation supersession and transitions back to a legacy site. A midnight projection regression was observed failing before retaining the previous day's final hour. The final full-suite and Release build results are recorded on PR #258.

Final validation: 828 iOS tests executed successfully (five intentionally skipped; Swift Testing reports 833 total), strict SwiftLint and SwiftFormat pass, and the iOS Release simulator build succeeds. Existing web checks on this PR remain unchanged by this iOS-only follow-up. Independent read-only review found no remaining runtime blockers.
