#!/usr/bin/env bash
set -euo pipefail

app_dir="$(cd "$(dirname "$0")/.." && pwd)"
core_dir="$app_dir/../ios-app/Packages/PWUsageCore/Sources/PWUsageCore"
build_dir="$(mktemp -d)"
trap 'rm -rf "$build_dir"' EXIT

mkdir -p "$build_dir/Sources/PWUsageCoreWasm"
cp "$app_dir/wasm/PWUsageCoreBridge.swift" "$build_dir/Sources/PWUsageCoreWasm/"
cp "$core_dir"/BillPricing/{BillPricing,BillUsageAggregator,RatePeriodResolver}.swift \
   "$core_dir"/SharedModels/{EnergyFlowDay,LoadTimingTimelineModels,SiteTimeZone,TariffMetadataDTOs,TariffTimelineDTOs}.swift \
   "$core_dir"/SolarLayout/{LayoutFit,LayoutFit+PlaneCount,LayoutFit+Refine,LayoutPOA,LayoutSelection,LayoutSunSample,MobileSolarLayout,ShadeMask,SiteHistoryCheckpoints,SolarLayoutDetector,SolarLayoutDetector+ClearDays,SolarLayoutDetector+Support,SolarLayoutReadiness,SolarPosition}.swift \
   "$core_dir"/SolarHealth/OpenMeteoArrayModel.swift \
   "$core_dir"/SolarForecast/{OpenMeteoClientError,OpenMeteoWeather,SolarForecast,SolarForecastCorrection}.swift \
   "$core_dir"/LoadTiming/{Array+PartitionPoint,CarChargeSource,CarChargeSteps,EnergyFlowProjection,LoadProfile,LoadTimingEstimator,LoadTimingForecastEstimator,LoadTimingForecastEstimator+Evaluate,LoadTimingForecastEstimator+Model,LoadTimingForecastEstimator+Plan,LoadTimingForecastEstimator+Projection,LoadTimingForecastEstimator+Selection,SmartShiftEvaluation}.swift \
   "$build_dir/Sources/PWUsageCoreWasm/"

cat > "$build_dir/Package.swift" <<'SWIFT'
// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "PWUsageCoreWasm",
    targets: [.executableTarget(name: "PWUsageCoreWasm")]
)
SWIFT

sdk="swift-6.4.3-RELEASE_wasm"
build_args=(--package-path "$build_dir" -c release --swift-sdk "$sdk"
    -Xswiftc -Osize
    -Xswiftc -Xclang-linker -Xswiftc -mexec-model=reactor
    -Xlinker --export=pw_allocate
    -Xlinker --export=pw_free
    -Xlinker --export=bill_price
    -Xlinker --export=solar_layout_detect
    -Xlinker --export=solar_layout_readiness
    -Xlinker --export=solar_forecast_open_meteo
    -Xlinker --export=solar_forecast_correct
    -Xlinker --export=smart_shift_evaluate
    -Xlinker --strip-all)
swift build "${build_args[@]}"
binary_dir="$(swift build "${build_args[@]}" --show-bin-path)"
wasm_in="$binary_dir/PWUsageCoreWasm.wasm"
wasm_out="$app_dir/wasm/pwusage-core.wasm"
if command -v wasm-opt >/dev/null 2>&1; then
    wasm-opt -Os --all-features --strip-debug --strip-producers "$wasm_in" -o "$wasm_out"
elif [ "${CI:-}" = "true" ]; then
    echo "error: wasm-opt (binaryen) is required in CI" >&2
    exit 1
else
    cp "$wasm_in" "$wasm_out"
fi
rm -f "$app_dir/wasm/bill-pricing.wasm" "$app_dir/wasm/bill-pricing.wasm.gz"
