#!/usr/bin/env bash
# Usage: ./run-tests.sh [--quick | --full | --build-only] [test filters...]
#   --quick    Everyday sniff test for agents: Debug build, skips any suites listed in
#              quick-test-skips.txt.
#   (no flag)  Every app/widget test suite in PWUsageTests, Debug build.
#   --full     Optimized build (-O, still testable) for PWUsageTests.
#   --auto     Kept as an alias for default (core detector/health parity lives in run-core-tests.sh).
#   --build-only
#              Builds the default Debug tests without running them. CI runs it on main so pull
#              requests, which can only restore caches saved on main, start from Debug products.
set -euo pipefail

cd "$(dirname "$0")"

mode=default
case "${1:-}" in
  --quick) mode=quick; shift ;;
  --full) mode=full; shift ;;
  --auto) mode=default; shift ;;
  --build-only) mode=build; shift ;;
esac

if [[ "$mode" == build && "$#" -gt 0 ]]; then
  echo '--build-only takes no test filters' >&2
  exit 2
fi

timeout_seconds="${PWUSAGE_TEST_TIMEOUT_SECONDS:-600}"
if [[ ! "$timeout_seconds" =~ ^[1-9][0-9]*$ ]]; then
  echo 'PWUSAGE_TEST_TIMEOUT_SECONDS must be a positive integer' >&2
  exit 2
fi
# Booting the simulator has its own limit, so a slow boot does not eat into the test run's.
boot_timeout_seconds="${PWUSAGE_SIMULATOR_BOOT_TIMEOUT_SECONDS:-900}"
if [[ ! "$boot_timeout_seconds" =~ ^[1-9][0-9]*$ ]]; then
  echo 'PWUSAGE_SIMULATOR_BOOT_TIMEOUT_SECONDS must be a positive integer' >&2
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

if [[ "$mode" == quick ]]; then
  while IFS= read -r skipped || [[ -n "$skipped" ]]; do
    if [[ -n "$skipped" ]]; then
      test_filter_args+=("-skip-testing:$skipped")
    fi
  done < quick-test-skips.txt
fi

# Prints 1 when this branch, against its merge base with main, touches the detector or its fixtures.
# Without a merge base it prints 1, so an unknown diff never skips the parity suite.
mode_build_settings=()
if [[ "$mode" == full ]]; then
  mode_build_settings=(SWIFT_OPTIMIZATION_LEVEL=-O)
fi

# run_with_timeout LABEL SECONDS COMMAND... : runs COMMAND in its own process group and stops the
# whole group (exit 124) once SECONDS pass.
run_with_timeout() {
  python3 - "$@" <<'PY'
import os
import signal
import subprocess
import sys

label = sys.argv[1]
timeout = int(sys.argv[2])
command = sys.argv[3:]
process = subprocess.Popen(command, start_new_session=True)

def stop_process():
    os.killpg(process.pid, signal.SIGTERM)
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()

def on_terminate(signum, frame):
    # The script stops a background run (the simulator boot after a failed build) with SIGTERM;
    # the command is in its own session, so stop its whole group before exiting.
    stop_process()
    sys.exit(128 + signum)

signal.signal(signal.SIGTERM, on_terminate)

try:
    status = process.wait(timeout=timeout)
except subprocess.TimeoutExpired:
    print(f"{label} exceeded {timeout}s; stopping {os.path.basename(command[0])} and its children", file=sys.stderr)
    stop_process()
    status = 124
except KeyboardInterrupt:
    stop_process()
    status = 130
sys.exit(status)
PY
}

artifacts_dir="$(mktemp -d "${TMPDIR:-/tmp}/pwusage-ios-tests.XXXXXX")"
# CI points this at a directory it caches between runs; otherwise the build products are throwaway.
derived_data="${PWUSAGE_DERIVED_DATA:-$artifacts_dir/DerivedData}"
mkdir -p "$derived_data"
echo "Testing PWUsage ($mode run) on simulator $simulator_id (limit: ${timeout_seconds}s)"
if [[ "${#test_filter_args[@]}" -gt 0 ]]; then
  echo "Filters: ${test_filter_args[*]}"
fi
echo "Test artifacts: $artifacts_dir"

# Settings shared by the build and the test run, so the test run uses exactly the products built.
xcodebuild_args=(
  -project PWUsage.xcodeproj
  -scheme PWUsage
  -destination "id=$simulator_id"
  -derivedDataPath "$derived_data"
  CODE_SIGNING_ALLOWED=NO
  COMPILER_INDEX_STORE_ENABLE=NO
  "PWUSAGE_FUZZ_STRESS=${PWUSAGE_FUZZ_STRESS:-0}"
  "PWUSAGE_FUZZ_SEED=${PWUSAGE_FUZZ_SEED:-}"
  ${mode_build_settings[@]+"${mode_build_settings[@]}"}
)

# The simulator boots in the background while the tests build. Booting first and building after
# used to cost one to two minutes of boot on every CI run, and a just-booted simulator on a hosted Mac
# can take minutes more to settle before it launches anything; the build now covers both. The boot
# keeps its own limit, separate from the build and test limit.
boot_pid=""
boot_log="$artifacts_dir/simulator-boot.log"
if [[ "$mode" != build ]]; then
  echo "Booting simulator $simulator_id in the background (limit: ${boot_timeout_seconds}s)"
  boot_started=$SECONDS
  run_with_timeout 'Simulator boot' "$boot_timeout_seconds" xcrun simctl bootstatus "$simulator_id" -b \
    > "$boot_log" 2>&1 &
  boot_pid=$!
fi

# One limit covers the build and the test run together.
deadline=$((SECONDS + timeout_seconds))

set +e
run_with_timeout 'iOS build' "$timeout_seconds" xcodebuild "${xcodebuild_args[@]}" build-for-testing
status=$?
set -e

if [[ -n "$boot_pid" ]]; then
  if [[ "$status" -ne 0 ]]; then
    # $boot_pid is the background shell; its child is the timeout supervisor, which stops the boot
    # command's process group on SIGTERM. Wait so no boot outlives the run.
    pkill -TERM -P "$boot_pid" 2> /dev/null || true
    wait "$boot_pid" 2> /dev/null || true
  else
    set +e
    wait "$boot_pid"
    boot_status=$?
    set -e
    cat "$boot_log"
    if [[ "$boot_status" -ne 0 ]]; then
      echo "Simulator $simulator_id did not boot (exit $boot_status)" >&2
      rm -rf "$artifacts_dir"
      exit "$boot_status"
    fi
    echo "Simulator ready after $((SECONDS - boot_started))s"

    remaining=$((deadline - SECONDS))
    if [[ "$remaining" -lt 1 ]]; then
      echo "iOS test run exceeded ${timeout_seconds}s before the tests started" >&2
      status=124
    else
      set +e
      run_with_timeout 'iOS test run' "$remaining" xcodebuild "${xcodebuild_args[@]}" \
        -parallel-testing-enabled NO \
        -collect-test-diagnostics on-failure \
        -resultBundlePath "$artifacts_dir/TestResults.xcresult" \
        ${test_filter_args[@]+"${test_filter_args[@]}"} \
        test-without-building
      status=$?
      set -e
    fi
  fi
fi

# xcodebuild reports TEST SUCCEEDED when a filter matches nothing, so a green
# exit only counts if the result bundle shows tests actually ran.
if [[ "$status" -eq 0 && "$mode" != build ]]; then
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
