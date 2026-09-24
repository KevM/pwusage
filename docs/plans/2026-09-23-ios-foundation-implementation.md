# iOS Foundation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Prove that a native iOS dashboard can consume pwusage data with website-equivalent database egress, then define the API contract and login handoff for the first read-only release.

**Architecture:** Keep Tesla access, site authorization, billing, and refresh on the Next.js server. Use the existing `site_auth` cookie after a single-use mobile login handoff. The iOS client will coordinate one foreground live poller and a slower bill refresh; the first implementation slice measures database egress before finalizing the endpoint split.

**Tech Stack:** Next.js 16, TypeScript, PostgreSQL through `pg`, Vitest, SwiftUI and `URLSession` for the later native client. Xcode 27 and Swift 6.4 are present locally; there is no iOS project in the repository yet.

---

## Scope of this plan

This is the **foundation slice**, not a commitment to build every iOS screen now. It ends with a measured egress baseline, a concrete mobile data contract, and a tested cookie handoff design. Do not scaffold the native app until the egress result determines the endpoint shape. Use the approved [architecture design](2026-09-23-ios-architecture-design.md) for scope and decisions.

### Task 1: Record the current query and polling baseline

**Files:**
- Create: `cmd/next-app/scripts/measure-mobile-egress.ts`
- Create: `cmd/next-app/src/lib/mobile-egress.test.ts`
- Create: `docs/plans/2026-09-23-ios-egress-results.md`
- Read: `cmd/next-app/src/app/api/site-live-data/route.ts`
- Read: `cmd/next-app/src/app/api/trmnl/markup/route.ts`
- Read: `cmd/next-app/src/lib/energy-repo.ts`

**Step 1: Define the estimator in a focused test.** Test that a result with strings, numbers, nulls, and dates contributes the byte length of its PostgreSQL-style text values rather than the size of the JSON response. Test the formula for requests per day at 5- and 30-minute visible intervals. A pure helper can export `estimateResultBytes(rows)` and `monthlyBytes(bytesPerRequest, visibleHoursPerDay, intervalMinutes, phones)`.

**Step 2: Run the test and confirm it fails.** From `cmd/next-app`, run `npm run test -- --run src/lib/mobile-egress.test.ts`. The expected failure is the missing estimator module.

**Step 3: Implement the smallest estimator and a read-only measurement script.** At the very beginning of the script, load `.env` with `dotenv/config`. Require `DEV_DATABASE_URL` and an explicit site ID argument; fail before opening a connection if either is absent, then set `process.env.DATABASE_URL` from `DEV_DATABASE_URL` before importing the repository modules. For that site, measure rows and estimated bytes for the existing live route's 24-hour bucket query, completed-cycle aggregates, today's raw rows, latest energy row, tariff versions, schedule versions, and the active-user authorization lookup. Print each query separately; never fetch Tesla data. Record site-local date, cycle day, row counts, bytes, and run time. Use the same text-value approximation as the existing egress analysis so the numbers can be compared.

**Step 4: Run the focused test and script.** Run `npm run test -- --run src/lib/mobile-egress.test.ts`, then `npx tsx scripts/measure-mobile-egress.ts --site <dev-site-id>` against an authorized development snapshot. The script must not fall back to production when the dev database URL is absent. Do not put credentials or site identifiers in the results document.

**Step 5: Model traffic and write the results.** Calculate one phone active 1, 8, and 24 hours per day, then 2 and 10 concurrent phones. Include a cold-start scenario and the current web header/detail baseline. Record the monthly total against the shared 5 GB cap. Distinguish database egress from HTTP response bytes and mark any estimate that lacks production traffic counts as an estimate.

**Step 6: Commit only the measurement script, test, and results.** Use a conventional commit such as `perf(ios): measure dashboard database egress` after the focused test, lint, and build pass. Do not include local caches or database dumps.

### Task 2: Choose and test the smallest data contract

**Files:**
- Create: `cmd/next-app/src/lib/mobile-dashboard-contract.ts`
- Create: `cmd/next-app/src/lib/mobile-dashboard-contract.test.ts`
- Modify: `cmd/next-app/src/app/api/site-live-data/route.ts`
- Modify: `cmd/next-app/src/app/api/site-live-data/route.test.ts` (create if absent)
- Possibly create: `cmd/next-app/src/app/api/site/[id]/mobile-bill/route.ts` and its test, only after Task 1's measurements

**Step 1: Write contract tests.** Define the first-release fields: site ID and name, live power values, nullable battery state of charge, active tariff, today totals, compact current bill estimate and cycle dates, source timestamps, and a response version. Assert that a stale or missing battery state of charge is `null`, not `0`, and that request time cannot replace source time. Assert that the response omits raw energy rows and full tariff JSON.

**Step 2: Run the tests and confirm failure.** Run `npm run test -- --run src/lib/mobile-dashboard-contract.test.ts src/app/api/site-live-data/route.test.ts`.

**Step 3: Implement the contract using current domain functions.** Preserve the existing `/api/site-live-data` fields used by the website and add source timestamps without changing their meaning. Feed today and bill values from existing server-side aggregation logic. Use Task 1's results to decide whether the bill belongs in a separate slower endpoint or a server-maintained compact snapshot. A five-minute request must not reread full-cycle aggregates or raw-today rows just to return the bill. Keep the same `verifySiteAccess` authorization path.

**Step 4: Prove parity and egress.** Test site isolation, old state-of-charge behavior, timezone and billing-cycle boundaries, and tariff-version history. Compare the new bill result with the website/TRMNL calculation for the same site and instant. Re-run the egress script for cold and warm cases. Reject the API shape if an active phone exceeds equivalent web site-header plus live-detail egress at the same visibility pattern.

**Step 5: Run all repository gates and commit.** From `cmd/next-app`, run `npm run test -- --run`, `npm run lint`, and `npm run build`. Commit verified API and contract changes with a conventional message. Update the egress results with actual numbers.

### Task 3: Design and test the one-time cookie handoff

**Files:**
- Modify: `cmd/next-app/src/app/login/route.ts` and its test
- Modify: `cmd/next-app/src/app/auth/tesla-callback/route.ts` and its test
- Create: `cmd/next-app/src/lib/mobile-login-handoff.ts` and its test
- Create: `cmd/next-app/src/app/api/mobile/session/route.ts` and its test
- Create migration through `npm run db:migration:create <name>` only if the chosen replay-protection store needs a new table
- Update: `Authentication.md`

**Step 1: Write the threat and flow tests first.** Cover an authorized login, state binding, a single successful exchange, replay rejection, expiry, wrong-site or wrong-user rejection, invalid callback, no JWT or Tesla token in the app redirect URL, an HTTP-only secure cookie in production, and continued access through existing `verifySiteAccess` checks.

**Step 2: Run the focused tests and confirm failure.** Run `npm run test -- --run src/lib/mobile-login-handoff.test.ts src/app/api/mobile/session/route.test.ts src/app/login/route.test.ts src/app/auth/tesla-callback/route.test.ts`.

**Step 3: Implement the handoff.** Keep the existing website login and callback behavior intact. Add a mobile callback branch that issues a short-lived opaque code, redirects to the app, and atomically consumes the code at `/api/mobile/session`. On successful exchange, issue the existing `site_auth` cookie through the app's `URLSession` response. Avoid a per-dashboard-poll session lookup. If a table is required, generate its migration with the repository script and apply the project's RLS restrictions.

**Step 4: Verify the server session lifecycle.** Test JWT refresh close to expiry, revoked users, logout, and site isolation with the cookie obtained by exchange. Record native callback and `URLSession` cookie persistence, renewal, and clearing as blocking device-test cases for the next native implementation plan; the server tests alone cannot prove them.

**Step 5: Run all repository gates and commit.** Run the full tests, lint, and build. Commit the handoff and update `Authentication.md`. Review any migration against a development backup before opening a PR.

## Next implementation plan after the foundation slice

Once the measured API and cookie exchange work, write a separate native implementation plan for an iOS project under `cmd/ios-app`. That plan should define the bundle identifier and signing team with the user, then cover the SwiftUI dashboard, bill detail, one foreground data coordinator, `ASWebAuthenticationSession`, `URLSession` cookie storage, timestamp and empty states, simulator/device tests for the login handoff and cookie lifecycle, and App Store distribution decisions. Widgets, background polling, notifications, and battery controls remain separate future design decisions.
