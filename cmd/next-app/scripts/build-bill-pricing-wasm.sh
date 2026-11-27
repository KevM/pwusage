#!/usr/bin/env bash
set -euo pipefail

app_dir="$(cd "$(dirname "$0")/.." && pwd)"
core_dir="$app_dir/../ios-app/Packages/PWUsageCore/Sources/PWUsageCore"
build_dir="$(mktemp -d)"
trap 'rm -rf "$build_dir"' EXIT

mkdir -p "$build_dir/Sources/BillPricingWasm"
cp "$app_dir/wasm/BillPricingBridge.swift" "$build_dir/Sources/BillPricingWasm/"
cp "$core_dir"/BillPricing/{BillPricing,BillUsageAggregator,RatePeriodResolver}.swift \
   "$core_dir"/SharedModels/{EnergyFlowDay,TariffTimelineDTOs,TariffMetadataDTOs}.swift \
   "$build_dir/Sources/BillPricingWasm/"
cat > "$build_dir/Package.swift" <<'SWIFT'
// swift-tools-version: 6.0
import PackageDescription

let package = Package(name: "BillPricingWasm", targets: [.executableTarget(name: "BillPricingWasm")])
SWIFT

sdk="swift-6.4.3-RELEASE_wasm"
build_args=(--package-path "$build_dir" -c release --swift-sdk "$sdk"
    -Xswiftc -Osize
    -Xswiftc -Xclang-linker -Xswiftc -mexec-model=reactor
    -Xlinker --export=bill_allocate -Xlinker --export=bill_free -Xlinker --export=bill_price
    -Xlinker --strip-all)
swift build "${build_args[@]}"
binary_dir="$(swift build "${build_args[@]}" --show-bin-path)"
wasm_in="$binary_dir/BillPricingWasm.wasm"
wasm_ready="$build_dir/bill-pricing.wasm"
wasm_gz="$app_dir/wasm/bill-pricing.wasm.gz"
if command -v wasm-opt >/dev/null 2>&1; then
    wasm-opt -Os --all-features --strip-debug --strip-producers "$wasm_in" -o "$wasm_ready"
elif [ "${CI:-}" = "true" ]; then
    echo "error: wasm-opt (binaryen) is required in CI" >&2
    exit 1
else
    cp "$wasm_in" "$wasm_ready"
fi
rm -f "$app_dir/wasm/bill-pricing.wasm"
gzip -9 -c "$wasm_ready" > "$wasm_gz"
