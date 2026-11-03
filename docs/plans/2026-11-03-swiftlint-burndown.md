# SwiftLint baseline burndown

Goal: `.swiftlint-baseline.json` reaches zero entries without loosening
`.swiftlint.yml`. Work happens on `chore/swiftlint-burndown`, based on `main`,
in `.worktrees/swiftlint-burndown`.

## Verification

Every batch must pass all three, in order:

```bash
./cmd/ios-app/format.sh
swiftlint lint cmd/ios-app --strict --baseline .swiftlint-baseline.json
cd cmd/ios-app && ./run-tests.sh --quick
```

Two environment notes:

- `swiftlint lint` exits non-zero here after printing `Found 0 violations`
  because the sandbox blocks a plist write. Read the `Found N violations` line
  instead of trusting the exit code.
- The iOS build needs full filesystem access: Swift's `#Preview` macro plugin
  server fails under the workspace sandbox with
  `PreviewsMacros.Common could not be found`.

## Re-stamping the baseline

Baseline entries match on file plus the offending line's text, not on line
number. Any edit that changes such a line (even by one character) makes its
entry stale and the violation reappears. After a batch, re-stamp so the file
records exactly what is left:

```bash
swiftlint lint cmd/ios-app --write-baseline .swiftlint-baseline.json --quiet
```

Only do this when the raw count went down; the file is the record of debt, not
a place to hide new violations.

## Progress

| Batch | Rules | Cleared |
| --- | --- | --- |
| A | `implicit_optional_initialization`, `empty_count`, `control_statement` | 39 |
| A2 | `trailing_comma` (by fixing the SwiftFormat conflict) | 43 |
| B | `statement_position` | 16 |
| C | `force_unwrapping` | 39 |
| D | data conversions, `type_name`, `static_over_final_class`, `force_try` | 12 |
| E | `identifier_name` | 63 |

Baseline: 1091 -> 874 entries. All 962 quick tests pass.

## Remaining

### 1. `line_length` (802, the bulk)

Median offending line is 132 characters, so most need a wrap rather than a
rewrite. In order of density:

- Tests: `SmartShiftPresentationTests` (129), `LoadTimingForecastEstimatorTests`
  (102), `MobileContractsTests` (37), `PWUsageAPITests` (26),
  `MobileAuthServiceTests` (21), then a long tail.
- App: `dashboard-previews` (19), `smart-shift-context` (14), `tariff-sheet`
  (11), `load-timing-view` (10), and a long tail.

Approaches that work:

- Wrap argument lists at the open paren, keeping the existing aligned style.
- Extract a local (`let message = ...`) when a single interpolated string is
  the offender.
- Long JSON fixtures in tests: build them from a multi-line raw string or from
  decoded model values instead of one line. Do not split a literal in a way
  that changes its bytes.
- Never add `// swiftlint:disable:next line_length`; there are five of those
  already and they are part of this debt.

### 2. Structural rules (65)

These are not mechanical and need design changes:

- `function_parameter_count` (17): group related parameters into a struct
  (e.g. `LoadTimingForecastEstimator.score`'s balance/rate/steps bundle,
  `SmartShiftPresentation`'s presentation inputs).
- `large_tuple` (14): mostly test fixtures; replace with small named structs.
  `SmartShiftPresentationTests` has eight of them.
- `file_length` / `type_body_length` (7 each): split test suites and large
  types into extensions or separate files.
- `function_body_length` (10) and `cyclomatic_complexity` (12): extract helpers
  from the forecast estimator and presentation builders.
- `nesting` (5): flatten nested types in `load-timing-forecast-projection`,
  `mobile-live-contract`, and `battery-hold-activity-attributes`.

### 3. Inline suppressions (14)

The baseline reaching zero is not the same as zero exceptions. Remaining
`swiftlint:disable` comments, and what unblocks each:

- `open-meteo-weather`, `OpenMeteoClientTests`: `nesting`
- `open-meteo-array-model`: `function_parameter_count`
- `LoadTimingForecastEstimatorTests`: `file_length` + 5x `line_length`
- `load-profile-store`, `BillOutlookPresentationTests`: `line_length`
- `solar-layout-fixture-loader`: `identifier_name` (`kw`)
- `demo-mode-controller`: `implicit_optional_initialization` on an `@Entry`
  property, where the macro needs the explicit default
- `load-timing-view`: `redundant_discardable_let`, where `_ =` breaks
  ViewBuilder type-checking

The last two look like genuine tool false positives; keep them documented
rather than contorting the code.

## Decisions worth keeping

- `.swiftformat` sets `--commas never`. It used to say `--trailing-commas
  always`, which made the formatter create exactly the trailing commas that
  SwiftLint's `trailing_comma` rule then rejected.
- Do not run `swiftlint --fix` across all rules. `statement_position` collapses
  `do`/`catch` into 200-character lines, and `redundant_discardable_let`
  produces code that does not compile in a ViewBuilder.
