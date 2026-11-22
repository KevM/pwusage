#!/usr/bin/env bash
# Usage: ./run-core-tests.sh [--release | --full] [--filter <pattern>] [extra swift test args...]
#   (no flag)  Debug build, runs all default PWUsageCoreTests natively on macOS.
#   --release  Optimized (-c release) build for fast numeric/backtest execution.
#   --full     Optimized (-c release) build with PWUSAGE_SOLAR_SLOW_PARITY=1 enabled.
set -euo pipefail

cd "$(dirname "$0")"

config="debug"
slow_parity="${PWUSAGE_SOLAR_SLOW_PARITY:-}"
extra_args=()

while (($# > 0)); do
    case "$1" in
        --release)
            config="release"
            shift
            ;;
        --full)
            config="release"
            slow_parity="1"
            shift
            ;;
        *)
            extra_args+=("$1")
            shift
            ;;
    esac
done

cmd=(swift test --package-path Packages/PWUsageCore -c "$config")
if ((${#extra_args[@]} > 0)); then
    cmd+=("${extra_args[@]}")
fi

if [[ "$slow_parity" == "1" ]]; then
    PWUSAGE_SOLAR_SLOW_PARITY=1 "${cmd[@]}"
else
    "${cmd[@]}"
fi
