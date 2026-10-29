# Tesla Authentication Remediation Implementation Plan

> Execute sequentially using the executing-plans skill. This document proposes work; it does not authorize deployment or account reactivation.

**Goal:** Prevent automatic reuse of a possibly consumed Tesla refresh token and prevent Tesla connection failures from disabling otherwise valid app sessions.

**Architecture:** Keep the account-level database lease and detached refresh lifecycle from PR #251. Add durable credential-generation and exchange-outcome tracking, separate Tesla connection health from app-account eligibility, and make TRMNL rendering depend on stored data. Unknown remote outcomes require reconnection unless a successful response can still be saved safely.

**Tech Stack:** Existing TypeScript application, PostgreSQL repositories, Vitest, and native Swift client where connection-state presentation requires changes.

## Scope and decisions

- PR #251 is merged; do not revisit its merge status. Preserve its independent exchange deadline, lifecycle retention, conditional saves, and bounded cleanup.
- No timeout can guarantee delivery of a rotated token. Do not promise transparent recovery after response loss.
- Refresh leases serialize attempts; they do not establish whether Tesla consumed a grant. Lease expiry must not authorize replay of an uncertain credential.
- Stop automatic refresh-token replay after an ambiguous dispatch. This deliberately trades some automatic recovery for avoiding destructive repeated exchanges.
- Keep authorization-code exchange policy separate from refresh-token policy. Do not globally delete endpoint fallback used by login.
- Existing account suspension, ownership, role, and session-version checks remain enforced. A reconnect condition grants no new access and issues no session.
- Do not reactivate historical inactive accounts automatically: the existing flag may represent more than a Tesla failure.
- Read Authentication.md and relevant DesignDecisions.md sections before implementation. The latter currently explicitly couples terminal Tesla failure to account deactivation; this plan intentionally changes that decision and must update it.

## 1. Define typed exchange outcomes and prove the failure sequence

**Files:** `cmd/next-app/src/lib/tesla-auth.ts`, `tesla-token-endpoint.ts`, `tesla-client.ts`, their adjacent tests, and `tesla-account-refresh.test.ts`.

1. Add failing tests at the fetch boundary: primary host consumes a refresh grant but loses its response; ensure there is no fallback POST using that grant. Add malformed/truncated 200, endpoint timeout, 5xx after dispatch, and pre-dispatch failure cases.
2. Introduce explicit outcome types: not dispatched, credentials received, credential rejected, deployment/client configuration rejected, and outcome unknown. Preserve HTTP status and allowlisted OAuth error codes; never classify by arbitrary response text.
3. For refresh grants, conservatively classify transport failure after dispatch, unreadable successful bodies, and ambiguous server errors as unknown. Permit another endpoint only when non-dispatch is established, not merely inferred from a generic network error.
4. Separate `invalid_client`/client configuration failures from user credential rejection. Audit generic 401 handling and the broad `isTeslaAuthError` message matcher so neither can convert an unknown or deployment failure into user revocation. Verify documented Tesla error semantics with current primary documentation during implementation.
5. Run targeted tests, inspect failures, implement the smallest change, and commit after passing. Retain login endpoint fallback coverage.

## 2. Persist exchange state before sending the refresh grant

**Files:** `cmd/next-app/src/lib/tesla-token-repo.ts`, `user-repo.ts`, `db-types.ts`, `tesla-account-refresh.test.ts`, `tesla-account-refresh.postgres.test.ts`, `tesla-token-cleanup.test.ts`; generated migration under `cmd/next-app/db-migrations/`.

1. Generate an additive migration with `npm run db:migration:create tesla_refresh_outcomes` from `cmd/next-app`; never hand-name the migration. Prefer columns on User unless implementation demonstrates a need for a separate attempt table. Any new table requires the repository's RLS restrictions.
2. Add credential generation, current attempt ID, attempt state, and start timestamp. Use generation for concurrency, not a raw token fingerprint. Define states `ready`, `in_flight`, `uncertain`, and `reconnect_required`; keep transient outage diagnostics separate from credential usability.
3. Atomically acquire the existing lease and record `in_flight` before dispatch. Fail closed if this write cannot be confirmed. A crash after recording but before dispatch may conservatively require reconnect; document this unavoidable local/remote transaction gap.
4. Save rotated credentials and advance generation in the same conditional UPDATE that returns the state to ready. Require the original generation and attempt ID; preserve protection against concurrent login and replacement workers.
5. Record unknown outcomes without clearing their replay prohibition. If that write fails, the durable in-flight marker remains. An expired lease with an unresolved attempt becomes uncertain, never ready.
6. On confirmed pre-dispatch failure, return the generation to ready with a bounded retry policy. On definitive credential rejection, mark reconnect required. Configuration outages must not mark user credentials revoked.
7. Allow a still-running operation to complete its guarded save while it owns the valid attempt/lease. Never let a late result overwrite newer login credentials. Successful OAuth login advances generation and clears only the superseded exchange state.
8. Add real PostgreSQL tests for two workers, crash/lease expiry, failed uncertainty write, lost save acknowledgement, concurrent login, and stale completion. Waiters observe durable state and must not return expired credentials or start a second exchange.
9. Commit after focused unit and PostgreSQL checks pass.

## 3. Separate app access from Tesla connection health

**Files:** `cmd/next-app/src/lib/user-repo.ts`, `tesla-token-repo.ts`, `auth-checks.ts`, `auth-jwt.ts`, `tesla-client.ts`, their tests, and `src/app/api/mobile/session/session-lifecycle.test.ts`.

1. Inventory every writer of `is_active` and `auth_status`, including account verification, OAuth provisioning, administrative actions, cron jobs, and token refresh. Record which writes represent suspension versus Tesla health before changing semantics.
2. Keep `is_active` as account eligibility. Remove Tesla-only deactivation from refresh and verification; store the connection condition separately. Ensure verifier finalization preserves concurrent login/refresh changes and cannot clear uncertainty.
3. Add tests proving an existing valid session can read authorized stored data while Tesla reconnect is required, but suspended users, revoked session versions, and non-owners are still denied.
4. Gate Tesla reads/commands and all background callers on connection state. Return a distinct connection-required application error rather than a session-invalid response that makes native clients discard valid sessions. Do not use cached authorization to permit Tesla commands.
5. Test renewal and mobile session behavior. No historical account becomes active because of this migration. Existing affected users recover through the established authenticated reconnect flow.
6. Commit after auth, verifier, and mobile lifecycle tests pass.

## 4. Make TRMNL rendering independent of Tesla refresh

**Files:** `cmd/next-app/src/app/api/trmnl/markup/route.ts` and adjacent tests, `src/lib/today-refresh.ts`, `src/lib/trmnl-renderer.ts`, their tests.

1. Add a route test asserting the response can complete using DB data without awaiting a Tesla request, including a live-status cache miss.
2. Remove the 900 ms inline live-status fetch. Schedule lifecycle-retained background refresh using existing cross-instance claims and the 15-minute cadence. Preserve separate history/live claims and account-level refresh coordination.
3. Render known stored data with accurate freshness; stale SoC becomes `--`. A reconnect-required installation remains authenticated by its installation token and shows a calm reconnect message rather than masquerading as invalid device credentials.
4. Suppress background work for uncertain/reconnect-required generations. Preserve freshness/debug headers and authorization tests for UUID, bearer-token, and preview modes.
5. Commit after route and renderer tests pass.

## 5. Present reconnect state consistently

**Files:** Relevant web account/site UI, mobile API DTOs and `cmd/ios-app` consumers identified by the writer/caller inventory; `docs/voice-and-terms.md` is the copy reference.

1. Show “Reconnect Tesla to update your data.” Keep authorized historical data available and explain its timestamp. Preserve the existing reconnect return destination.
2. Distinguish unknown exchange outcome in operator diagnostics; do not claim Tesla revoked permission when the app lost the response.
3. Ensure iOS, widgets, and TRMNL do not clear sessions or installation credentials for connection-required responses. Disable unavailable live controls and avoid login loops.
4. Add focused web/API and Swift Testing coverage. Run native tests only through `cmd/ios-app/run-tests.sh`; run strict SwiftLint if native files change.

## 6. Verify, document, and roll out safely

**Files:** `Authentication.md`, `DesignDecisions.md`, operational documentation and relevant observability code.

1. Add structured events for exchange state transitions, suppressed replay, reconnect requirement, and restoration. Correlate attempt ID and hashed account/generation identity; never log tokens, codes, or response bodies.
2. Integration acceptance scenario: a TRMNL poll starts refresh, the provider consumes the grant but the response is lost, another instance polls, no second grant is sent, existing app sessions retain stored-data access, and reconnect restores background work without relinking TRMNL.
3. Also verify process death, successful rotation followed by persistence failure, endpoint outage, actual invalid grant, client misconfiguration, concurrent reconnect, and account suspension.
4. Run from `cmd/next-app`: `npm test -- --run`, `npm run lint`, and `npm run build`. Run the repository's real PostgreSQL refresh suite with its documented test database setup. No production credentials in test output. Commit verified implementation changes.
5. Apply additive schema first. Deploy compatible readers before enforcing new exchange states; prevent old workers from overlapping new guarded writers during cutover. An old worker ignoring the marker invalidates the guarantee. Document how the deployment platform will drain old invocations.
6. Rollback must retain replay suppression and uncertain states. Do not roll back to code that blindly retries recorded uncertain generations; pause Tesla refresh if necessary while retaining stored-data serving.
7. Observe at least 48 hours and multiple refresh cycles. Track unique affected accounts separately from poll counts, unknown outcomes, reconnect frequency, guarded-save failures, stale-data duration, and attempted replay (target zero). Compare against a pre-rollout baseline; a decline in logged 401s alone is not success.

## Completion criteria

- No automatic replay of a generation with unresolved remote outcome, including after process death and lease expiry.
- No Tesla-only failure disables an app account or invalidates an otherwise valid session.
- Existing suspension, session revocation, ownership, and command authorization remain intact.
- TRMNL markup never waits on Tesla; stale values remain visibly stale or unknown.
- Reconnect replaces credentials safely and restores all linked surfaces without relinking installations.
- Production telemetry distinguishes confirmed credential rejection, uncertain rotation, and configuration outage.

## Suggested delivery order

Ship tasks 1–2 together as the token-integrity fix; tasks 3 and 5 together as the access/reconnect change; task 4 independently after its tests. Apply task 6 verification and rollout requirements to every delivery. Do not delay the replay protection for UI polish, and do not ship session preservation without working connection gating.
