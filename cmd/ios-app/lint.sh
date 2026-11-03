#!/usr/bin/env bash
# One-command iOS format + lint check.
#
#   ./cmd/ios-app/lint.sh          # check SwiftFormat and SwiftLint
#   ./cmd/ios-app/lint.sh --fix    # apply SwiftFormat, then lint
#
# The wrapper exists for agents as much as for people:
#   * SwiftLint gets --no-cache, because sandboxes often cannot write
#     ~/Library/Caches and a bare `swiftlint` then exits non-zero after
#     printing "Found 0 violations".
#   * SwiftFormat gets --cache ignore for the same reason.
#   * There is no baseline. The burndown is complete; fix violations instead
#     of adding a baseline entry or a swiftlint:disable comment.
set -euo pipefail

cd "$(dirname "$0")/../.."

usage() {
    cat <<'EOF'
Usage: ./cmd/ios-app/lint.sh [--fix]

  (no flag)  Check SwiftFormat and run SwiftLint --strict.
  --fix      Apply SwiftFormat first, then run SwiftLint.
  -h, --help Show this help.

Run from the repository root or from cmd/ios-app; paths are resolved
relative to this script.
EOF
}

mode="check"
case "${1:-}" in
    "" | --check) ;;
    --fix) mode="fix" ;;
    -h | --help)
        usage
        exit 0
        ;;
    *)
        echo "unknown argument: $1" >&2
        usage >&2
        exit 2
        ;;
esac

for tool in swiftformat swiftlint; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        echo "error: $tool is not installed. Install it with: brew install $tool" >&2
        exit 127
    fi
done

status=0

if [[ "$mode" == "fix" ]]; then
    echo "==> swiftformat (apply)"
    swiftformat cmd/ios-app --config .swiftformat --cache ignore || status=1
else
    echo "==> swiftformat (check)"
    swiftformat --lint cmd/ios-app --config .swiftformat --cache ignore || status=1
fi

echo "==> swiftlint"
swiftlint lint cmd/ios-app --strict --no-cache --quiet || status=1

if ((status == 0)); then
    echo "iOS lint: clean"
else
    echo "iOS lint: fix the violations above; do not add swiftlint:disable" >&2
fi

exit "$status"
