# Smart Shift generated tests

`SmartShiftPropertyTests` runs in the normal suite (about 2.5 seconds) and checks 500 stable seeds plus explicit
freshness, rate-change, missing-context, forecast-gap,
serialization, tariff-order, and accounting-anchor cases. A coverage assertion
requires every projection mode and all three safety outcomes to be exercised.
Every valid generated case must return a comparison; unavailable is not a pass.

From `cmd/ios-app`:

```sh
./run-tests.sh SmartShiftPropertyTests
PWUSAGE_FUZZ_STRESS=1 ./run-tests.sh SmartShiftStressTests
PWUSAGE_FUZZ_SEED=4610 ./run-tests.sh SmartShiftReplayTests
```

The 500-case generated suite and the pinned `SmartShiftRegressionTests` run by
default, including in Xcode, so estimator changes are checked on every run.

The stress suite adds 10,000 cases (seeds 500–10499) and is disabled by default,
including in Xcode. The replay suite is also disabled unless a seed is supplied.
The script forwards these settings through the test scheme to the simulator.
Stress runs use the existing ten-minute timeout. They can be invoked by CI;
no new scheduled workflow is installed.

## Reproducing and retaining failures

Failures report the seed and complete version-1 JSON scenario, with dates encoded
as Foundation's seconds since 2001. The seed replays with the command above;
JSON can also be decoded as `SmartShiftScenario` if the generator later changes.
The SplitMix64 generator uses wrapping arithmetic and no process-global random
state. Do not silently change version-1 seed generation. Preserve discovered
cases as named normal-suite regressions, simplifying inputs where possible.

## Oracle and scope

`SmartShiftReference` calculates exact overlaps directly across tariff segments,
without calling production integration, scoring, or safety helpers. It checks
bill-date balances, marginal cost, energy conservation, safety eligibility and
ranking, and the one-cent preference for starting now. Hand-calculated anchors
check the oracle itself. Older-server forecasts intentionally bypass safety.

Generated contexts currently have constant household/battery/history power;
forecast-to-history transitions still change power. Dates include DST and leap
day cases and zones include Chicago, Lord Howe, Kathmandu and UTC. Existing
estimator tests remain responsible for varying wall-clock history slots and
candidate-boundary enumeration. Ranking uses the estimator's advertised start
set, so it does not establish global optimality between those starts. This is
seeded property testing, not coverage-guided byte fuzzing or automatic shrinking.

Compare floating-point accounting with a 1e-7 tolerance (kWh or currency as
appropriate). The safety policy ignores positive bank remainders at or below
1e-9 kWh: they cannot represent meaningful export cushion but could otherwise
activate an unrelated large cautious shortfall.
