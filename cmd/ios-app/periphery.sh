#!/usr/bin/env bash
# Finds unused code in the app, the widget and PWUsageCore with Periphery.
#
# Builds for testing, so a declaration read only by PWUsageTests (a test hook) is not reported.
# PWUsageCore's own tests run through SwiftPM, outside the scheme: mark a core declaration they alone
# read with `// periphery:ignore - <which test reads it>`.
#
# Builds into a fresh, private DerivedData and scans only its index store. A shared DerivedData
# keeps index records for deleted files and for other checkouts of this project, which Periphery
# reports as findings in files that no longer exist and as declaration conflicts.
set -euo pipefail
cd "$(dirname "$0")"
if ! command -v periphery >/dev/null 2>&1; then
  echo "Periphery is not installed. Run: brew install periphery" >&2
  exit 127
fi

derived_data="$(mktemp -d "${TMPDIR:-/tmp}/pwusage-periphery.XXXXXX")"
trap 'rm -rf "$derived_data"' EXIT

xcodegen generate
xcodebuild -project PWUsage.xcodeproj -scheme PWUsage \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath "$derived_data" \
  CODE_SIGNING_ALLOWED=NO COMPILER_INDEX_STORE_ENABLE=YES build-for-testing
periphery scan --config .periphery.yml --format xcode \
  --skip-build --index-store-path "$derived_data/Index.noindex/DataStore"
