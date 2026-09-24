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
printf '{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-27-0":[{"name":"iPhone 17","udid":"TEST-UDID","state":"Shutdown","isAvailable":true}]}}\n'
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
rg -q '^never$' "$PWUSAGE_TEST_ARGS"

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
