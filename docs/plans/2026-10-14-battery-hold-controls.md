# Battery Hold Controls Implementation Plan

> Execute task by task using superpowers:executing-plans and the repository's verification rules.

**Goal:** Ship a Control Center portal and server-updated Live Activity while keeping ten concurrent site holds reliable.

**Architecture:** Reuse `BatteryHold` for authoritative state and monitor claims. Isolate APNs delivery in a separate bounded worker backed by one per-activity child table, with desired/delivered state rather than separate job and outbox tables.

**Tech Stack:** SwiftUI, WidgetKit, App Intents, ActivityKit, Swift Testing; Next.js Node runtime, TypeScript, PostgreSQL, pg_cron/pg_net, APNs, Vitest.

## Task 1: Characterize ten-site monitoring

Files: `cmd/next-app/src/app/api/cron/restore-reserve/route.test.ts`,
`cmd/next-app/src/lib/battery-hold-detection.test.ts`,
`cmd/next-app/src/lib/today-refresh.test.ts`.

1. Add failing regression coverage for ten holds with delayed history, one failed
   site, timer holds, an elapsed Auto deadline, stale samples, and overlapping runs.
2. Use deterministic fake clocks/deferred promises; assert every site is attempted,
   deadlines precede history, concurrency never exceeds three, failed sites do not
   block peers, and no duplicate restore occurs. Model cancellation explicitly.
3. Run `npm run test -- --run src/app/api/cron/restore-reserve/route.test.ts src/lib/battery-hold-detection.test.ts src/lib/today-refresh.test.ts`
   from `cmd/next-app`; record expected missing-behavior failures.

## Task 2: Bound and coordinate monitor work

Files: modify `cmd/next-app/src/app/api/cron/restore-reserve/route.ts`,
`cmd/next-app/src/lib/battery-hold-repo.ts`, `battery-hold-service.ts`,
`battery-hold-detection.ts`, `today-refresh.ts`, `tesla-client.ts`;
create `cmd/next-app/src/lib/battery-hold-monitor-service.ts` and its tests.

1. Extract one-hold processing and a bounded three-worker scheduler without changing
   tariff/reserve rules. Capture current time per hold, prioritize expired deadlines,
   and gate history-driven early restoration on recent samples.
2. Preserve Site claims documented in `DesignDecisions.md`. Audit external I/O and
   use abortable deadlines across fetch, token refresh and rate-limit retries;
   ensure deadline propagation reaches actual requests. Handle uncertain writes.
3. Add an atomic hold-specific lease only as needed for overlapping/manual requests.
   Generate required migrations using `npm run db:migration:create battery_hold_monitor_claim`
   from `cmd/next-app`; do not manually name SQL files. Test lease ownership,
   expiry, hold identity and competing manual stop against isolated PostgreSQL.
4. Verify the installed pg_net timeout signature and deployed Vercel duration;
   generate a migration setting a compatible explicit request timeout. Add safe
   runtime/attempt/failure metrics. Keep production mutations out of test runs.
5. Run Task 1 tests plus service/repository/Tesla regressions and a ten-site timing
   harness. Meet the 120-second simulated slow-upstream budget or revise the design
   with measured evidence before shipping. Run web lint/full tests/build; commit.

## Task 3: Add Control Center navigation

Files: modify `cmd/ios-app/project.yml`, `PWUsage/PWUsageApp.swift`,
`PWUsage/State/DashboardCoordinator.swift`, `PWUsage/Views/LoadTimingView.swift`;
create `cmd/ios-app/PWUsageWidgets/battery-hold-control.swift`, widget bundle,
and app navigation intent; tests under `cmd/ios-app/PWUsageTests`.

1. Fetch current WidgetKit/App Intents docs through Context7 before implementation.
2. Test routing to configured site + hold sheet across cold launch, sign-in required,
   site loading, invalid/removed site and already-active hold. Never infer a site
   from stale global selection when a specific control site was chosen.
3. Add an iOS-18-compatible launcher control. Keep reserve choice and writes in the
   existing sheet; do not add extension credentials solely for the launcher.
4. Preserve signing team. Run targeted tests using `./run-tests.sh`, verify native
   build and control on device, then commit.

## Task 4: Persist activity registration and pending delivery

Files: create `cmd/next-app/src/lib/battery-hold-activity-repo.ts`, its tests,
and `cmd/next-app/src/app/api/site/[id]/battery-hold/activities/route.ts`/tests;
modify `battery-hold-service.ts` and monitor service for desired snapshots.

1. Generate `battery_hold_activities` migration with the existing generator.
   Reuse `BatteryHold`; add one child table with foreign key, RLS/grants, typed
   delivery state, desired/delivered versions, claim/backoff and expiry fields.
2. Test registration idempotency/token rotation, multiple devices, access revocation,
   wrong hold/site, validation, terminal registration races, concurrent desired
   state changes, and terminal updates surviving the active-hold query.
3. Implement registration/removal using existing native session/current-site checks.
   Persist desired pushes after authoritative monitoring and terminal transitions,
   including website/manual actions. Recover missed desired-state writes by
   reconciliation; no push bookkeeping failure may block reserve restoration.
4. Verify isolated migration/RLS and web tests/lint/build; commit.

## Task 5: Deliver Apple pushes separately

Files: create `cmd/next-app/src/lib/battery-hold-apns.ts`,
`battery-hold-activity-delivery-service.ts`, corresponding tests,
`cmd/next-app/src/app/api/cron/battery-hold-activity-delivery/route.ts` and tests;
generated schedule migration and deployment configuration documentation.

1. Fetch current APNs/ActivityKit docs through Context7. Use token-authenticated
   HTTP/2 with request deadlines, environment-specific sessions and secret signing
   credentials. Await delivery attempts; no detached in-process background loop.
2. Test payload compatibility, update/end ordering, APNs accepted vs device-delivered
   distinction, transient backoff, invalid-token cleanup, authentication failure,
   worker overlap and newly desired state arriving during delivery.
3. Implement bounded claims/batches, authorization rechecks and expiry cleanup.
   An older completion may acknowledge only its version; terminal state wins.
4. Generate a Vault-backed pg_cron/pg_net trigger, provisionally once per minute.
   A failed invocation leaves pending state for the next run. No credentials in logs.
5. Test ten holds with several phones each and a failing Apple endpoint; verify
   monitor runtime is unaffected. Run web checks and commit.

## Task 6: ActivityKit lifecycle and presentation

Files: create shared activity attributes and
`cmd/ios-app/PWUsageWidgets/battery-hold-live-activity.swift`;
create `PWUsage/State/battery-hold-activity-coordinator.swift`;
modify `PWUsage/Networking/PWUsageAPI.swift`, app/coordinator and target settings;
add Swift Testing lifecycle/transport/presentation tests.

1. Fetch current ActivityKit lifecycle docs; introduce a versioned content contract
   tested against representative server payloads.
2. Start after confirmed hold, observe token changes, register/retry, and reconcile
   after foreground/relaunch. Support observing a hold started elsewhere without
   push-to-start. Test duplicate starts, stale responses, site/auth change and denied
   Live Activities without affecting holds.
3. Build Lock Screen/Dynamic Island layouts with honest freshness, elapsed display
   limits, phase text, target reserve, site and deep link to existing stop confirmation.
4. Verify APNs on signed sandbox and production/TestFlight builds: app closed,
   token rotation, logout, multiple devices, restore/cancel, dismissal and expired
   activity. Do not send real Tesla commands without an explicit test scope.
5. Run `./run-tests.sh` from `cmd/ios-app` (no direct xcodebuild test), web lint,
   `npm run test -- --run`, and `npm run build`. Review diff and commit verified work.

## Completion boundary

Document operational setup, actual runtime measurements, credential requirements,
and remaining device-only checks. Create a draft PR if requested. This plan does
not itself authorize deploying new production schedules or testing real battery writes.
