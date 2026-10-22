#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

timeout_seconds="${PWUSAGE_TEST_TIMEOUT_SECONDS:-600}"
if [[ ! "$timeout_seconds" =~ ^[1-9][0-9]*$ ]]; then
  echo 'PWUSAGE_TEST_TIMEOUT_SECONDS must be a positive integer' >&2
  exit 2
fi

missing_tools=()
command -v xcodegen > /dev/null 2>&1 || missing_tools+=('xcodegen (brew install xcodegen)')
command -v xcodebuild > /dev/null 2>&1 || missing_tools+=('xcodebuild (install Xcode, then: sudo xcode-select -s /Applications/Xcode.app)')
command -v xcrun > /dev/null 2>&1 || missing_tools+=('xcrun (install Xcode command line tools)')
command -v python3 > /dev/null 2>&1 || missing_tools+=('python3 (xcode-select --install, or brew install python)')
if [[ "${#missing_tools[@]}" -gt 0 ]]; then
  echo 'run-tests.sh needs tools that are not on PATH:' >&2
  printf '  - %s\n' "${missing_tools[@]}" >&2
  exit 127
fi

./generate.sh

deployment_target="$(sed -n 's/^ *iOS: *"\{0,1\}\([0-9][0-9.]*\)"\{0,1\} *$/\1/p' project.yml | head -n 1)"
if [[ -z "$deployment_target" ]]; then
  echo 'Could not read the iOS deployment target from project.yml' >&2
  exit 2
fi

simulator_id="${PWUSAGE_SIMULATOR_ID:-}"
if [[ -z "$simulator_id" ]]; then
  simulator_id="$(xcrun simctl list -j devices available | python3 -c '
import json
import re
import sys

def version(text):
    return tuple(int(part) for part in text.split("."))

minimum = version(sys.argv[1])
candidates = []
for runtime, devices in json.load(sys.stdin)["devices"].items():
    match = re.search(r"\.iOS-(\d+(?:-\d+)*)$", runtime)
    if not match:
        continue
    runtime_version = version(match.group(1).replace("-", "."))
    if runtime_version < minimum:
        continue
    for device in devices:
        if device.get("isAvailable") and device.get("name", "").startswith("iPhone"):
            candidates.append((runtime_version, device.get("state") == "Booted", device["udid"]))
# Newest runtime first; within it, reuse a booted device.
candidates.sort(reverse=True)
if candidates:
    print(candidates[0][2])
' "$deployment_target")"
fi

if [[ -z "$simulator_id" ]]; then
  echo "No available iPhone simulator on iOS $deployment_target or newer. Install an iOS Simulator runtime in Xcode or set PWUSAGE_SIMULATOR_ID." >&2
  exit 2
fi

test_filter_args=()
for target in "$@"; do
  if [[ "$target" == -only-testing* || "$target" == -skip-testing* ]]; then
    test_filter_args+=("$target")
  elif [[ "$target" == PWUsageTests || "$target" == PWUsageTests/ ]]; then
    # The whole test bundle; never invent a PWUsageTests/PWUsageTests() suite.
    test_filter_args+=("-only-testing:PWUsageTests")
  else
    if [[ "$target" != PWUsageTests/* && "$target" != PWUsage/* ]]; then
      target="PWUsageTests/$target"
    fi
    if [[ "$target" =~ /[^/]+/[^/()]+$ ]]; then
      target="${target}()"
    fi
    test_filter_args+=("-only-testing:$target")
  fi
done

artifacts_dir="$(mktemp -d "${TMPDIR:-/tmp}/pwusage-ios-tests.XXXXXX")"
echo "Testing PWUsage on simulator $simulator_id (limit: ${timeout_seconds}s)"
if [[ "${#test_filter_args[@]}" -gt 0 ]]; then
  echo "Filters: ${test_filter_args[*]}"
fi
echo "Test artifacts: $artifacts_dir"

set +e
python3 - "$timeout_seconds" xcodebuild \
  -project PWUsage.xcodeproj \
  -scheme PWUsage \
  -destination "id=$simulator_id" \
  -parallel-testing-enabled NO \
  -collect-test-diagnostics on-failure \
  -derivedDataPath "$artifacts_dir/DerivedData" \
  -resultBundlePath "$artifacts_dir/TestResults.xcresult" \
  CODE_SIGNING_ALLOWED=NO \
  "PWUSAGE_FUZZ_STRESS=${PWUSAGE_FUZZ_STRESS:-0}" \
  "PWUSAGE_FUZZ_SEED=${PWUSAGE_FUZZ_SEED:-}" \
  ${test_filter_args[@]+"${test_filter_args[@]}"} \
  test <<'PY'
import os
import signal
import subprocess
import sys

timeout = int(sys.argv[1])
command = sys.argv[2:]
process = subprocess.Popen(command, start_new_session=True)

def stop_process():
    os.killpg(process.pid, signal.SIGTERM)
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()

try:
    status = process.wait(timeout=timeout)
except subprocess.TimeoutExpired:
    print(f"iOS test run exceeded {timeout}s; stopping xcodebuild and its children", file=sys.stderr)
    stop_process()
    status = 124
except KeyboardInterrupt:
    stop_process()
    status = 130
sys.exit(status)
PY
status=$?
set -e

# xcodebuild reports TEST SUCCEEDED when a filter matches nothing, so a green
# exit only counts if the result bundle shows tests actually ran.
if [[ "$status" -eq 0 ]]; then
  executed="$(xcrun xcresulttool get test-results summary --path "$artifacts_dir/TestResults.xcresult" --compact 2>/dev/null | python3 -c '
import json
import sys

try:
    summary = json.load(sys.stdin)
except ValueError:
    sys.exit(0)
print(sum(int(summary.get(key, 0)) for key in ("passedTests", "failedTests", "expectedFailures")))
' || true)"
  if [[ -z "$executed" ]]; then
    echo "Could not read the test count from $artifacts_dir/TestResults.xcresult" >&2
    status=1
  elif [[ "$executed" -eq 0 ]]; then
    echo 'xcodebuild reported success but executed 0 tests; check the test filter spelling.' >&2
    status=1
  else
    echo "Executed $executed tests"
  fi
fi

if [[ "$status" -eq 0 ]]; then
  rm -rf "$artifacts_dir"
else
  echo "iOS tests failed (exit $status). Artifacts retained at $artifacts_dir" >&2
fi
exit "$status"
