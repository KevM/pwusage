# Solar cloud lifecycle specification

Status: proposed implementation contract; no runtime changes in this document.

Source: [PR 264 lifecycle audit](../audits/2026-11-01-solar-cloud-lifecycle.md).
Baseline: `a5a7785b` on `codex/solar-layout-phase-c`.

## Goal

Make solar synchronization safe across session teardown, optional iCloud failures,
and overlapping asynchronous work. Preserve offline layout changes without allowing
obsolete work to restore account data or interfere with a replacement session.

The audit identified three uncovered interleavings, not three reproduced production
failures. Implementation must first reproduce them with deterministic tests.

## Scope

Address all three findings together:

1. Local-save notifications delivered after their originating lifecycle ends.
2. Stop suspended during detach while a replacement start is requested.
3. Outgoing record construction resumed after its engine becomes obsolete.

Retain the existing protections for remote writes, session publication, and selected-site
detection. No changes to detector mathematics, merge precedence, server APIs, CloudKit
record schema, or device signing are required. No new user interface is required.

## Observable requirements

- Successful app authorization publishes the authorized session and coordinator without
  waiting for iCloud account lookup, network fetches, or transport cancellation.
- An authorized user can save and detect layouts while iCloud is unavailable. Changes
  remain durable and upload when synchronization becomes available in that session.
- Successful sign-out removes local account/location records and synchronization metadata.
  Work from the ended session cannot recreate them, even after another session starts.
- Starting a replacement session during old-session cleanup cannot cause that cleanup
  to delete the replacement's data or detach its store binding.
- Cloud updates for unrelated scopes do not interrupt selected-site detection.
- A record provider resumed after engine invalidation returns no record to that engine.

## Ownership model

Use one explicit lifecycle owner, hosted by the synchronization actor, for transitions
and their completion barriers. App code requests transitions; it does not independently
mutate the record store's synchronization attachment.

Keep three identities distinct:

| Identity | Meaning | Lifetime |
| --- | --- | --- |
| Account scope | Existing persisted namespace used for local records and cloud merge rules | Existing account-scope policy |
| Session token | Authority to produce or consume account data in this app session | Cached-session restoration or authorization through teardown |
| Engine token | One CloudKit engine/startup attempt within a session | One attempt through invalidation |

Tokens must not be reusable by a replacement owner. Prefer opaque UUID-backed value
identities over unrelated integer counters that can coincide across owner instances.
A token is an in-process authority, not a credential and not a persisted account identifier.

The app creates or adopts one session authority before scheduling optional startup.
Repeated authorization refreshes and cached-to-verified transitions retain that authority;
actual session invalidation ends it. A request with an ended token must never create
fresh authority merely because it reaches the actor late.

A fresh process may restore durable pending work only after restoring/authorizing the
matching account scope. It creates new runtime tokens; it must not require persisted
work to contain a still-valid token from the previous process.

## State model

Session states:

- `inactive`: no session may mutate account synchronization state.
- `active(session, accountScope)`: local changes are accepted for this session.
- `ending(session, completion)`: authority is revoked, cleanup owns the old state,
  and replacement activation waits for the cleanup barrier.

Within an active session, cloud states are `offline`, `starting(engine)`,
`running(engine)`, and `stopping(engine, completion)`.

`offline` is an authorized state and retains pending work. It is not interchangeable
with `inactive`. Loss of iCloud availability invalidates the engine but does not by
itself sign the user out of the application or discard their offline layout changes.

### Transition contract

| Request/event | Required behavior |
| --- | --- |
| Activate same current session | Idempotent; do not replace tokens or discard pending work |
| Activate replacement while ending | Wait for the old cleanup barrier before attaching or writing replacement state |
| Start while offline | Create one attempt for the current session; app publication remains independent |
| Start while starting/running | Coalesce or return existing completion; never attach a second engine |
| Start while engine stopping | Queue/coalesce behind its completion, then revalidate the requesting session |
| iCloud unavailable/start failure | Return to authorized offline state; preserve pending changes; allow later retry |
| Stop engine only | Invalidate engine authority immediately; preserve session and offline work |
| End session | Revoke session and engine authority before the first suspension; perform cleanup once |
| Repeated end for same session | Join the same completion barrier; do not repeat destructive cleanup |
| End/stop for obsolete token | No mutation of newer state |
| Delayed operation from obsolete token | Reject before cache, disk, engine state, or callback mutation |

Only a lifecycle owner may finish its transition. Every continuation after an await
must either prove ownership or perform cleanup confined to resources captured from the
old owner. Actor isolation alone does not supply this ownership across suspension.

## Local-save notification contract

The record store captures its session/binding identity at the same synchronous actor
turn that commits a local save. A later notification carries that captured identity
and the affected scope. It must not read the current token when eventually delivered.

The receiver validates the notification before updating pending scopes, creating a
metadata directory, enqueueing an upload, or invoking a callback. An ended session's
notification is rejected even if its account scope matches the replacement session.
Engine replacement within the same active session must not lose accepted local saves.

Persist the accepted pending work before treating notification processing as complete.
Pending work survives an iCloud failure and process restart. Preserve existing
per-scope coalescing and merge semantics; lifecycle tokenization must not restrict
legitimate cross-device scope merging to exact token equality.

Avoid a durability gap between saving a record and delivering its notification:
either commit a durable dirty marker with the save, or reconcile locally saved records
on authorized startup. Choose and document one approach in implementation. A process
termination between those two operations must not strand the new record indefinitely.

## Stop, cleanup, and replacement activation

Session teardown has this order:

1. Revoke session/engine authority synchronously and cancel app-owned queued startup.
2. Reject new old-session work and invalidate the record store's old binding.
3. Cancel or quiesce owned transport work according to the verified SDK contract.
4. Clear old synchronization metadata, provider caches, history, and layout records.
5. Resolve the teardown barrier; only then may replacement activation attach and write.

The barrier covers the entire destructive session cleanup, including work currently
performed by `SolarForecastStoreSessionCleanup`, not just `SolarLayoutCloudSync.stop`.
Otherwise a new session could attach after cloud stop but before old record deletion.

A cloud-only restart uses a separate barrier and does not delete account records or
pending authorized changes. An old stop must not execute shared `clearState` against a
new owner after returning from detach. Scope cleanup by ownership or keep replacement
activation behind the full barrier; do not rely on actor queue FIFO ordering.

All cleanup steps still run when one fails. Report cleanup failure, preserve an
inactive/non-writable state, and permit an explicit cleanup retry. Do not publish a
replacement binding as active while old destructive cleanup can still run. Optional
cloud networking must not hold the local cleanup barrier indefinitely.

## Outgoing and incoming record contract

An outgoing record request captures both session and engine tokens. Check them:

1. Before beginning the store read.
2. After the suspended read returns, before reading current system fields or serializing.
3. Before returning a record if serialization itself introduces another suspension.

If ownership changed, return `nil`. Do not mix an old record with newer system fields.
Remote merges continue to validate owner and lifecycle at the record-store write
boundary, with no await between validation and synchronous persistence.

Delegate events, detached retries, and queued UI callbacks carry their originating
identity. A callback posted before sign-out but executed afterward must revalidate
session authority before notifying the runner or scheduling account work.

A post-read check cannot retract a record already handed to CloudKit. Implementation
must verify and document the SDK's supported cancellation behavior, including whether
cancellation waits for delegate activity and whether already-submitted uploads may
finish. Never claim sign-out retracts uploads already accepted by the service. The
local guarantee is that invalidated work cannot obtain new records, publish new local
state, or recreate cleared files.

## Deterministic acceptance matrix

Use controllable continuations at boundaries, not arbitrary sleeps. Release every
held continuation during test cleanup. Assert disk state through a fresh store as well
as inspecting memory. Tests must use the production ownership path.

| Interleaving | Required assertions |
| --- | --- |
| Queue local notification, complete sign-out, release notification | No pending file, record file, upload request, or callback recreated |
| Queue old notification, sign out, activate same account with new token, release | Replacement data unchanged; old work rejected |
| Save while authorized offline, restart app, activate matching account | Pending change is recovered and eventually enqueued |
| End before queued startup enters actor | No attachment or account lookup begins |
| Pause startup at attachment/account lookup/fetch, end session, resume | No obsolete engine publication or local data restoration |
| Pause old detach, request replacement start, resume detach | One correct replacement binding; old cleanup cannot erase its state |
| Pause record deletion after cloud stop, request replacement activation | Replacement cannot write until complete cleanup barrier resolves |
| Pause outgoing store read, stop/restart, release read | Old provider returns nil; current provider can still produce a record |
| Repeated concurrent starts and stops | Coalesced completions; no deadlock, orphan attachment, or stale handle |
| Cleanup step fails while replacement is requested | Remaining cleanup attempted; failure surfaced; no unsafe replacement writes |
| Cloud callback queued, end session, release callback | No detection/history request or account-state publication |
| Selected-site detection plus unrelated cloud update | Selected run completes; legitimate current-scope update still works |
| Slow/unavailable cloud during fresh or cached authorization | Session/coordinator publication succeeds independently |

For every negative case, include a positive control showing that current-session work
still succeeds. Run the matrix with both a same-account replacement and a different
account where applicable. Existing merge and offline-retention tests remain required.

## Implementation map and sequence

Paths below are relative to the repository root.

1. Establish the transition fixtures and reproduce each audit interleaving.
   Extend `cmd/ios-app/PWUsageTests/solar-layout-session-cleanup-tests.swift` and
   `cmd/ios-app/PWUsageTests/SolarLayoutCloudSyncTests.swift`; introduce focused
   lifecycle fixtures under `cmd/ios-app/PWUsageTests/Fixtures/` as needed.
2. Introduce session/engine identities and transition ownership in
   `cmd/ios-app/PWUsage/State/Solar/solar-layout-cloud-sync.swift`. Extract focused
   files under the same directory to stay within lint budgets.
3. Carry identities through `SolarLayoutSyncing` and the local-write notification
   path in `cmd/ios-app/PWUsage/State/Solar/solar-layout-record-store.swift`; implement
   the chosen durability mechanism and restart recovery.
4. Coordinate the full teardown barrier across
   `cmd/ios-app/PWUsage/State/Solar/device-solar-forecast-persistence.swift` and
   `cmd/ios-app/PWUsage/App/pwusage-app-model{,-sites,-session}.swift`.
   Keep session publication independent of optional cloud startup.
5. Fence outgoing reads, retries, and queued callbacks. Preserve selected-site behavior
   in `cmd/ios-app/PWUsage/State/Home/dashboard-coordinator-solar-layout.swift` and
   `cmd/ios-app/PWUsage/State/Solar/solar-layout-detection-runner.swift`.
6. Run the complete transition matrix, review every await/Task boundary against the
   ownership contract, and update the audit with evidence and remaining limitations.

For each behavior: establish a failing regression, implement the smallest coherent
change, and verify its positive and negative cases before integrating the next path.
Use the repository's Swift craft, concurrency, testing, and verification skills.
Do not implement this specification by accumulating independent booleans for each race.

## Verification and completion

From the worktree root:

```sh
cmd/ios-app/format.sh
swiftlint lint cmd/ios-app --strict --baseline .swiftlint-baseline.json
cmd/ios-app/run-tests.sh --quick SolarLayoutCloudSyncTests SolarLayoutSessionCleanupTests PWUsageAppModelTests
cmd/ios-app/run-tests.sh
```

Add newly introduced suites to the targeted command. Use the test runner for all native
runs; do not overlap runs. Expected: zero new lint violations, nonzero executed test
counts, and zero test failures. The full default run must succeed before updating a PR.

Completion requires traceable evidence for every acceptance row, review of every
asynchronous producer's identity, and documented SDK transport limits. Tests using
simulated suspension cannot establish real iCloud cancellation guarantees. Record any
unverified device-only behavior explicitly rather than closing it as covered.
