# Smart Shift property tests implementation plan

**Goal:** Integrate reproducible generated forecast scenarios and independent accounting checks into Swift Testing.

**Architecture:** Test-only seeded fixtures exercise all three projection modes. A simple overlap-based reference calculator independently computes period balances, marginal costs, and safety. An opt-in suite executes 500 seeds; a separate opt-in stress suite runs 10,000. Normal runs keep only the pinned rounding regression. Failures include a seed and full fixture JSON for replay.

**Tech stack:** Swift Testing, existing iOS run-tests.sh and XcodeGen scheme.

1. Add deterministic scenario fixtures and independent overlap accounting; retain existing targeted regression tests.
2. Add parameterized valid-case checks, equivalent-input checks, freshness boundaries, and oracle sanity checks. Require a comparison for every valid generated scenario.
3. Add opt-in stress configuration and document replay and limitations.
4. Run targeted and full iOS tests through run-tests.sh; verify lint, web tests, build, and diff. Commit verified changes.

## Outcome

- Added 500 deterministic opt-in cases, 10,000 opt-in stress cases, single-seed replay, and serialized diagnostics.
- Added independent accounting and selection checks, all-mode/all-safety coverage assertions, and targeted boundary/invalid-context checks.
- Stress seed 4610 exposed a 2.3e-15 kWh positive remainder wrongly activating the cloudy-week safety rule. Reproduced before fixing, added a pinned regression, and ignored bank remainders at or below 1e-9 kWh.
- Full iOS run including stress and replay: 688 tests across 42 suites passed; stress cases took 37.6 seconds (full test execution 47.3 seconds).
- Web lint passed; web tests: 1,422 passed, 156 skipped. Production build passed with `npm run build -- --webpack`; default Turbopack build hit a local worker port permission error in this environment.
- Independent code review found no blocking issues; adopted its suggestion to pin regression inputs.

- User preference update: all generated/property tests are opt-in via PWUSAGE_FUZZ=1; only the small pinned regression remains in normal test runs. Stress and replay retain separate opt-in flags.
- Verified final opt-in behavior: default targeted run skipped all generated suites and ran the pinned regression in 6 ms; PWUSAGE_FUZZ=1 ran the 500-case corpus and all nine property tests successfully in 2.8 seconds.
