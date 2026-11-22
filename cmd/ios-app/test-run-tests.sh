#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
# Runs against real git, before the fake git below goes on PATH.
"$script_dir/test-restore-git-mtimes.sh"
fixture_dir="$(mktemp -d)"
trap 'rm -rf "$fixture_dir"' EXIT
mkdir -p "$fixture_dir/bin"

cat > "$fixture_dir/bin/xcodegen" <<'EOF'
#!/usr/bin/env bash
echo generated >> "$PWUSAGE_TEST_CALLS"
EOF
cat > "$fixture_dir/bin/xcrun" <<'EOF'
#!/usr/bin/env bash
if [[ "$1 $2" == 'simctl bootstatus' ]]; then
  echo "boot:$3 $4" >> "$PWUSAGE_TEST_CALLS"
  echo $$ > "$PWUSAGE_TEST_CALLS.boot-pid"
  [[ "${PWUSAGE_TEST_BOOT_HANG:-0}" == 1 ]] && sleep 30
  [[ "${PWUSAGE_TEST_BOOT_FAIL:-0}" == 1 ]] && exit 3
  exit 0
fi
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
echo "xcodebuild:${*: -1}" >> "$PWUSAGE_TEST_CALLS"
echo "env:TEST_RUNNER_PWUSAGE_SOLAR_SLOW_PARITY=${TEST_RUNNER_PWUSAGE_SOLAR_SLOW_PARITY:-}" >> "$PWUSAGE_TEST_ARGS"
if [[ "${PWUSAGE_TEST_HANG:-0}" == 1 ]]; then
  sleep 30
fi
if [[ "${PWUSAGE_TEST_BUILD_FAIL:-0}" == 1 && "${*: -1}" == build-for-testing ]]; then
  echo 'BUILD FAILED'
  exit 65
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
# The tests build first (while the simulator boots), then run from those products.
grep -qE '^test-without-building$' "$PWUSAGE_TEST_ARGS"
[[ "$(grep -E '^xcodebuild:' "$PWUSAGE_TEST_CALLS" | tail -2 | tr '\n' ' ')" == 'xcodebuild:build-for-testing xcodebuild:test-without-building ' ]] || {
  cat "$PWUSAGE_TEST_CALLS"; echo 'Expected build-for-testing, then test-without-building' >&2; exit 1; }
grep -qE '^id=TEST-UDID$' "$PWUSAGE_TEST_ARGS"
grep -qE '^-parallel-testing-enabled$' "$PWUSAGE_TEST_ARGS"
grep -qE '^-collect-test-diagnostics$' "$PWUSAGE_TEST_ARGS"
grep -qE '^on-failure$' "$PWUSAGE_TEST_ARGS"
grep -qE '^COMPILER_INDEX_STORE_ENABLE=NO$' "$PWUSAGE_TEST_ARGS"
# The simulator boots alongside the build, with its own limit for a slow boot.
grep -qxF 'boot:TEST-UDID -b' "$PWUSAGE_TEST_CALLS"

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
grep -qxF 'boot:PINNED -b' "$PWUSAGE_TEST_CALLS"

# A simulator that fails to boot stops the run before any test runs.
: > "$PWUSAGE_TEST_CALLS"
PWUSAGE_TEST_BOOT_FAIL=1 expect_failure 3 'did not boot' --
if grep -qE '^xcodebuild:test-without-building$' "$PWUSAGE_TEST_CALLS"; then
  echo 'Tests ran after the simulator failed to boot' >&2
  exit 1
fi
# A failed build stops the run with the build's status, without running tests.
: > "$PWUSAGE_TEST_CALLS"
PWUSAGE_TEST_BUILD_FAIL=1 expect_failure 65 'BUILD FAILED' --
if grep -qE '^xcodebuild:test-without-building$' "$PWUSAGE_TEST_CALLS"; then
  echo 'Tests ran after the build failed' >&2
  exit 1
fi
# A failed build stops a boot that is still running before the run exits.
started=$SECONDS
PWUSAGE_TEST_BUILD_FAIL=1 PWUSAGE_TEST_BOOT_HANG=1 expect_failure 65 'BUILD FAILED' --
(( SECONDS - started < 10 )) || { echo 'A failed build waited for the boot' >&2; exit 1; }
if kill -0 "$(cat "$PWUSAGE_TEST_CALLS.boot-pid")" 2> /dev/null; then
  echo 'The simulator boot kept running after the build failed' >&2
  exit 1
fi
PWUSAGE_SIMULATOR_BOOT_TIMEOUT_SECONDS=0 expect_failure 2 'PWUSAGE_SIMULATOR_BOOT_TIMEOUT_SECONDS must be' --

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
  echo 'The default run skipped tests' >&2
  exit 1
fi

# The default run stays a Debug build without changing optimization level.
if grep -qE '^SWIFT_OPTIMIZATION_LEVEL=' "$PWUSAGE_TEST_ARGS"; then
  echo 'The default run changed the optimization level' >&2
  exit 1
fi

# --full builds optimized and skips nothing.
"$script_dir/run-tests.sh" --full
grep -qE '^SWIFT_OPTIMIZATION_LEVEL=-O$' "$PWUSAGE_TEST_ARGS"
if grep -qE '^-skip-testing:' "$PWUSAGE_TEST_ARGS"; then
  echo 'The full run skipped tests' >&2
  exit 1
fi

# --auto is an alias for the default Debug run.
"$script_dir/run-tests.sh" --auto
if grep -qE '^SWIFT_OPTIMIZATION_LEVEL=' "$PWUSAGE_TEST_ARGS"; then
  echo '--auto changed the optimization level' >&2
  exit 1
fi
if grep -qE '^-skip-testing:' "$PWUSAGE_TEST_ARGS"; then
  echo '--auto skipped tests' >&2
  exit 1
fi
"$script_dir/run-tests.sh" --quick AppConfigurationTests
grep -qE '^-only-testing:PWUsageTests/AppConfigurationTests$' "$PWUSAGE_TEST_ARGS"
if grep -qE '^-skip-testing:' "$PWUSAGE_TEST_ARGS"; then
  echo '--quick passed -skip-testing: when quick-test-skips.txt is empty' >&2
  exit 1
fi

# CI keeps a stable derived-data directory between runs; without it the build products are throwaway.
derived_data="$fixture_dir/derived-data"
PWUSAGE_DERIVED_DATA="$derived_data" "$script_dir/run-tests.sh"
grep -qxF -- "$derived_data" "$PWUSAGE_TEST_ARGS" || {
  echo 'PWUSAGE_DERIVED_DATA did not set -derivedDataPath' >&2
  exit 1
}
[[ -d "$derived_data" ]] || { echo 'PWUSAGE_DERIVED_DATA was not created' >&2; exit 1; }
"$script_dir/run-tests.sh"
grep -qE '/pwusage-ios-tests\.[^/]+/DerivedData$' "$PWUSAGE_TEST_ARGS" || {
  echo 'The default derived-data path is no longer a throwaway directory' >&2
  exit 1
}

# --build-only (CI on main) builds the default Debug tests without running them, so pull requests
# can start from main's build products; it reads no test result bundle and takes no filters.
: > "$PWUSAGE_TEST_CALLS"
PWUSAGE_TEST_EXECUTED=0 PWUSAGE_TEST_CHANGED='cmd/ios-app/run-tests.sh' "$script_dir/run-tests.sh" --build-only
grep -qE '^build-for-testing$' "$PWUSAGE_TEST_ARGS"
if grep -qE '^boot:' "$PWUSAGE_TEST_CALLS"; then
  echo '--build-only booted a simulator it does not use' >&2
  exit 1
fi
if grep -qE '^(test|SWIFT_OPTIMIZATION_LEVEL=.*|-skip-testing:.*)$' "$PWUSAGE_TEST_ARGS"; then
  echo '--build-only ran tests, built optimized or filtered suites' >&2
  exit 1
fi
grep -qE '^COMPILER_INDEX_STORE_ENABLE=NO$' "$PWUSAGE_TEST_ARGS"
expect_failure 2 'takes no test filters' -- --build-only AppConfigurationTests

export PWUSAGE_TEST_HANG=1
export PWUSAGE_TEST_TIMEOUT_SECONDS=1
started=$SECONDS
set +e
"$script_dir/run-tests.sh" > "$fixture_dir/timeout-output" 2>&1
status=$?
set -e
[[ "$status" == 124 ]] || { cat "$fixture_dir/timeout-output"; echo "Expected timeout exit 124, got $status" >&2; exit 1; }
(( SECONDS - started < 10 )) || { echo 'Timeout took too long' >&2; exit 1; }

# A simulator boot that hangs is stopped at its own limit, separately from the test run's.
unset PWUSAGE_TEST_HANG
export PWUSAGE_TEST_TIMEOUT_SECONDS=600
started=$SECONDS
PWUSAGE_TEST_BOOT_HANG=1 PWUSAGE_SIMULATOR_BOOT_TIMEOUT_SECONDS=1 expect_failure 124 'Simulator boot exceeded 1s' --
(( SECONDS - started < 10 )) || { echo 'Boot timeout took too long' >&2; exit 1; }

echo 'run-tests.sh checks passed'
