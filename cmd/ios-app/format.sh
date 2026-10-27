#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
swiftformat cmd/ios-app --config .swiftformat "$@"
