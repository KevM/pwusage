#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if ! command -v periphery >/dev/null 2>&1; then
  echo "Periphery is not installed. Run: brew install periphery" >&2
  exit 127
fi
xcodegen generate
xcodebuild -project PWUsage.xcodeproj -scheme PWUsage \
  -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO COMPILER_INDEX_STORE_ENABLE=YES build
periphery scan --config .periphery.yml --format xcode
