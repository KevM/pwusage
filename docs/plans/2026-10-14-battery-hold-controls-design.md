# Battery Hold Control Center and Live Activity Design

## Agreed direction

Add a Control Center portal into the existing native Battery Hold flow and a
Live Activity to monitor an active hold. Ten simultaneous site holds must remain
manageable even when upstream requests are slow. Reuse the existing `BatteryHold`
table wherever possible; do not introduce a second hold lifecycle or hold-job table.

This records the chosen direction and proposed implementation defaults. It does
not claim that the feature or scaling protections are implemented or deployed.

## First-release experience

Proposed default: the control opens the existing sheet for a configured site,
where the user reviews reserve and Auto/fixed duration before starting. The user
has chosen the control plus Live Activity direction, but has not selected direct
one-tap Auto start. Defer direct writes from the extension and remote push-to-start.

After a confirmed start, the app starts and registers a Live Activity. On opening
an existing active hold, offer or resume monitoring without starting another hold.
Show site, target reserve, monitoring phase, measurement/check age, and fixed
restoration time or Auto safety deadline. Say home load, not verified car charging.
Tap through to existing controls and their stop confirmation. Dismissing the
activity never stops the hold. An unavailable Live Activity never prevents a hold.

Only confirmed server state is displayed as current. Failed/stale checks are
explicit; reaching a deadline is not proof that reserve restoration succeeded.
End with confirmed restoration/cancellation status. Apple limits standard Live
Activities to eight hours, while fixed holds can last 24 hours: explain the display
limit and retain the app/control as access to longer holds. Do not silently restart
activities to evade the platform limit.

## Existing system, verified from source

- `cmd/next-app/db-migrations/20260525030000_supabase_cron_trigger.sql` schedules
  Postgres `pg_cron` every 15 minutes and calls Vercel using `pg_net` and Vault
  credentials. Vercel Cron only handles the daily jobs.
- `src/app/api/cron/restore-reserve/route.ts` loads all active holds and processes
  them sequentially. Auto holds call `refreshTodayData`, read persisted history
  from 30 minutes before hold creation, evaluate the load, and potentially restore.
  Timer holds use the deadline, without importing history.
- `refreshTodayData` attempts today's five-minute Tesla history import, preserving
  shared import claims. Its eight-second wrapper bounds a wait, not necessarily
  cancellation of the underlying operation. Refresh failure is returned as data.
- The route currently continues with saved samples after refresh failure.
  Presentation reports stale data after 20 minutes; this is not a freshness gate
  on all load-end decisions. The route's clock is currently captured once per run.
- The monitor's Tesla client has no general transport deadline. Token refresh,
  rate-limit waits, restoration reads/writes, and database access must be included
  in the runtime budget, not just the history import.
- `pg_net` queues asynchronously and records HTTP failures separately. Successful
  cron SQL does not imply successful endpoint execution. Our trigger neither
  stores/correlates the returned ID nor retries failed HTTP requests early.
  Its HTTP timeout is implicit; verify the installed extension signature before
  choosing an explicit value. A timeout does not prove the endpoint did no work.

## Monitor capacity and safety

First implementation stage: harden monitoring before adding push traffic.

Retain one 15-minute monitor trigger. Process up to three independent sites at
once, with a configurable limit, rather than serializing all sites or launching
unbounded requests. Give each site's external calls real cancellation/deadlines
where supported; a timed-out Tesla write is an uncertain outcome to reconcile,
not permission to send the same command again immediately. Bound database waits
and token-refresh/rate-limit work as well. Measure and configure the endpoint and
Postgres HTTP budgets consistently with the deployed Vercel runtime.

Proposed acceptance target: ten holds finish their bounded monitoring attempts
within 120 seconds under simulated slow/failing upstream dependencies. This is a
local test target, not a promise that Tesla answers or restores within that time.
Record eligible/skipped/failed/completed counts and runtime without exposing tokens.

Prioritize elapsed timer/Auto safety deadlines. Evaluate those before history
refresh; do not spend history latency on an already-required restoration. Use a
fresh clock per hold. Require sufficiently recent history for load-driven early
restoration; stale/unavailable data should keep holding with honest status, while
deadline restoration remains eligible. Preserve existing reserve-change protection.

Reuse `BatteryHold` for a short-lived monitor processing lease if needed, with an
atomic DB claim and owner-conditioned release. Keep it separate from existing
Site import/live claims. Concurrent cron requests must not issue duplicate restore
commands; manual stop/start races must respect hold identity and existing write
semantics. A lease alone does not make external writes exactly once: bound I/O,
reconcile uncertain outcomes, and test expiry/ownership handling.

## Data model and push delivery

`BatteryHold` remains authoritative for mode, reserve, dates, status, cancellation,
and monitoring. Reuse its existing columns first. Add only fields needed for monitor
claiming/order if tests establish that they are necessary.

Proposed one child table, `BatteryHoldActivity`, stores each registered activity's
hold ID, authenticated user, client registration ID, current token, APNs environment,
expiry, and delivery bookkeeping. One hold may have zero or several activities.
Use generated migrations and RLS/service-role grants. Do not store tokens in the
hold's monitoring JSON or introduce separate hold-job/outbox tables.

Keep the desired push snapshot/version and delivered version on each registration.
Monitor updates and confirmed terminal transitions persist desired delivery state.
Registration immediately seeds the latest state, including completion that raced
with registration. A delivery claim sends one snapshot and advances only that
version; a newer desired version remains pending. Retries cannot revive an ended
activity or regress status. Terminal delivery state survives removal from the
active-hold query. Expire pending registrations after their useful display lifetime.

Use a separate Postgres-triggered `/api/cron/battery-hold-activity-delivery` request,
provisionally every minute, to claim a bounded batch of pending registrations and
send APNs requests with bounded parallelism. This is a proposed new trigger, not
an existing worker. Delivery failures never consume the battery monitor's budget.
No pending registrations means no Apple calls; no iOS observers means no additional
Tesla calls. Retry temporary errors with backoff; disable invalid/expired tokens;
surface persistent credential failures. Recheck current authorization before sending.

This supersedes the earlier tentative idea of sending a bounded push batch at
the end of the monitor request: isolation is preferable for the ten-site requirement.

## iOS and authorization

Use an authenticated registration endpoint scoped to the hold/site and current
user access; never trust site/hold IDs or APNs environment supplied by the client
without validation. Keep Apple signing keys server-only and sandbox/production
registrations distinct. Treat activity tokens as sensitive delivery addresses.

The app starts ActivityKit with token pushes, observes token changes, registers
them, and reconciles activities on launch/foreground. Logout/site-access revocation
must stop delivery and clear private local presentation. Dismissal unregisters when
observable; expiry/invalid-token cleanup handles cases where the app never runs.

Read `docs/plans/2026-09-24-ios-widget-authorization-design.md` before extension
networking. This first launcher does not fetch private state or write commands from
the extension, so an App Group cookie migration is not automatically required.
Its earlier direct-start proposal is deferred here. Add shared authentication only
if an extension actually needs authenticated network access.

Preserve signing team `6HQGHHRK87`. Verify provisioning and push capabilities on
real devices; simulator fixtures cannot establish APNs delivery while the app is closed.

## Delivery sequence

1. Monitor isolation, deadlines, freshness and ten-site regression coverage.
2. Control Center launcher and deterministic site/sheet navigation.
3. Registration model/API and durable per-activity delivery state.
4. APNs sender and separate delivery trigger, including terminal events from web
   and native manual stop paths.
5. ActivityKit lifecycle and layouts; device verification and gradual rollout.

## References

- [Apple controls](https://developer.apple.com/documentation/widgetkit/creating-controls-to-perform-actions-across-the-system)
- [ActivityKit push updates](https://developer.apple.com/documentation/activitykit/starting-and-updating-live-activities-with-activitykit-push-notifications)
- [Live Activity lifecycle](https://developer.apple.com/documentation/activitykit/displaying-live-data-with-live-activities)
- [Vercel Node runtime](https://vercel.com/docs/functions/runtimes/node-js)
- [pg_net behavior](https://github.com/supabase/pg_net)
