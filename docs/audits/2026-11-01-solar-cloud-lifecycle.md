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
