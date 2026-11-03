#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
# --cache ignore: agent sandboxes may not be able to write ~/Library/Caches.
swiftformat cmd/ios-app --config .swiftformat --cache ignore "$@"
