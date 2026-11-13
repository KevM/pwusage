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
materiality and acceptance rules were written down before any held-out result was scored.

## 1. History

- One site (the owner's), one stable configuration: east and west faces, one inverter, no recorded
  hardware or shading changes. Known morning tree shade on the east face.
- 2023-11-28 (first production) to 2026-10-30: 35 months, 1,069 producing days. ERA5 snowfall marks
  132 days, all excluded.
- The shipped selection finds 147 clear days. 21 months reach the 4-clear-day minimum for a monthly
  factor. 17 of those months have a match in another year, giving 10 matched pairs. Dec–Jan and
  Mar–Apr rarely qualify (snow, cloud), so winter and early spring are thin.
- The east and west factors differ a lot (about 0.85 and 1.55 against the entered layout). Either
  the entered split of panels between the faces is off, or the east face loses most of its morning
  output to shade. Check the entered layout before reading anything per direction.

## 2. Expected daily energy (clear days)

Calibration 2023-12-01..2024-11-30 (54 clear days), hold-out 2024-12-01..2026-10-30 (93 clear days).

| Model | Held-out MAE (% of mean actual) | Bias (% of mean actual) |
| --- | --- | --- |
| Shipped 85% reference | 11.1% | +11.1% (under-predicts) |
| Frozen site factor (×1.15, fitted on calibration) | 5.2% | −2.2% |

- Every season improves, and no season picks up material bias. Summer bias is −5.5%, against
  +8.4% for the baseline.
- Against the pre-registered rule (MAE −53%, no material seasonal bias), the frozen factor
  **advances**.
- Frozen-factor bias by year: 2024 0.0%, 2025 −1.7%, 2026 −3.0%. The factor stays fixed, so the
  decline shows up here instead of being calibrated away.
- Caveat: most of the gain is one site-level scale error, the 85% derate against an entered
  nameplate that under-states this array. A self-calibrated reference would also hide a site that
  under-performs from day one (the low-output finding), so it cannot simply replace the nameplate
  reference.

## 3. Historical irradiance (ERA5)

937 complete days (every lit hour with all twelve 5-minute samples, snowfall excluded). Frozen
factor fitted on the same 54 calibration clear days.

| Model, held-out | Days | MAE (% of mean actual) | Bias |
| --- | --- | --- | --- |
| Frozen clear-sky factor, clear days | 93 | 5.2% | −2.2% |
| Frozen irradiance, clear days | 93 | 5.7% | −0.9% |
| Frozen irradiance, non-clear days | 509 | 16.3% | −11.3% |

- On the same clear days, irradiance is worse by +26% in kWh MAE (+10% relative to each model's
  own actual). **Does not advance.**
- It does add 509 usable cloudy days, but at three times the error, with a strong over-prediction.
  ERA5's grid misses local cloud, as the plan expected.
- Trend from irradiance over all counted days: −1.93%/yr from 23 pairs, but the pair IQR is 7.8
  pp/yr against 2.3 for the clear-sky trend. More pairs, much less stable. Restricted to clear days
  it has no months with 10 counted days.
- Conclusion: do not cache irradiance in the app for Solar Health. Revisit only with a source that
  resolves cloud at roof scale.

## 4. Annual decline

Shipped estimate: **−1.44%/yr, confident, aging finding shown**. It comes from 10 matched pairs
(4–11 clear days per month) across Feb, May, Jun, Jul, Sep, Oct and Nov. Pair median −1.44, IQR
2.34 pp/yr.

| Sensitivity | Estimate | Finding |
| --- | --- | --- |
| Without winter | −1.66%/yr (9 pairs) | yes |
| Without spring | −1.44%/yr (8) | yes |
| Without summer | −1.66%/yr (7) | yes |
| Without autumn | −0.82%/yr (6) | yes (just past −0.8) |
| West factor only | −2.01%/yr (10) | yes |
| East factor only | −0.21%/yr (10) | no |
| Months with ≥ 8 clear days | −1.90%/yr (2) | yes |
| Snowfall days included | −1.66%/yr (9) | yes |

Three readings point the same way: the clear-sky trend, the frozen-factor year bias (about
−1.5%/yr) and the noisier irradiance trend. The decline is real in the data and not an artifact of
one season or of snow. Its cause is not established. It sits in the west factor, and per-direction
factors are fitted jointly and are noisy. Dropping autumn halves it.

### Synthetic known-decline cases

East/west synthetic site, Dec 2023 – Oct 2026, through the shipped pass and estimator:

| Case | True | Estimate | Pairs | Finding |
| --- | --- | --- | --- | --- |
| Steady 0%/yr | 0.00 | 0.00 | 23 | no |
| Steady −0.5%/yr | −0.50 | −0.50 | 23 | no |
| Steady −1.5%/yr | −1.50 | −1.50 | 23 | yes |
| Sparse overlap, −0.5%/yr | −0.50 | −0.50 | 2 | no |
| **Sparse overlap, stable, one 3% low winter** | 0.00 | −1.50 | 2 | **yes (false)** |
| Stable panels, growing east shade | 0.00 | 0.00 | 23 | no |
| West system added, install date entered | 0.00 | 0.00 | 21 | no |
| West system added, no install date | 0.00 | +33.4 | 21 | no |

- Known declines are recovered exactly, and growing shade is rejected by the shade mask.
- **Reproducible failure:** two matched pairs spanning more than 24 months are enough for a
  *confident* aging finding. One off winter then reads as −1.5%/yr. The real-history "≥ 8 clear
  days" variant hits the same path (2 pairs, confident).
- An undated added system reads as +33%/yr. That raises no false finding, but the change-over-time
  view shows a meaningless rate. Manual references have no step detection; only detected ones do.

## Decision

1. **Expected-energy reference:** the frozen factor clears the bar for kWh accuracy on this site.
   Only one site is behind that, and a self-calibrated reference conflicts with the low-output
   finding, so the production change should be scoped as *showing* expected kWh from a factor
   calibrated on the first well-covered year. The nameplate reference stays for the health score.
   It needs a separate design pass.
2. **Trend estimator:** investigate a minimum matched-pair rule for confidence (for example ≥ 6
   pairs covering ≥ 3 calendar months). On these cases it would remove the false sparse finding.
   It would keep the steady cases (23 pairs) and the real site (10 pairs, 7 months), and it raises
   no new findings. Ship it as its own change with the sparse case as a regression test.
3. **Irradiance:** no product change; do not cache archive irradiance.
4. **This site's −1.4%/yr finding:** supported by the data. Before treating it as panel
   degradation, check the entered east/west split, then look for west-side shading or soiling.
   Temperature correction is not warranted: no repeatable seasonal bias remains after calibration.
