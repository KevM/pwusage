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
if [[ "${PWUSAGE_TEST_HANG:-0}" == 1 ]]; then
  sleep 30
fi
EOF
chmod +x "$fixture_dir/bin/"*

export PATH="$fixture_dir/bin:$PATH"
export PWUSAGE_TEST_CALLS="$fixture_dir/calls"
export PWUSAGE_TEST_ARGS="$fixture_dir/args"

"$script_dir/run-tests.sh"
rg -q '^generated$' "$PWUSAGE_TEST_CALLS"
rg -q '^test$' "$PWUSAGE_TEST_ARGS"
rg -q '^id=TEST-UDID$' "$PWUSAGE_TEST_ARGS"
rg -q '^-parallel-testing-enabled$' "$PWUSAGE_TEST_ARGS"
rg -q '^-collect-test-diagnostics$' "$PWUSAGE_TEST_ARGS"
rg -q '^on-failure$' "$PWUSAGE_TEST_ARGS"

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
rg -q '^id=WARM$' "$PWUSAGE_TEST_ARGS"
PWUSAGE_TEST_DEVICES='{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-17-5":[{"name":"iPhone 15","udid":"OLD","state":"Booted","isAvailable":true}]}}' \
  expect_failure 2 'iOS 18.0 or newer' --
PWUSAGE_SIMULATOR_ID=PINNED "$script_dir/run-tests.sh"
rg -q '^id=PINNED$' "$PWUSAGE_TEST_ARGS"

# A bare test-target name runs the whole bundle, not an invented suite.
"$script_dir/run-tests.sh" PWUsageTests
rg -q '^-only-testing:PWUsageTests$' "$PWUSAGE_TEST_ARGS"
if rg -q 'PWUsageTests/PWUsageTests' "$PWUSAGE_TEST_ARGS"; then
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
rg -q '^-only-testing:PWUsageTests/AppConfigurationTests$' "$PWUSAGE_TEST_ARGS"

# Test method filter normalization (appends ())
"$script_dir/run-tests.sh" AppConfigurationTests/defaultsToProductionAPIOrigin
rg -q '^-only-testing:PWUsageTests/AppConfigurationTests/defaultsToProductionAPIOrigin\(\)$' "$PWUSAGE_TEST_ARGS"

# Test full method filter preservation
"$script_dir/run-tests.sh" "PWUsageTests/AppConfigurationTests/defaultsToProductionAPIOrigin()"
rg -q '^-only-testing:PWUsageTests/AppConfigurationTests/defaultsToProductionAPIOrigin\(\)$' "$PWUSAGE_TEST_ARGS"

# Test explicit flag passthrough
"$script_dir/run-tests.sh" -skip-testing:PWUsageTests/MobileContractsTests
rg -q '^-skip-testing:PWUsageTests/MobileContractsTests$' "$PWUSAGE_TEST_ARGS"

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
