# Battery hold monitor hardening

This PR implements approved plan Tasks 1–2. It reuses `BatteryHold`; there is no
new lifecycle/job table, Apple push workload, activity registration, or iOS UI.

## Verified configuration, October 14, 2026

Read-only production SQL found pg_net **0.20.0** and this installed signature:

```sql
net.http_get(url text, params jsonb DEFAULT '{}'::jsonb,
  headers jsonb DEFAULT '{}'::jsonb,
  timeout_milliseconds integer DEFAULT 5000)
```

`restore-reserve-trigger` runs `*/15 * * * *` in PostgreSQL pg_cron and queues
HTTP through pg_net. It is separate from the daily Vercel cron configuration.
The generated schedule migration preserves the cadence and existing Vault secret
lookups, setting `timeout_milliseconds := 65000` explicitly.

Vercel project `pwusage`, production deployment `dpl_8BhUy6GddQXh9p9xYAswGnDvz2e6`,
reported Node **24.x**, plan **hobby**, `functionType: standard`,
`functionMemoryType: standard_legacy`, `isUsingActiveCPU: false`, and the existing
function default timeout **10 seconds**. These were inspected through the CLI
API with the existing project/team credentials; the connector lacked that scope.
The new route explicitly exports Node runtime and `maxDuration = 60`, keeping
within the legacy Hobby ceiling without requiring a Fluid Compute change.

References: [Vercel route duration configuration](https://vercel.com/docs/functions/configuring-functions/duration)
and [pg_net request semantics](https://github.com/supabase/pg_net).

## Budgets and failure behavior

| Work | Budget |
| --- | --- |
| Load active holds | 2 seconds |
| Concurrent site attempts | 3 |
| One site, including claim, history, tokens, restore and telemetry | 10 seconds |
| History refresh, within site budget | 4 seconds |
| Failure telemetry / lease cleanup | 1 second each, independently caught |
| Stop admitting additional work | after 40 seconds; skipped sites remain active |
| Live Activity reconcile (once per run, after the workers: expire, prune rows retired over 24 hours, sync live rows) | 2 seconds, isolated from the site deadlines, never fails the run |
| Database pool | 3 connections; acquisition 1s; statement 1.5s; lock 1s; query 2s |
| Route / pg_net caller | 60s / 65s |
| Hold processing lease | 120 seconds |
| Uncertain-write resend deferral | at least 15 minutes, with a reserve re-read |

For ten holds, four waves of at most 12 seconds (including both cleanup budgets)
plus the initial query fit inside the route duration with headroom. The worst
case is about 2 seconds to load, up to 40 seconds of admission, 12 seconds for
the last admitted site, and 2 seconds for the Live Activity reconcile: roughly
56 of the 60 seconds the route allows (65 seconds for pg_net). The run summary
reports `activitiesSynced`, the number of registrations advanced; `null` means
the reconcile was deferred (it timed out or failed, and the next run retries).
The timing test (`battery-hold-monitor-timing.test.ts`) models the full reconcile
budget, so raising it or adding a second step trips the 60 second guard. This bounds
attempts under the tested conditions; it does **not** guarantee Tesla restoration
within 120 seconds or successful upstream responses. Work admission also bounds
larger queues; inspect skipped counts if the fleet grows beyond the tested size.

Real fetches receive the request-local abort signal. Token refresh, retry delays,
body reads and DB acquisition share that deadline; no retry starts after expiry.
A canceled or disconnected request can still have reached Tesla. A durable marker
written before the command prevents an immediate blind resend. Subsequent checks
read the current reserve: original confirms restoration, another user-selected
reserve cancels the hold, and the hold target defers a resend for one poll interval.
An explicit typed 401/403 rejection clears the attempt timestamp and reason
under the active claim owner, allowing immediate retry after reauthentication.
Transport failures (including a lost response to the post-refresh retry) retain
the marker. If clearing the rejected attempt fails, it remains conservative.
Token-refresh lock release and atomic revocation run in an independent one-second
cleanup scope after cancellation; failed cleanup falls back to lock expiry.
The existing manual/recent-hold reserve protections remain in place for first
attempts. Reconciliation checks reserve changes even for manual retries.

An atomic claim on the active hold id serializes overlapping monitors and manual
stop. Owner-conditioned release cannot release a successor's lease; an old hold
snapshot cannot issue a restore against a replacement hold. The lease is longer
than this function's lifetime and I/O budget. This is conservative coordination,
not exactly-once delivery across Tesla and PostgreSQL.

Timer and elapsed Auto deadlines precede history. Pending uncertain restorations
also reconcile before history. Fresh clocks are captured when queued holds start
and again after history. Load-driven early restoration requires a valid sample
within 20 minutes; stale/failed telemetry never disables a deadline restore.
Existing Site history-import and live-refresh claims remain separate and intact.

The route emits eligible, attempted, skipped, failed, completed and runtime counts
plus safe per-site statuses. No upstream errors or credentials appear in the cron
response/log summary. Telemetry and lease-release failures cannot stop peers.
Successful cron SQL means the request was queued; inspect pg_net HTTP responses
and endpoint logs to establish actual completion. A caller timeout proves neither
cancellation nor restoration.

## Reproduction and evidence

From the isolated worktree's `cmd/next-app`:

```sh
npm run test -- --run
npm run test:hold:postgres
npm run test:hold:timing
npm run test:compact
npm run lint
npm run build -- --webpack
```

The timing harness uses synthetic dependencies and deliberately hung I/O; it
never sends Tesla commands or reads credentials. The wall-clock run attempted
**10/10** holds, recorded **10 failed / 0 completed**, took **40,005 ms**, and peaked
at **3 workers**. `/tmp/battery-hold-monitor-timing.json` contains the metrics for
the most recent wall-clock run. Deterministic tests additionally cover delayed
history, one failed site with healthy peers, timer/Auto deadlines, clocks changing
while queued, stale/future telemetry, lost ownership, pending writes, token/rate
limit/body deadlines, late DB acquisition and late command completions.

Isolated PostgreSQL tests exercise the generated claim migration, ten competing
owners, lease expiry and stale-owner operations, manual stop racing a monitor,
replacement-hold identity, persisted uncertainty and retry intervals. The schedule
migration is tested against a local capturing stub; no HTTP request is executed.
CI runs the isolated claim fixture alongside the existing archive fixtures.

Full PostgreSQL-enabled web run: **1,276 passed**, with seven hold integration cases
run separately and one existing unrelated skip. (The final task log records any
later test additions.) Lint, TypeScript and the webpack production build passed.
Default Turbopack encountered the local sandbox's worker port-binding restriction;
webpack is the verified build path, without modifying the user's dev server.

## Rollout boundary

No hosted migration, scheduler change, deployment, or real Tesla command was
performed. Review and deploy both generated migrations with the application;
the claim columns must exist before the new monitor/manual restore code runs.
After deployment, verify the emitted route duration is 60s and the pg_net job
command includes 65000ms before enabling real hold traffic. Observe failed/skipped
counts and pg_net responses over a normal poll interval. Preserve the claim and
uncertainty columns if rolling application code back; old code does not understand
uncertain restoration markers, so avoid rolling back during pending commands.
