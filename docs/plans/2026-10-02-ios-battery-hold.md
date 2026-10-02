# Native iOS Battery Hold Implementation Plan

**Goal:** Manage the website's battery holds from a native Load Timing toolbar sheet.

**Architecture:** Reuse `/api/site/[id]/battery-hold` through PWUsageAPI.
DashboardCoordinator gates authenticated requests and holds site-scoped state;
a native sheet renders that state and sends explicit user commands.

**Tech Stack:** Swift 6, SwiftUI, URLSession, Swift Testing; existing Next.js API.

## 1. Contracts and transport

Create `cmd/ios-app/PWUsage/Models/battery-hold.swift` and tests in
`cmd/ios-app/PWUsageTests/battery-hold-tests.swift`. Test reserve boundaries, timer
validation, snake-case hold/notice decoding and malformed or wrong-site records.
Add GET/POST methods and encoded site path to
`cmd/ios-app/PWUsage/Networking/PWUsageAPI.swift`; extend PWUsageAPITests for
authenticated requests, JSON bodies and actionable server errors.
Run `cmd/ios-app/run-tests.sh BatteryHoldTests PWUsageAPITests` before and after
implementation to observe missing-feature failure and passing tests.

## 2. State and authorization

Extend `cmd/ios-app/PWUsage/State/DashboardCoordinator.swift` with hold state and
requests using the same site-generation and sign-in guards as tariffs. Add tests
for start/restore/dismiss, failure recovery, duplicate commands, changed charge
requiring a choice and invalidation during requests. Reads remain DB-only;
commands use the existing server service. Reset hold state on site/auth changes.

## 3. Native sheet and toolbar

Create `cmd/ios-app/PWUsage/Views/battery-hold-sheet.swift`, including automatic or
timer controls, reserve explanation/choice, restore confirmation, notices,
progress, retry and reconnect. Add the button beside the gear and sheet to
`cmd/ios-app/PWUsage/Views/LoadTimingView.swift`. Refresh state on entry and
foreground, and while the sheet is active at a modest cadence. Add preview fixtures
for idle, ambiguous charge, active hold and cancellation. Check accessibility and
large-text layouts. Preserve the existing signing team.

## 4. Verification and commit

Run the full `cmd/ios-app/run-tests.sh` suite (also builds the native app).
From `cmd/next-app`, run `npm run lint`, `npm run test -- --run`, and `npm run build`.
Inspect the final diff and resolve any relevant failures, then commit with
`feat(ios): add native battery hold controls`.
