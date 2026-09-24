#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

timeout_seconds="${PWUSAGE_TEST_TIMEOUT_SECONDS:-600}"
if [[ ! "$timeout_seconds" =~ ^[1-9][0-9]*$ ]]; then
  echo 'PWUSAGE_TEST_TIMEOUT_SECONDS must be a positive integer' >&2
  exit 2
fi

./generate.sh

simulator_id="${PWUSAGE_SIMULATOR_ID:-}"
if [[ -z "$simulator_id" ]]; then
  simulator_id="$(xcrun simctl list -j devices available | python3 -c '
import json
import sys

devices = [device for runtime in json.load(sys.stdin)["devices"].values()
           for device in runtime
           if device.get("isAvailable") and device.get("name", "").startswith("iPhone")]
devices.sort(key=lambda device: device.get("state") != "Booted")
if devices:
    print(devices[0]["udid"])
')"
fi

if [[ -z "$simulator_id" ]]; then
  echo 'No available iPhone simulator. Install an iOS Simulator runtime in Xcode or set PWUSAGE_SIMULATOR_ID.' >&2
  exit 2
fi

test_filter_args=()
for target in "$@"; do
  if [[ "$target" == -only-testing* || "$target" == -skip-testing* ]]; then
    test_filter_args+=("$target")
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
  -collect-test-diagnostics never \
  -derivedDataPath "$artifacts_dir/DerivedData" \
  -resultBundlePath "$artifacts_dir/TestResults.xcresult" \
  CODE_SIGNING_ALLOWED=NO \
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

if [[ "$status" -eq 0 ]]; then
  rm -rf "$artifacts_dir"
else
  echo "iOS tests failed (exit $status). Artifacts retained at $artifacts_dir" >&2
fi
exit "$status"
