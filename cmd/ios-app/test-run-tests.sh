#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
fixture_dir="$(mktemp -d)"
trap 'rm -rf "$fixture_dir"' EXIT
mkdir -p "$fixture_dir/bin"

cat > "$fixture_dir/bin/xcodegen" <<'EOF'
#!/usr/bin/env bash
echo generated >> "$PWUSAGE_TEST_CALLS"
EOF
cat > "$fixture_dir/bin/xcrun" <<'EOF'
#!/usr/bin/env bash
if [[ "$1" == xcresulttool ]]; then
  printf '{"totalTestCount":%s,"passedTests":%s,"failedTests":0,"skippedTests":0,"expectedFailures":0}\n' \
    "${PWUSAGE_TEST_EXECUTED:-5}" "${PWUSAGE_TEST_EXECUTED:-5}"
  exit 0
fi
if [[ -n "${PWUSAGE_TEST_DEVICES:-}" ]]; then
  printf '%s\n' "$PWUSAGE_TEST_DEVICES"
  exit 0
fi
# A booted device below the iOS 18 deployment target, an iPad and a non-iOS
# runtime must never win over an iPhone on the newest eligible runtime.
cat <<'JSON'
{"devices":{
  "com.apple.CoreSimulator.SimRuntime.iOS-17-5":[{"name":"iPhone 15","udid":"OLD-UDID","state":"Booted","isAvailable":true}],
  "com.apple.CoreSimulator.SimRuntime.iOS-18-0":[{"name":"iPhone 16","udid":"MID-UDID","state":"Booted","isAvailable":true}],
  "com.apple.CoreSimulator.SimRuntime.iOS-27-0":[{"name":"iPad Pro","udid":"IPAD-UDID","state":"Booted","isAvailable":true},
    {"name":"iPhone 17","udid":"TEST-UDID","state":"Shutdown","isAvailable":true}],
  "com.apple.CoreSimulator.SimRuntime.watchOS-27-0":[{"name":"iPhone-named watch","udid":"WATCH-UDID","state":"Booted","isAvailable":true}]}}
JSON
EOF
cat > "$fixture_dir/bin/xcodebuild" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$PWUSAGE_TEST_ARGS"
echo "env:TEST_RUNNER_PWUSAGE_SOLAR_SLOW_PARITY=${TEST_RUNNER_PWUSAGE_SOLAR_SLOW_PARITY:-}" >> "$PWUSAGE_TEST_ARGS"
if [[ "${PWUSAGE_TEST_HANG:-0}" == 1 ]]; then
  sleep 30
fi
EOF
# Reports PWUSAGE_TEST_CHANGED (newline-separated, repo-relative) as the branch diff;
# PWUSAGE_TEST_NO_BASE=1 makes merge-base fail.
cat > "$fixture_dir/bin/git" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  merge-base) [[ "${PWUSAGE_TEST_NO_BASE:-0}" == 1 ]] && exit 1; echo BASE ;;
  diff)
    [[ "${PWUSAGE_TEST_DIFF_FAIL:-0}" == 1 ]] && exit 1
    [[ -n "${PWUSAGE_TEST_CHANGED:-}" ]] && printf '%s\n' "$PWUSAGE_TEST_CHANGED"
    ;;
esac
exit 0
EOF
chmod +x "$fixture_dir/bin/"*

export PATH="$fixture_dir/bin:$PATH"
export PWUSAGE_TEST_CALLS="$fixture_dir/calls"
export PWUSAGE_TEST_ARGS="$fixture_dir/args"

"$script_dir/run-tests.sh"
grep -qE '^generated$' "$PWUSAGE_TEST_CALLS"
grep -qE '^test$' "$PWUSAGE_TEST_ARGS"
grep -qE '^id=TEST-UDID$' "$PWUSAGE_TEST_ARGS"
grep -qE '^-parallel-testing-enabled$' "$PWUSAGE_TEST_ARGS"
grep -qE '^-collect-test-diagnostics$' "$PWUSAGE_TEST_ARGS"
grep -qE '^on-failure$' "$PWUSAGE_TEST_ARGS"
grep -qE '^COMPILER_INDEX_STORE_ENABLE=NO$' "$PWUSAGE_TEST_ARGS"

# expect_failure <expected-status> <output-pattern> -- <run-tests.sh args...>
expect_failure() {
  local expected="$1" pattern="$2"
  shift 3
  local status
  set +e
  "$script_dir/run-tests.sh" "$@" > "$fixture_dir/output" 2>&1
  status=$?
  set -e
  [[ "$status" == "$expected" ]] || { cat "$fixture_dir/output"; echo "Expected exit $expected, got $status" >&2; exit 1; }
  grep -q "$pattern" "$fixture_dir/output" || { cat "$fixture_dir/output"; echo "Expected output matching: $pattern" >&2; exit 1; }
}

# Simulator selection: newest iOS runtime at or above the deployment target wins,
# preferring a booted device within it.
PWUSAGE_TEST_DEVICES='{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-27-0":[{"name":"iPhone 17","udid":"COLD","state":"Shutdown","isAvailable":true},{"name":"iPhone 17 Pro","udid":"WARM","state":"Booted","isAvailable":true}]}}' \
  "$script_dir/run-tests.sh"
grep -qE '^id=WARM$' "$PWUSAGE_TEST_ARGS"
PWUSAGE_TEST_DEVICES='{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-17-5":[{"name":"iPhone 15","udid":"OLD","state":"Booted","isAvailable":true}]}}' \
  expect_failure 2 'iOS 18.0 or newer' --
PWUSAGE_SIMULATOR_ID=PINNED "$script_dir/run-tests.sh"
grep -qE '^id=PINNED$' "$PWUSAGE_TEST_ARGS"

# A bare test-target name runs the whole bundle, not an invented suite.
"$script_dir/run-tests.sh" PWUsageTests
grep -qE '^-only-testing:PWUsageTests$' "$PWUSAGE_TEST_ARGS"
if grep -qE 'PWUsageTests/PWUsageTests' "$PWUSAGE_TEST_ARGS"; then
  echo 'Bare PWUsageTests was rewritten into a suite filter' >&2
  exit 1
fi

# A run that executes zero tests (e.g. a misspelled suite) fails even though
# xcodebuild exits 0.
PWUSAGE_TEST_EXECUTED=0 expect_failure 1 'executed 0 tests' -- AppConfigurationTset
PWUSAGE_TEST_EXECUTED=0 expect_failure 1 'executed 0 tests' --

# Missing tools fail fast with an actionable hint instead of a bare 127.
mkdir -p "$fixture_dir/no-xcodegen"
cp "$fixture_dir/bin/xcrun" "$fixture_dir/bin/xcodebuild" "$fixture_dir/no-xcodegen/"
PATH="$fixture_dir/no-xcodegen:/usr/bin:/bin" expect_failure 127 'brew install xcodegen' --

# Test suite filter normalization
"$script_dir/run-tests.sh" AppConfigurationTests
grep -qE '^-only-testing:PWUsageTests/AppConfigurationTests$' "$PWUSAGE_TEST_ARGS"

# Test method filter normalization (appends ())
"$script_dir/run-tests.sh" AppConfigurationTests/defaultsToProductionAPIOrigin
grep -qE '^-only-testing:PWUsageTests/AppConfigurationTests/defaultsToProductionAPIOrigin\(\)$' "$PWUSAGE_TEST_ARGS"

# Test full method filter preservation
"$script_dir/run-tests.sh" "PWUsageTests/AppConfigurationTests/defaultsToProductionAPIOrigin()"
grep -qE '^-only-testing:PWUsageTests/AppConfigurationTests/defaultsToProductionAPIOrigin\(\)$' "$PWUSAGE_TEST_ARGS"

# Test explicit flag passthrough
"$script_dir/run-tests.sh" -skip-testing:PWUsageTests/MobileContractsTests
grep -qE '^-skip-testing:PWUsageTests/MobileContractsTests$' "$PWUSAGE_TEST_ARGS"

# --quick skips every suite in quick-test-skips.txt; the full run (no flag) skips none of them.
"$script_dir/run-tests.sh" --quick
while IFS= read -r skipped || [[ -n "$skipped" ]]; do
  if [[ -n "$skipped" ]]; then
    grep -qxF -- "-skip-testing:$skipped" "$PWUSAGE_TEST_ARGS"
  fi
done < "$script_dir/quick-test-skips.txt"
PWUSAGE_TEST_CHANGED='cmd/ios-app/PWUsage/Models/Solar/LayoutDetection/LayoutFit.swift' "$script_dir/run-tests.sh"
if grep -qE '^-skip-testing:' "$PWUSAGE_TEST_ARGS"; then
  echo 'The default run skipped tests on a detector change' >&2
  exit 1
fi

# The default run skips detector parity unless the branch touches the detector or its fixtures.
parity_skip='-skip-testing:PWUsageTests/SolarLayoutDetectorFixtureParityTests'
expect_parity() {
  local expected="$1" label="$2"
  if grep -qxF -- "$parity_skip" "$PWUSAGE_TEST_ARGS"; then local ran=0; else local ran=1; fi
  [[ "$ran" == "$expected" ]] || { echo "Detector parity: $label (ran=$ran, want $expected)" >&2; exit 1; }
}
PWUSAGE_TEST_CHANGED='cmd/ios-app/PWUsage/State/Home/DashboardCoordinator.swift' "$script_dir/run-tests.sh"
expect_parity 0 'ran without detector changes'
for changed in PWUsage/Models/Solar/SolarPosition.swift PWUsage/Models/Solar/MobileSolarLayout.swift \
  PWUsageTests/Fixtures/SolarLayout/east-west-30d.json PWUsageTests/Fixtures/SolarLayoutFixtureLoader.swift \
  PWUsageTests/SolarLayoutDetectorTests.swift PWUsageTests/SolarLayoutSunPOATests.swift \
  project.yml run-tests.sh; do
  PWUSAGE_TEST_CHANGED="cmd/ios-app/$changed" "$script_dir/run-tests.sh"
  expect_parity 1 "skipped after changing $changed"
done
PWUSAGE_TEST_CHANGED=".github/workflows/ios.yml" "$script_dir/run-tests.sh"
expect_parity 1 "skipped after changing .github/workflows/ios.yml"
# Adjacent layout infrastructure tests must not pull in the multi-minute parity suite.
for changed in PWUsageTests/SolarLayoutCloudSyncTests.swift PWUsageTests/SolarLayoutSessionCleanupTests.swift; do
  PWUSAGE_TEST_CHANGED="cmd/ios-app/$changed" "$script_dir/run-tests.sh"
  expect_parity 0 "ignored $changed"
done
PWUSAGE_TEST_NO_BASE=1 "$script_dir/run-tests.sh"
expect_parity 1 'skipped without a merge base'
PWUSAGE_TEST_DIFF_FAIL=1 "$script_dir/run-tests.sh"
expect_parity 1 'skipped when diff failed'
PWUSAGE_DETECTOR_PARITY=1 "$script_dir/run-tests.sh"
expect_parity 1 'PWUSAGE_DETECTOR_PARITY=1 did not force it'
PWUSAGE_DETECTOR_PARITY=0 PWUSAGE_TEST_CHANGED='cmd/ios-app/PWUsageTests/SolarLayoutDetectorTests.swift' \
  "$script_dir/run-tests.sh"
expect_parity 0 'PWUSAGE_DETECTOR_PARITY=0 did not skip it'
"$script_dir/run-tests.sh" SolarLayoutDetectorFixtureParityTests
expect_parity 1 'a named filter was gated'
# The default run stays a Debug build without the opt-in year suite.
if grep -qE '^SWIFT_OPTIMIZATION_LEVEL=' "$PWUSAGE_TEST_ARGS"; then
  echo 'The default run changed the optimization level' >&2
  exit 1
fi
grep -qE '^env:TEST_RUNNER_PWUSAGE_SOLAR_SLOW_PARITY=$' "$PWUSAGE_TEST_ARGS"
# --full (CI) builds optimized, opens the year-parity gate, and skips nothing.
"$script_dir/run-tests.sh" --full
grep -qE '^SWIFT_OPTIMIZATION_LEVEL=-O$' "$PWUSAGE_TEST_ARGS"
grep -qE '^env:TEST_RUNNER_PWUSAGE_SOLAR_SLOW_PARITY=1$' "$PWUSAGE_TEST_ARGS"
if grep -qE '^-skip-testing:' "$PWUSAGE_TEST_ARGS"; then
  echo 'The full run skipped tests' >&2
  exit 1
fi

# --auto promotes to --full on detector changes and stays default without them.
for changed in cmd/ios-app/PWUsage/Models/Solar/LayoutDetection/LayoutFit.swift \
  cmd/ios-app/project.yml cmd/ios-app/run-tests.sh .github/workflows/ios.yml; do
  PWUSAGE_TEST_CHANGED="$changed" "$script_dir/run-tests.sh" --auto
  grep -qE '^SWIFT_OPTIMIZATION_LEVEL=-O$' "$PWUSAGE_TEST_ARGS"
  grep -qE '^env:TEST_RUNNER_PWUSAGE_SOLAR_SLOW_PARITY=1$' "$PWUSAGE_TEST_ARGS"
  if grep -qE '^-skip-testing:' "$PWUSAGE_TEST_ARGS"; then
    echo "--auto with $changed skipped tests" >&2
    exit 1
  fi
done

PWUSAGE_TEST_CHANGED='cmd/ios-app/PWUsage/State/Home/DashboardCoordinator.swift' "$script_dir/run-tests.sh" --auto
if grep -qE '^SWIFT_OPTIMIZATION_LEVEL=' "$PWUSAGE_TEST_ARGS"; then
  echo '--auto without detector changes built optimized' >&2
  exit 1
fi
grep -qE '^env:TEST_RUNNER_PWUSAGE_SOLAR_SLOW_PARITY=$' "$PWUSAGE_TEST_ARGS"
grep -qxF -- "$parity_skip" "$PWUSAGE_TEST_ARGS" || {
  echo '--auto without detector changes did not skip parity suites' >&2
  exit 1
}

# PWUSAGE_DETECTOR_PARITY overrides --auto as well.
PWUSAGE_DETECTOR_PARITY=1 "$script_dir/run-tests.sh" --auto
grep -qE '^SWIFT_OPTIMIZATION_LEVEL=-O$' "$PWUSAGE_TEST_ARGS"
grep -qE '^env:TEST_RUNNER_PWUSAGE_SOLAR_SLOW_PARITY=1$' "$PWUSAGE_TEST_ARGS"

PWUSAGE_DETECTOR_PARITY=0 PWUSAGE_TEST_CHANGED='cmd/ios-app/PWUsageTests/SolarLayoutDetectorTests.swift' \
  "$script_dir/run-tests.sh" --auto
if grep -qE '^SWIFT_OPTIMIZATION_LEVEL=' "$PWUSAGE_TEST_ARGS"; then
  echo 'PWUSAGE_DETECTOR_PARITY=0 with --auto built optimized' >&2
  exit 1
fi
grep -qxF -- "$parity_skip" "$PWUSAGE_TEST_ARGS" || {
  echo 'PWUSAGE_DETECTOR_PARITY=0 with --auto did not skip parity suites' >&2
  exit 1
}
"$script_dir/run-tests.sh" --quick AppConfigurationTests
grep -qE '^-only-testing:PWUsageTests/AppConfigurationTests$' "$PWUSAGE_TEST_ARGS"
grep -qE '^-skip-testing:PWUsageTests/SolarLayoutDetectorFixtureParityTests$' "$PWUSAGE_TEST_ARGS"

export PWUSAGE_TEST_HANG=1
export PWUSAGE_TEST_TIMEOUT_SECONDS=1
started=$SECONDS
set +e
"$script_dir/run-tests.sh" > "$fixture_dir/timeout-output" 2>&1
status=$?
set -e
[[ "$status" == 124 ]] || { cat "$fixture_dir/timeout-output"; echo "Expected timeout exit 124, got $status" >&2; exit 1; }
(( SECONDS - started < 10 )) || { echo 'Timeout took too long' >&2; exit 1; }

echo 'run-tests.sh checks passed'
