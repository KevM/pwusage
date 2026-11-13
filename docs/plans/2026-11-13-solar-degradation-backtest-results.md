# Solar degradation backtest: results

Run 2026-11-13 against the plan in [`2026-11-13-solar-degradation-backtest.md`](./2026-11-13-solar-degradation-backtest.md).
Aggregates only. Site readings, coordinates and exact geometry stay in a local research folder
outside the repo. The harness is `cmd/ios-app/PWUsageTests/DegradationBacktest/`, disabled unless
`PWUSAGE_SOLAR_BACKTEST_DIR` names that folder:

```bash
cd cmd/ios-app
TEST_RUNNER_PWUSAGE_SOLAR_BACKTEST_DIR=/abs/research/folder ./run-tests.sh --full \
  PWUsageTests/DegradationBacktestTests PWUsageTests/DegradationBacktestSyntheticTests
```

It runs the shipped `SolarHealthPass` and `SolarHealthClassifier` code. Calibration dates,
materiality and acceptance rules were written down before any held-out result was scored. Figures
below use the owner's confirmed layout and the matched-pair confidence rule this PR adds.

## 1. History

- One site (the owner's), one stable configuration: a 10 kW DC array split between an
  east-facing and a west-facing roof (more panels on the west), one inverter, no recorded hardware or shading changes. Known morning tree
  shade on the east face.
- 2023-11-28 (first production) to 2026-10-30: 35 months, 1,069 producing days. ERA5 snowfall marks
  132 days, all excluded.
- The shipped selection finds 147 clear days. 21 months reach the 4-clear-day minimum for a monthly
  factor. 17 of those months have a match in another year, giving 10 matched pairs. Dec–Jan and
  Mar–Apr rarely qualify (snow, cloud), so winter and early spring are thin.
- With the confirmed layout, the two directions agree: both run about 1.0–1.3 of the reference
  each month, highest in winter and lowest in July–September. Earlier runs used a wrong panel count per face. They showed a large east/west split
  and an 11–15% scale error, both input errors, not shade. Per-direction factors and the expected
  kWh are only as good as the entered layout.

## 2. Expected daily energy (clear days)

Calibration 2023-12-01..2024-11-30 (54 clear days), hold-out 2024-12-01..2026-10-30 (93 clear days).

| Model | Held-out MAE (% of mean actual) | Bias (% of mean actual) |
| --- | --- | --- |
| Shipped 85% reference | 8.0% | +8.0% (under-prediction) |
| Frozen site factor (×1.11, fitted on calibration) | 5.1% | −2.3% |

By season, shipped reference then frozen factor (MAE / bias, % of mean actual):

| Season | Days | Shipped | Frozen |
| --- | --- | --- | --- |
| Winter | 18 | 16.3% / +16.3% | 7.7% / +7.0% |
| Spring | 15 | 11.6% / +11.6% | 2.5% / +1.7% |
| Summer | 28 | 4.5% / +4.5% | 6.1% / −6.1% |
| Autumn | 32 | 6.6% / +6.6% | 4.7% / −3.8% |

- MAE falls 35.9%, against a required 5%. No season's bias grows by more than the 3% materiality
  limit (summer's moves from +4.5% to −6.1%, a 1.6-point growth in magnitude), and no season is
  inconclusive. The frozen factor **advances**. It supports the per-site baseline in the
  [site-baseline design](../superpowers/specs/2026-11-13-solar-health-site-baseline-design.md).
- Frozen-factor bias by year: 2024 0.0%, 2025 −1.7%, 2026 −2.95%. The factor stays fixed, so the
  decline shows up here instead of being calibrated away.
- The shipped 85% derate under-predicts this array by about 8% on clear days, most in winter and
  spring. Part of that is the site (east-facing roof, per-face factors near 1.1), so one fixed
  derate is a weak reference. A summer over-correction remains (−6.1% bias), the cost of one
  annual factor.

## 3. Historical irradiance (ERA5)

937 complete days (every lit hour with all twelve 5-minute samples, snowfall excluded). Both
models are evaluated over the same whole UTC hours and scored against the same measured production.
The clear-sky reference is summed at each 5-minute slot of those hours. Each frozen factor is
fitted on the same 54 calibration clear days.

| Model, held-out | Days | MAE (% of mean actual) | Bias |
| --- | --- | --- | --- |
| Shipped 85% clear-sky reference, clear days | 93 | 6.7% | +6.0% |
| Frozen clear-sky factor, clear days | 93 | 5.8% | −2.4% |
| Frozen irradiance, clear days | 93 | 5.8% | −0.9% |
| Frozen irradiance, non-clear days | 509 | 16.1% | −11.3% |

- On the same clear days, irradiance matches the frozen clear-sky factor (MAE −0.8%, needs −5%).
  Both beat the uncalibrated shipped reference, but that gain comes from the calibration, not the
  irradiance data. **Does not advance.**
- It does add 509 usable cloudy days, but at nearly three times the error, with a strong
  over-prediction. ERA5's grid misses local cloud, as the plan expected.
- Trend from irradiance over all counted days: −2.24%/yr from 23 pairs, but the pair IQR is 8.60
  pp/yr against 0.78 for the clear-sky trend. More pairs, far less stable. Restricted to clear days
  it has no matched months.
- Conclusion: do not cache irradiance in the app for Solar Health. Revisit only with a source that
  resolves cloud at roof scale.

## 4. Annual decline

Shipped estimate: **−1.21%/yr, confident, aging finding shown**. It comes from 10 matched pairs
(4–11 clear days per month) across Feb, May, Jun, Jul, Sep, Oct and Nov. Pair median −1.21, IQR
0.78 pp/yr.

| Sensitivity | Estimate | Finding |
| --- | --- | --- |
| Without winter | −1.37%/yr (9 pairs) | yes |
| Without spring | −1.21%/yr (8) | yes |
| Without summer | −1.51%/yr (7) | yes |
| Without autumn | −0.95%/yr (6) | yes |
| West factor only | −2.31%/yr (10) | yes |
| East factor only | −0.29%/yr (10) | no |
| Months with ≥ 8 clear days | −1.65%/yr (2) | no (too few pairs, see below) |
| Snowfall days included | −1.36%/yr (9) | yes |

Three readings point the same way: the clear-sky trend, the frozen-factor year bias (about
−1.5%/yr) and the noisier irradiance trend. The decline survives dropping any season or adding snow
back, so it is real in the data. Its cause is not established. It sits almost entirely in the west
factor, so a growing obstruction or soiling on that face is as likely as panel aging. The east face,
the one with the known tree, holds steady.

### Synthetic known-decline cases

East/west synthetic site, Dec 2023 – Oct 2026, through the shipped pass and estimator:

| Case | True | Estimate | Pairs | Before the rule | With the rule |
| --- | --- | --- | --- | --- | --- |
| Steady 0%/yr | 0.00 | 0.00 | 23 | confident, no finding | same |
| Steady −0.5%/yr | −0.50 | −0.50 | 23 | confident, no finding | same |
| Steady −1.5%/yr | −1.50 | −1.50 | 23 | confident, finding | same |
| Sparse overlap, −0.5%/yr | −0.50 | −0.50 | 2 | confident, no finding | no confidence |
| Sparse overlap, stable, one 3% low winter | 0.00 | −1.50 | 2 | **confident, false finding** | no confidence, no finding |
| Stable panels, growing east shade | 0.00 | 0.00 | 23 | confident, no finding | same |
| West system added, install date entered | 0.00 | 0.00 | 21 | confident, no finding | same |
| West system added, no install date | 0.00 | +33.4 | 21 | confident, no finding | same |

- Known declines are recovered exactly, and growing shade is rejected by the shade mask.
- The baseline failed one case reproducibly: two matched pairs spanning more than 24 months were
  enough for a *confident* aging finding, so one off winter read as −1.5%/yr.
- An undated added system reads as +33%/yr. That raises no false finding, but the change-over-time
  view shows a meaningless rate. Manual references have no step detection; only detected ones do.

## Decisions

1. **Trend confidence (shipped in this PR).** Confident now also needs ≥ 6 matched pairs across ≥ 3
   calendar months; initial needs ≥ 3 pairs across ≥ 2 months. The span rules (24 and 13 months)
   are unchanged. Fewer pairs still report a rate but carry no confidence and raise no finding. The
   false sparse finding is gone. Every steady case, the shade case, the install cases and the real
   site (10 pairs, 7 months) are unchanged. No new findings appear. Regression tests are in
   `SolarHealthClassifierAgingTests`.
2. **Expected-energy reference.** The frozen per-site factor advances: MAE falls 35.9% on held-out
   clear days and no season gets materially worse. The shipped 85% reference under-predicts this
   array by about 8%. Build it as the per-site baseline in the
   [site-baseline design](../superpowers/specs/2026-11-13-solar-health-site-baseline-design.md).
   The input-quality lesson stands: a wrong panel count moved the reference by 11–15%.
3. **Irradiance.** No product change; do not cache archive irradiance.
4. **This site's −1.21%/yr finding.** The data supports it. Before treating it as panel degradation,
   look at the west face for new shading or soiling, since that is where the decline sits.
   Temperature correction stays deferred. After calibration, summer still reads about 6% below
   expected, inside the materiality limit but the likely signature of heat loss. Revisit it if the
   site-baseline score shows summer swings once it is live.
