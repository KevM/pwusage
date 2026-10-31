# iOS App Guidelines & Preferences

## Development & Code Quality
- **Strict Linting & Formatting**: All Swift code must comply with SwiftLint (`swiftlint lint --strict --baseline .swiftlint-baseline.json`) and SwiftFormat (`swiftformat cmd/ios-app --config .swiftformat`).
- **Pre-commit Checks**: Always run `swiftlint lint --strict --baseline .swiftlint-baseline.json` and the full `./run-tests.sh` locally before finalizing any task or pushing changes. While iterating, `./run-tests.sh --quick` skips the slow suites in `quick-test-skips.txt`. Never push code that introduces new SwiftLint or SwiftFormat violations.
- **Testing Framework**: All native iOS tests must use Swift Testing (`SwiftTest` via `import Testing`, `@Suite`, `@Test`, `#expect`, `#require`). Do not use legacy `XCTest`.
- **Budgets (SwiftLint)**:
  - Line length: 120 chars max
  - File length: 400 warning / 500 error
  - Type body length: 350 warning / 450 error
  - Function body length: 50 warning / 100 error
  - Cyclomatic complexity: 10 warning / 20 error
