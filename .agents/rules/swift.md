# Swift & iOS Guidelines

The canonical guide is [`cmd/ios-app/AGENTS.md`](../../cmd/ios-app/AGENTS.md). Read it before editing
Swift code; do not keep a second copy of the naming, idiom and budget rules here.

Non-negotiables:

- No force unwrapping (`!`), no `try!`, and no new `swiftlint:disable` comments.
- Verify with `./cmd/ios-app/lint.sh`. It uses `--no-cache`, so it also works in sandboxes that
  block `~/Library/Caches`; there is no SwiftLint baseline to reason about.
- Tests use Swift Testing only. Use `./cmd/ios-app/run-tests.sh --quick` while iterating and the
  full run before opening or updating a PR.
- `swiftlint --fix` is unsafe repo-wide; use `./cmd/ios-app/lint.sh --fix`, which only formats.
