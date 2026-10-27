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
- All five `/api/cron/*` routes: request outcomes, job summaries and failures.
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
