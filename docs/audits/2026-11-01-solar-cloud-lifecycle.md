# Solar CloudKit lifecycle audit — PR 264

Scope: app session publication and teardown, CloudKit startup and delegate handling,
record-store writes, and selected-site detection. This is a source and deterministic
local-test audit; live iCloud transport cancellation has not been exercised.

## Verified protections

- Authorized session publication no longer awaits optional CloudKit startup.
- Cached and fresh-session startup use one app-owned task. Teardown cancels it;
  cancellation is checked at actor entry and after startup suspension points.
  A cancelled task cannot clear the handle of a replacement task.
- Concurrent starts are coalesced. Engine events carry their lifecycle generation.
- Remote writes validate both owner and generation inside the record-store actor,
  before synchronous cache/disk mutation. Stop/restart/replacement rejection is tested.
- Session cleanup stops synchronization before removing history and layout records.
- Cloud notifications are filtered to the selected scope. Coordinator teardown and
  site changes cancel detection; scheduled lookup detection checks its generation.
- History decoding checks the actual site-local day duration, including half-hour DST.

## Remaining findings from source inspection

These are not claims of reproduced end-to-end failures. They identify uncovered
interleavings and prevent treating passing tests as a complete stability guarantee.

1. **Delayed local notifications have no lifecycle identity.**
   `SolarLayoutRecordStore.notifySync` launches an unstructured task containing only
   a scope. `SolarLayoutCloudSync.recordChanged` persists that scope even while
   stopped (intentionally supporting offline saves). A notification dispatched before
   sign-out can arrive after `stop` clears pending state and recreate pending metadata.
   Offline retention and signed-out rejection need distinct states, with the originating
   lifecycle carried by local-save notifications.

2. **Stop can overlap replacement startup.**
   `stop` invalidates the engine, then awaits `store.setSync(nil)`, then clears shared
   state. A replacement `start` can enter during that await. The older stop's trailing
   `clearState` is not generation-guarded. Startup and shutdown need an explicit shared
   transition owner/barrier, with tests suspending detach while requesting a new start.

3. **Outgoing record construction is checked only before its store read.**
   `nextRecordZoneChangeBatch` checks the engine before calling `makeRecordForEngine`,
   but the latter awaits `store.record` and constructs a record without rechecking.
   Stop during that read could return an account record to an obsolete engine. Local
   event fences do not establish that transport work has been cancelled. Add a
   post-read lifecycle check and verify the engine's cancellation contract separately.

## Recommended next implementation boundary

Treat session lifetime, optional iCloud availability, and engine lifetime as explicit
separate concepts. Give every asynchronous producer (startup, local notification,
remote application, outbound record construction) a session/lifecycle identity.
Serialize stop/replacement-start ownership rather than adding independent guards
without a shared transition model. Preserve offline saves within an authorized session.

Required transition tests: queued startup after sign-out; startup paused at each
await; stop paused during detach with a replacement start; a queued local save
released after cleanup; an outbound record read released after stop; and selected-site
changes while cloud updates arrive. Existing tests cover only part of this matrix.

## Resolution (2026-11-01)

Implemented per [the lifecycle specification](../plans/2026-11-01-solar-cloud-lifecycle-spec.md)
as one ownership model, not per-race flags. Paths are relative to `cmd/ios-app/PWUsage/State/Solar`.

- **Identities.** `SolarCloudSession` (session authority, synchronously revocable) and
  `SolarCloudEngineToken` (one CloudKit attempt) are UUID-backed and never persisted.
  Sessions come from `SolarCloudSessionIssuer`; ending a session revokes every session
  issued before the end began, so a replacement that raced into the teardown window is
  also fenced (`solar-cloud-session.swift`).
- **Single owner.** `SolarLayoutCloudSync` holds `Phase` (inactive / active / ending
  barrier / cleanupFailed) and `Engine` (offline / starting / running). Every continuation
  after an await re-proves ownership (`owns(_:)`, `session(owning:)`, `isStarting`).
  Offline is an authorized state; losing iCloud stops only the engine.
- **Write boundary.** `SolarLayoutRecordStore` checks a `WriteAuthority` synchronously at
  every local and remote write (unrestricted before any session binds in a process,
  then session-bound, then closed after sign-out or failed cleanup). Activation publishes
  `.active` only after the store bind completes; same-session joiners wait for it.
- **Engine binding.** The current engine token lives in the session's lock. The actor
  attaches and compare-and-clears it inside its own turns, and the store reads it
  synchronously at the remote-write boundary, so no cross-actor attach/detach message
  exists to arrive late. A stop or an obsolete attempt can release only its own token
  (finding 2). Stopping an engine has no suspension, so there is no separate `stopping`
  state for a start to queue behind.
- **Durability.** Chosen mechanism: a write-ahead unsynced marker committed before each
  local save, with a fresh generation per save. Notifications are hints carrying the
  session captured in the committing turn; the owner moves markers into its persisted
  upload queue on activation and on each accepted hint, then acknowledges only the
  generations it read, so a save landing in between keeps its marker. The upload queue
  is cleared per scope on confirmed saves, never on engine state updates (a
  serialization can predate later saves). An unreadable marker file reads as empty
  rather than blocking saves. Sign-out removes markers with the records, so a stale
  hint has nothing to recreate (finding 1). Launch-time and background saves made
  before activation are recovered by the next authorized activation.
- **Barrier.** `endSession` revokes authority and the engine before its first suspension,
  then one barrier closes the store, removes sync metadata and runs the complete
  `SolarForecastStoreSessionCleanup` (providers, history, layout records). Repeated ends
  join it; replacement activation waits on it. Any failed step leaves `cleanupFailed`
  (store closed, activation refused) until an explicit retry. App authorization retries
  the cleanup once; if it still fails, the dashboard publishes with solar layout writes
  closed and the cleanup-failure message shown, and the next authorization retries.
- **Outgoing records.** `makeRecord` checks the token before the store read and again
  after it, before reading system fields; serialization is synchronous (finding 3).
  Delegate events, resend retries, sign-in fetches and app callbacks carry their token or
  session and revalidate before acting.

### Transport limits (not verifiable locally)

CloudKit documents `CKSyncEngine.cancelOperations()` as asynchronous: operations in flight,
including already-submitted uploads, may complete after it returns. Cancellation is
therefore fired without being awaited and is never treated as quiescence; it cannot
retract an upload the service already accepted. The local guarantee is only that
invalidated work cannot obtain new records, publish local state or recreate files.
No test here exercises a real iCloud account; device behaviour of account switches and
cancellation timing remains unverified.

### Acceptance matrix evidence

Suites: `SolarCloudSessionLifecycleTests` (S), `SolarCloudEngineLifecycleTests` (E),
`SolarLayoutCloudSyncTests` (C), `SolarLayoutSessionCleanupTests` (L). Every negative
case has a current-session positive control in the same test or a named sibling.

| Interleaving | Test(s) |
| --- | --- |
| Queued local notification released after sign-out | S "A local-save notification released after sign-out recreates nothing" (`.none`); control: S "A delayed local-save notification for the current session is accepted and uploaded" |
| Old notification after same/other-account replacement | S same test, `.sameAccount` / `.otherAccount` |
| Offline save, restart, activate matching account | S "Saves made offline or before notification survive a restart" (notified and un-notified); negative: S "Another account's unsynced markers are not recovered" |
| End before queued startup enters actor | C "Sign-out before queued startup reaches the actor…" (with control); C "Cancelled queued startup cannot attach" |
| Startup paused at attachment / account lookup / fetch, then sign-out | E "Startup suspended at a boundary cannot publish after sign-out" (store binding, account lookup, fetch × sign-out/control); engine attachment itself has no suspension |
| Old detach paused, replacement start, detach resumes | Detach no longer suspends (synchronous token compare-and-clear). The remaining interleaving, an obsolete startup resumed after stop and replacement start: E "An obsolete startup resumed after a stop and replacement start leaves only the replacement attached" |
| Record deletion paused, replacement activation | S "A replacement cannot write until the old session's cleanup barrier resolves" (same/other account) |
| Outgoing read paused across restart or sign-out | E "An outgoing record read resumed after its engine is superseded returns nothing" (control: current token produces a record) |
| Repeated concurrent starts and stops | E "Concurrent starts and stops coalesce without orphaned attachments" (with and without sign-out); S "Concurrent sign-outs join one cleanup barrier" |
| Cleanup step fails while replacement requested | S "A failed cleanup step still runs the rest, blocks replacement writes, and can be retried"; app level: C "A failed sign-out cleanup is retried at authorization and keeps solar writes closed until it succeeds" |
| Cloud callback queued, session ended | C "A cloud callback queued before sign-out starts no detection afterwards"; control: C "Selected-site remote updates start detection" |
| Selected-site detection plus unrelated cloud update | C "Unrelated remote records do not cancel selected-site detection" (same/other account) |
| Slow/unavailable cloud during fresh or cached authorization | C "Authorized session publishes while optional cloud account lookup is suspended" (fresh, cached); E "Unavailable iCloud leaves the session offline with pending work for a later start" |

Review fixes: S "A concurrent activation of the same session returns only after the store
is bound", S "A save landing between reading and acknowledging markers keeps its marker",
S "An unreadable unsynced-marker file does not block local saves".

Remote writes from obsolete owners (stopped, restarted, replaced, signed out) and local
writes from an ended session: L "Obsolete remote applications cannot recreate cleared
layouts", L "Local layout writes from an ended session are rejected before touching disk".

Reproduction: each audited finding was reintroduced in isolation and the matching tests
failed — unfenced notification scope insertion (all three replacement variants), an
unscoped engine release, and removal of the post-read outgoing check — as did removing
the barrier wait, the bind wait for joiners, the local write fence, the marker
generation check, the post-lookup startup check and the app callback check. Removing
only the actor's notification fences is still caught by the store's binding check
(defense in depth), so that single mutation alone passes.

### Remaining limitations

- `endSession` is the account-wide sign-out wipe and takes no token. A duplicate end
  arriving after an unrelated replacement had already activated would end it too. Both
  app teardown paths call cleanup exactly once, so no current flow produces this.
- `activate` rejects a second live session while another is active; the app treats that
  as non-blocking. Only multiple app models sharing `.shared` (tests) reach it.
- The stale-state-update case is fixed by construction (no clearing on state updates)
  but has no direct test, since `CKSyncEngine.Event` values cannot be built in tests.
- If a record save throws after its atomic write (protection or backup attributes), no
  notification is sent; its marker is recovered by the next activation or local save.
- iCloud account switches, real cancellation timing and engine event delivery are
  exercised only through the fake transport; they remain unverified on device.
