# Production observability

pwusage exports selected structured server events to Axiom directly using
`@axiomhq/js`. This works on Vercel Hobby without a paid log drain. It does not
copy arbitrary `console` output, build/platform logs, or iOS logs.

## Configuration

Set these server-only Vercel environment variables for **Production**:

- `AXIOM_TOKEN`: API token with ingest permission for the dataset only.
- `AXIOM_DATASET`: `pwusage` (or your chosen dataset name).

Do not use `NEXT_PUBLIC_` names. Export is enabled only when `VERCEL_ENV` is
`production` and both values are nonempty. Preview, local development, and
maintenance scripts keep console logging. Changing configuration takes effect
on the next deployment. This SDK's default endpoint targets Axiom's US East
region; a dataset in another edge region needs matching SDK edge configuration.

## Coverage

- `/api/trmnl/markup` (GET and POST): request outcome/duration, reauthentication
  screens, inline live-refresh failures, background refresh exceptions.
- `/api/site-live-data`: request outcome/duration and Tesla refresh events.
- `/auth/tesla-callback`: sign-in outcome, request completion/redirect/failure.
- All `/api/cron/*` routes: request outcomes, job summaries and failures.
- Tesla refreshes inside those routes: start/success/failure, lock contention,
  token endpoint rejection (host, HTTP status, allowlisted OAuth error code),
  credential persistence and committed auth revocation.
- Account verification: cron start, batch size, checks started/checking/completed,
  recently-active skips, and interrupted checks. Each check has an independent
  `verificationId`; checking/results include the selected `siteId`. Batch-selected
  state is explicitly named `selectedAuthStatus`, `selectedIsActive`, and
  `selectedLastCheckedAt`; it is a snapshot, not a fresh DB read. Results include
  `outcome`, a fixed `reason`, and `durationMs`. User IDs (which can be emails)
  and credentials are not included.
  Interrupted checks also identify the failed `phase` (site lookup, client
  construction, live status, or status write); failed writes do not report a
  completed account transition.
- Refresh waiters: `tesla.refresh.wait-revoked`, `wait-completed`, and
  `wait-timeout` identify the site, observed auth status where available, and
  elapsed `waitedMs`. A waiter observing revoked credentials throws a terminal
  `TeslaAuthError`, preserving inactivity through account verification.
- Gap healing: `cron.heal-gaps.started`, per-site `cron.heal-gaps.site.started`
  and `cron.heal-gaps.site` results, plus the batch completion/failure. Start
  and result checkpoints export during the run so a later timeout does not
  discard all earlier progress. Results include `outcome` and, when known,
  `processedWindows` / `totalWindows`. Each site event includes `recovering`,
  `authLostAt`, `authRestoredAt`, `windowStart` and `windowEnd` (UTC ISO strings).
  The timestamps are the DB's last recorded outage, not new transitions per
  cron run. Repeated snapshots must not be counted as repeated losses/restores.

## History repair after re-authentication

The existing `heal-gaps-trigger` calls `/api/cron/heal-gaps` every two hours.
Sites qualify after live use within seven days **or** after their last recorded
auth outage ended within 14 days. Both paths require an active owner, a refresh
token and a non-revoked auth status; the recovery path also requires an `active`
status and a restore timestamp later than the loss timestamp. A recovered site
does not need a web, iOS or TRMNL live refresh to enter the next cron run.

The existing planner extends the audit to the site-local loss day, clamps it to
installation, and keeps old open records eligible for 14 days after recovery.
Today belongs to live refresh. Settled complete, gapped and empty records remain
settled; this is not a forced re-import of all outage days. Repair imports at
most three day windows per site per run with a shared 35-second work budget,
50-second I/O deadline, and the existing per-site import locks. Remaining work
is re-planned from stored coverage on the next run, least-recently-imported sites
first. No new schedule or production migration is needed.

Monitor `recovering=true` site results: `partial` means more planned work remains,
`busy` means another import owns the lock, `no-tokens` / `error` means the attempt
could not proceed. A start without a result can indicate an interrupted run.
`complete` means no more planned imports in that audit range, not that every
five-minute slot exists; settled gaps may remain. Recovered sites whose counted
window is already full emit a zero-work complete result without loading tokens
or fetching Tesla. Timestamp snapshots can include estimated loss dates from the
initial migration backfill, and describe only the most recent outage. Recovery
attempts beyond 14 days and general new-site history onboarding remain separate
work; this change does not persist an indefinite recovery queue.

```apl
['pwusage']
| where environment == 'production' and event == 'cron.heal-gaps.site'
| where recovering == true
| order by _time desc
| project _time, siteId, authLostAt, authRestoredAt, outcome,
    processedWindows, totalWindows, windowStart, windowEnd, requestId
```

The new fields appear in Axiom after deploying this code and running the cron.

## Event context

`src/lib/observability.ts` uses AsyncLocalStorage to attach `requestId`, route,
method, environment, deployment and commit. Authorized site context is attached
where available; refresh events also carry their specific `siteId` explicitly.
Multi-site sign-ins and archive/heal/restore cron jobs include `siteIds` and
`siteCount`; a single known site also gets `siteId`. Site lists are capped at 100.
Global user checks and activity-delivery summaries may have no site identity.
Unknown or unauthorized requests retain request IDs without trusting query
parameters as authenticated site identities.
No new database queries or Tesla calls are needed for telemetry.

Events use fixed names and explicit fields. Request headers, URLs, query strings,
response bodies and auth payloads are not collected. Error objects export only
name/code/status/cause, deliberately omitting messages and stacks because
upstream errors may contain credentials. Nested sensitive field names are
redacted. Avoid passing raw upstream strings to `logEvent`.

## Delivery and limits

Events are mirrored to Vercel runtime logs and exported in per-request batches
with Next.js `after()`. This keeps delivery off the response path and binds it to
the serverless invocation. Events emitted by background `after()` work schedule
a further lifecycle-bound batch; concurrent requests do not share buffers.
The check-users cron also starts nonblocking export checkpoints at cron start,
before each site's verification, and after each result/interruption. These send
buffered events immediately while `after()` retains lifecycle ownership, so
partial progress can reach Axiom even when a later operation times out. The
existing network deadline, redaction, and per-invocation event cap still apply;
checkpoints do not guarantee delivery or increase the cap.

Each invocation exports at most 200 events; arrays, object depth, field counts and
string length are bounded. Export uses a 2.5-second shared network deadline per
batch (SDK retry delays can add time). Delivery is best effort: function timeouts,
network errors, rate limits and quota exhaustion can lose Axiom events. These
failures never change the business response; a count-only diagnostic remains in
runtime logs. Events are not queued in Postgres or retried on a later invocation.
Axiom failure responses and credentials are never included in diagnostics.

## Verify after production deployment

1. Open Axiom's dataset stream for `pwusage`.
2. Make an ordinary authorized Today/live-data request or let TRMNL poll.
3. Confirm `request.completed` with the expected `route`, `environment`,
   `deployment`, `durationMs`, and `requestId`.
4. Search the same request ID to correlate its Tesla/TRMNL events. Token refresh
   events appear only when a refresh is actually needed; do not force a refresh
   merely to test logging.
5. Let a scheduled cron execute and check its `request.completed` and job event.
   A disabled cleanup job or idle activity delivery may only emit completion.

Example APL queries (adjust dataset name if needed):

```apl
['pwusage']
| where level in ('warn', 'error')
| sort by _time desc
```

```apl
['pwusage']
| where event == 'tesla.auth.revoked'
| summarize count() by bin(_time, 15m), siteId
```

To trace account verification and refresh-lock decisions together:

```apl
['pwusage']
| where route == '/api/cron/check-users'
| where event startswith 'tesla.user-verification.'
    or event startswith 'tesla.refresh.'
    or event == 'tesla.auth.revoked'
    or event == 'tesla.token-endpoint.rejected'
| sort by _time asc
```

Use `requestId` to follow the entire cron invocation and `verificationId` to
pair a user's start and outcome. Use `siteId` on checking/results to correlate
TRMNL polls. An `outcome='error'` with `reason='transient-failure'` records the
path that keeps an account active; `outcome='revoked'` records terminal failure.
If only a start/checking checkpoint exists, inspect platform timeouts and the
count-only export-failure diagnostics before assuming the account changed state.

After measuring normal volume, configure Axiom monitors for an unusual increase
in `tesla.auth.revoked`, failed cron requests and TRMNL errors. Monitor rules and
notification destinations are account configuration, not installed by this code.

References: https://axiom.co/docs/send-data/nextjs and
https://nextjs.org/docs/app/api-reference/functions/after.
