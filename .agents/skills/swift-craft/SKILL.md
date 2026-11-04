---
name: swift-craft
description: >-
  Guidelines for writing idiomatic, Swifty code for pwusage's iOS app.
  Use whenever creating, editing, refactoring, or reviewing Swift code in cmd/ios-app.
  Enforces Apple Swift API Design Guidelines, SwiftLint budgets, SwiftFormat, and Swift Testing.
---

# Swift Craft & iOS Quality Guidelines

Read [`cmd/ios-app/AGENTS.md`](../../../cmd/ios-app/AGENTS.md) first. It is the canonical guide for
naming, idioms, budgets, linting and tests. This skill is the review checklist to apply after you
have read it; do not restate or fork its rules.

## Review checklist

**Naming**

- Does every new name pass the "Swift API design and naming" section of
  [`cmd/ios-app/AGENTS.md`](../../../cmd/ios-app/AGENTS.md#swift-api-design-and-naming)? Check call-site
  clarity, needless words, `get` prefixes, boolean assertions, mutating pairs and `make...`
  factories.

**Shape**

- Value types first; `class` only for identity, inheritance, `ObservableObject` or Obj-C interop.
- States are enums with associated values, not loose booleans plus optionals.
- `let` unless mutation is real; `guard` for early exit.
- No `!`, `try!`, or `try?` that hides an error the caller needs.
- `@MainActor` on UI state, `Sendable` across actor boundaries, structured concurrency over
  completion handlers.

**Views and lint budgets**

- Keep `body` small; extract subviews or `@ViewBuilder` sections before it grows. CI builds with
  `-O`, and one oversized SwiftUI expression can fail to type-check in reasonable time.
- Stay inside the budgets in the "Write lint-clean the first time" table of
  [`cmd/ios-app/AGENTS.md`](../../../cmd/ios-app/AGENTS.md#write-lint-clean-the-first-time); `.swiftlint.yml` is
  the source of truth for the numbers.
- Wrap long lines at argument commas; do not rename or shorten copy just to fit.
- Never add `swiftlint:disable` or a baseline entry to get green.

**Tests**

- Swift Testing only: `import Testing`, `@Suite`, `@Test`, `#expect`, `#require`.
- Wait with `eventually`/`staysTrue`; never assert after a fixed `Task.sleep`.

## Verify

```bash
./cmd/ios-app/lint.sh          # SwiftFormat check + SwiftLint (sandbox-safe)
./cmd/ios-app/lint.sh --fix    # apply SwiftFormat first
cd cmd/ios-app && ./run-tests.sh --quick   # then the full run before a PR
```

`swiftlint --fix` is unsafe repo-wide; `lint.sh --fix` only runs SwiftFormat.
