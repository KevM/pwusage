# Tesla refresh diagnostics and rollout

This change is implemented locally. Applying schema, deploying, changing production
configuration, reactivating accounts, and the 48-hour production observation are
separate operator actions. None is performed by the implementation tests.

## Invariants and writer inventory

| Writer/caller | Responsibility after remediation |
| --- | --- |
| `UserRepo.upsertOnTeslaAuth` | New accounts are eligible; existing eligibility/session version is preserved. Replace credentials, increment generation, clear superseded attempt/lease, restore connection health. |
| `TeslaTokenRepo.refreshUser` | Atomically claim ready generation and record attempt before dispatch. Guard save/outcome/cleanup; never change account eligibility. |
| `UserRepo.verifyUserStatus` / check-users cron | Row-version and membership-fenced health only. Preserve eligibility; skip unresolved/inactive accounts. Fleet rejection is not proof of refresh revocation. |
| Importer / site and user client factories | Recheck connection state before each request; invalidate site cache on failures, never deactivate accounts. |
| `UserRepo.updateUserStatus` | Explicit eligibility/status setter; currently no production callers. Must not be used for Tesla-only failure. |
| Legacy `UserRepo.updateTokens` / `TeslaTokenRepo.updateSiteTokens` | No production callers; not refresh APIs. Never use these unguarded helpers for renewal or reconnect. Production writes must use the two generation-aware paths above. |
| Session-version increment, roles, memberships | Independent app authorization. No reconnect path bypasses these checks. |
| Additive migration | Idempotent. Legacy revoked rows become reconnect-required; historical inactive accounts are reactivated so they can reconnect (every past deactivation was Tesla-health driven). |

A crash after dispatch cannot tell us whether Tesla consumed the grant. It does
not matter: the replacement was never stored, so after the two-minute retry floor
the same grant is retried, and Tesla either rotates it or answers `invalid_grant`.

## Event reference

Use `exchangeId` to trace one attempt, hashed `accountId` to group a person across
sites, and hashed `generationId` to group one credential generation. Use request,
route, site, deployment, and commit fields when present. Do not paste raw tokens,
OAuth codes, cookies, response bodies, or user emails into diagnostics.

| Event | Evidence |
| --- | --- |
| `tesla.refresh.started` | Durable in-flight claim confirmed; not proof Tesla received the POST. A bounded telemetry checkpoint starts here. |
| `tesla.token-endpoint.*` | Request/headers/body stage evidence. A dispatched transport failure cannot establish non-consumption. |
| `tesla.refresh.persistence-started` | Credentials parsed; save not yet confirmed. |
| `tesla.refresh.succeeded` | Guarded save confirmed, generation advanced; `nextGenerationId` identifies the replacement. |
| `tesla.refresh.failed` | Safe outcome, stage, status, allowlisted OAuth code, failure code, duration. Does not itself prove any DB transition. |
| `tesla.refresh.state-changed` | Outcome UPDATE confirmed; `persisted=true`, `fromState` and `toState`. |
| `tesla.refresh.outcome-superseded` / `superseded` | Guard rejected the write. Inspect newer login/save; do not count as confirmed rejection/recovery. |
| `tesla.refresh.outcome-write-deferred` / `cleanup-deferred` | Persistence/cleanup could not be confirmed; durable marker still prevents replay. |
| `tesla.refresh.replay-suppressed` | A waiter refused a reconnect-required generation. |
| `tesla.refresh.lease-expired` | A worker died mid-exchange; the account returned to `ready` with a retry floor. |
| `tesla.refresh.backoff` | A caller hit the retry floor and failed fast without an exchange. |
| `tesla.connection.credentials-restored` | OAuth credentials saved with a new generation. `accountEligible=false` still means app access is denied. |
| `tesla.refresh.paused` | Operational pause blocked a new exchange. |

`credential_rejected` means an allowlisted 400/401 invalid_grant/login_required.
`configuration_rejected` means a client/deployment error, not user revocation.
`outcome_unknown` includes lost/truncated responses and failed save acknowledgement.
`not_dispatched` is established locally. Read `stage=persistence` separately from
provider response failure. Only confirmed state changes are counted as transitions.

`auth_lost_at`/`auth_restored_at` follow the existing database health trigger.
They measure health transitions, not proof Tesla revoked permission. Connection
state and typed outcome are authoritative for that distinction.

## Queries and investigation

The existing Axiom integration exports only in production with `AXIOM_TOKEN` and
`AXIOM_DATASET`. Replace `pwusage` below if configured differently. Queries are
runbook templates; they have not been exercised against a new production release.
Check ingestion by finding a known request in both Axiom and runtime logs. Axiom
export failures are count-only runtime warnings; missing terminal events alone
cannot prove a crash or rejection. Request scopes cap event volume at 200.

Unique affected accounts versus event/poll volume:

```apl
['pwusage']
| where event == 'tesla.refresh.failed'
| summarize failures=count(), accounts=dcount(accountId), attempts=dcount(exchangeId)
    by bin(_time, 1h), outcome, stage, errorCode
```

Confirmed state changes and restorations:

```apl
['pwusage']
| where event in ('tesla.refresh.state-changed', 'tesla.refresh.succeeded', 'tesla.connection.credentials-restored')
| where persisted == true
| summarize transitions=count(), accounts=dcount(accountId) by bin(_time, 1h), event, toState
```

Persistence problems and prevented replays:

```apl
['pwusage']
| where event in ('tesla.refresh.replay-suppressed', 'tesla.refresh.outcome-write-deferred', 'tesla.refresh.cleanup-deferred', 'tesla.refresh.superseded', 'tesla.refresh.outcome-superseded')
| summarize events=count(), accounts=dcount(accountId) by bin(_time, 1h), event, reason
```

For one account, filter on its hashed `accountId`, sort by `_time asc`, and inspect
all refresh, token-endpoint, verification, and restoration events. For orphan
starts, compare distinct started `exchangeId`s with succeeded/failed/superseded
IDs after the 60-second lease horizon, then corroborate with DB state, runtime
termination logs, and delivery warnings. Correlation must span requests and sites.
Investigate any second dispatch for a generation already marked
reconnect-required: target **zero**. A retry of the same generation must respect
its floor (two minutes after an unknown outcome, fifteen after
non-dispatch/configuration failure).

Read-only DB summary (does not select credentials or identifiers):

```sql
SELECT tesla_refresh_state, auth_status, is_active, count(*) AS accounts,
       min(tesla_refresh_started_at) AS oldest_attempt
FROM "User"
GROUP BY tesla_refresh_state, auth_status, is_active;

SELECT count(*) AS expired_unresolved
FROM "User"
WHERE tesla_refresh_state = 'in_flight'
  AND refresh_lock_expires <= extract(epoch FROM now()) * 1000;
```

Measure stale-data duration using the actual energy/SOC source timestamp, not
request receipt time. TRMNL freshness/timing headers remain available and include
`X-Tesla-Connection`; no inline Tesla duration should remain. Inspect multiple
linked sites and screen sizes. Poll volume is not the number of affected people.

## Safe cutover and rollback

1. Record baseline unique affected accounts, refresh outcomes, reconnect rate,
   save failures, source age, and app-session rejection reasons. Verify telemetry
   delivery before using a decline in errors as evidence of success.
2. Apply the generated additive migration using the normal reviewed DB process.
   Do not run it as an incidental part of a deploy.
3. Prepare the compatible release with `TESLA_REFRESH_PAUSED=1`. The pause blocks
   new coordinated refreshes only; it does not stop old releases, existing work,
   or OAuth. All active readers/writers must understand the new state.
4. Quiesce old traffic and scheduled/manual callers before enabling new writers.
   A Vercel alias switch alone is insufficient: existing invocations/after work,
   immutable deployment URLs, old cron routes, and external callers can survive.
   Restrict old deployment access using the platform's normal controls; stop old
   schedules; verify the actual deployed maximum duration and wait for all old
   invocations to drain. Confirm with deployment-specific logs, not a fixed guess.
5. Resolve the overlap window explicitly. Old code can consume a grant without
   writing the new marker. If any old worker could have run after migration, do
   not treat a default `ready` row as proof of safety. Keep refresh paused and
   OAuth quiescent while draining. A grant an old worker consumed fails with
   `invalid_grant` on retry and becomes reconnect-required.
6. Verify schema and every caller's release, then enable coordinated refresh.
   Exercise a normal rotation, reconnect, stored-data read, and suspension using
   designated test accounts. Installation links must survive reconnect.
7. Observe at least 48 hours and multiple rotation cycles. Compare the baseline
   metrics above, grouped by deployment and unique account. Investigate unknown
   outcomes, orphan claims, save failures, and rising source age. Zero logged 401s
   alone is not success. Set monitor thresholds from observed baseline; monitor
   provisioning and notification destinations require separate authorization.

Rollback keeps the additive schema and replay protection. Pause new refreshes
and retain stored-data serving while correcting the release. Never restore an
old binary that ignores in-flight markers. Do not clear attempts or decrement
generation as a recovery procedure. Only fresh OAuth credentials restore a
reconnect-required connection.

## Local acceptance evidence

The PostgreSQL suite applies the actual generated migration in a disposable
cluster. It covers two workers, lost response at the real refresh fetch boundary,
process death/lease expiry, failed outcome writes, lost save acknowledgement,
concurrent OAuth, stale completion, retry floors, session eligibility/version,
site linkage, suspension, and subsequent rotation after reconnect. Route tests
cover TRMNL installation authorization and DB-only rendering; native tests cover
session/cache preservation and genuine authorization rejection.

Commands: `npm test -- --run`, `npm run lint`, `npm run build` in `cmd/next-app`;
`npm run test:compact -- src/lib/tesla-account-refresh.postgres.test.ts` with the
documented disposable PostgreSQL setup; native tests only through
`cmd/ios-app/run-tests.sh`, plus repository strict SwiftLint. No production
credentials are needed. Local build/test limitations belong in the delivery report.

Tesla references: [third-party tokens](https://developer.tesla.com/docs/fleet-api/authentication/third-party-tokens),
[conventions](https://developer.tesla.com/docs/fleet-api/getting-started/conventions),
[FAQ](https://developer.tesla.com/docs/fleet-api/support/faq).
