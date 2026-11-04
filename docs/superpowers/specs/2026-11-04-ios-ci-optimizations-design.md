# Design: iOS CI Test Run Gating and Build Optimizations

**Date**: 2026-11-04  
**Author**: Kevin Miller & Antigravity  
**Status**: Proposed  

## Problem Statement

iOS CI runs currently take ~16 minutes on GitHub Actions `macos-15` runners, with occasional timeouts under heavy runner queue load.

Two issues contribute to this:
1. **Unconditional `--full` test runs**: Every PR currently executes `./run-tests.sh --full`. This forces `SWIFT_OPTIMIZATION_LEVEL=-O` (Whole Module Optimization) across the entire project and runs the opt-in year-fixture solar layout parity tests, even when the PR only changes unrelated UI, coordinators, formatters, or docs. Under load on `macos-15`, compiling the optimized project alone takes ~12.5 minutes.
2. **Compiler indexing overhead**: `xcodebuild` generates the Xcode symbol index store by default during builds, creating unnecessary I/O and CPU overhead during CI test runs.

Local runs already feature a `detector_changed` git diff check that skips the multi-minute parity suite in default mode if no solar detection files changed. However, CI was never wired to leverage this gate, nor did `run-tests.sh` have an automatic mode to promote to `--full` when the detector did change.

## Goals

1. **Reduce CI runtime for standard PRs to ~3–4 minutes**: Skip Whole Module Optimization (`-O`) and year-parity fixtures for PRs that do not touch solar layout detection.
2. **Preserve full mathematical parity verification**: Automatically promote to `--full` (`-O` + year fixtures) when changes touch solar layout detection code or test fixtures, or during manual workflow dispatches.
3. **Eliminate compilation index store overhead**: Pass `COMPILER_INDEX_STORE_ENABLE=NO` during test builds.
4. **Reliable CI diff detection**: Ensure `actions/checkout` in GitHub Actions fetches repository history (`fetch-depth: 0`) so `git merge-base` against `origin/main` functions correctly in runner environments.

## Detailed Architecture & Changes

### 1. `cmd/ios-app/run-tests.sh`

Add an `--auto` flag to `run-tests.sh`:
- When `--auto` is passed, `run-tests.sh` inspects whether solar layout detection code or fixtures changed using the existing `detector_changed` function (honoring `PWUSAGE_DETECTOR_PARITY` if set):
  - If `detector_changed == 1`: promotes `mode=full`. Sets `SWIFT_OPTIMIZATION_LEVEL=-O` and `TEST_RUNNER_PWUSAGE_SOLAR_SLOW_PARITY=1`.
  - If `detector_changed == 0`: keeps `mode=default`. Leaves compilation in Debug (`-Onone`) and skips `SolarLayoutDetectorFixtureParityTests` and `SolarLayoutClearDaysParityTests`.
- Add `COMPILER_INDEX_STORE_ENABLE=NO` to the `xcodebuild` arguments to skip index store generation during test runs.

### 2. `cmd/ios-app/test-run-tests.sh`

Update the test runner test suite to verify:
- `--auto` without detector changes runs in default mode (Debug, skips parity suites).
- `--auto` with detector changes promotes to `--full` (sets `SWIFT_OPTIMIZATION_LEVEL=-O`, sets `TEST_RUNNER_PWUSAGE_SOLAR_SLOW_PARITY=1`, and skips no tests).
- `PWUSAGE_DETECTOR_PARITY=1` with `--auto` forces `--full`.
- `PWUSAGE_DETECTOR_PARITY=0` with `--auto` stays in default mode.
- `COMPILER_INDEX_STORE_ENABLE=NO` is passed to `xcodebuild`.

### 3. `.github/workflows/ios.yml`

- Update `actions/checkout@v7.0.1` to pass `fetch-depth: 0` so `git merge-base` against `origin/main` succeeds in PR checkouts.
- Update the `Run iOS Tests` step:
  - For `pull_request`: run `./run-tests.sh --auto`.
  - For `workflow_dispatch`: force full verification (`PWUSAGE_DETECTOR_PARITY=1 ./run-tests.sh --auto` or `./run-tests.sh --full`).
- Retain the 45-minute workflow timeout and 20-minute test step timeout as a safe upper bound.

### 4. Documentation (`cmd/ios-app/AGENTS.md`)

Update the documentation in `cmd/ios-app/AGENTS.md` under the Tests section to reflect the `--auto` flag and how CI evaluates whether to run `--full`.

## Verification & Testing Plan

1. Run `./cmd/ios-app/test-run-tests.sh` to ensure all existing and new runner assertions pass.
2. Run `./cmd/ios-app/lint.sh` to ensure no lint regressions.
3. Validate `run-tests.sh --auto` in the working tree against `origin/main`.
