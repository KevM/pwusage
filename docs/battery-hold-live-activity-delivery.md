# Battery hold Live Activity delivery (plan Task 5)

`/api/cron/battery-hold-activity-delivery` sends each registered Live Activity
the latest state of its battery hold through the Apple Push Notification service
(APNs). It runs as its own pg_cron + pg_net trigger, separate from the 15-minute
battery monitor (`restore-reserve`), so a slow or failing Apple endpoint can never
spend the monitor's 60-second budget.

Code: `cmd/next-app/src/lib/battery-hold-apns.ts` (APNs client and payload),
`battery-hold-activity-delivery-service.ts` (one run), and the claim/acknowledge
methods in `battery-hold-activity-repo.ts`.

## What a run does

1. **No credentials → nothing.** Without `APNS_KEY_ID`, `APNS_TEAM_ID` and
   `APNS_PRIVATE_KEY` the route returns `status: "unconfigured"` before touching
   the database or Apple.
2. `reconcileBatteryHoldActivities()` (2 s, never throws) copies hold state into
   each registration's desired snapshot and expires/prunes old rows.
3. One claim statement takes up to 50 due rows (`FOR UPDATE SKIP LOCKED`, a
   120-second lease), terminal snapshots first. It re-gates `apns_environment`
   with `allowedApnsEnvironments()` and rechecks current access
   (`User.is_active`, site owner or admin). Ineligible rows are skipped and left
   for expiry. **No claimed rows → no Apple connection** (`status: "idle"`).
4. Each claimed version is sent over one HTTP/2 session per APNs environment,
   8 requests at a time, with a 4-second deadline per request. No new request
   starts after 15 seconds; unattempted rows are released without an attempt
   counted. Every attempt is awaited and the sessions are closed before the
   response. There is no background loop.
5. Owner-conditioned bookkeeping, with a 2 s budget per write:

| APNs result | Row effect |
| --- | --- |
| 200 (accepted) | `delivered_version` advances to the version sent; `current`, or `ended` with the token cleared for a terminal snapshot. A newer desired version stays `pending`. |
| `Unregistered`, `ExpiredToken`, `BadDeviceToken`, `DeviceTokenNotForTopic`, any 410 | `disabled`, token cleared, unless the app rotated the token mid-send (then only the claim is released). |
| 429 `TooManyRequests`, 5xx, timeout, transport | Backoff: 1 min doubling to 30 min; 5xx waits at least 15 min (Apple's guidance). |
| Provider-token or topic errors (`InvalidProviderToken`, `ExpiredProviderToken`, `Forbidden`, `TopicDisallowed`, …) | Surfaced: route returns **503** with `credentialFailure`, `console.error` names the reason, the rest of that environment is released for this run, and the attempted row backs off (5 min doubling). |
| Other 4xx (`PayloadTooLarge`, `BadPriority`, …) and unbuildable snapshots | Logged as errors and retried after 30 min; expiry eventually retires the row. |

A completion from a worker whose claim lapsed changes nothing. A stale or
duplicate completion releases the claim but leaves backoff alone. A run that
dies mid-way leaves its rows `pending`; the lease lapses and the next run takes them.

**Accepted is not delivered.** A 200 means APNs accepted the request. The device
may be offline, the activity dismissed, or the token about to be reported
`Unregistered`. The row state `current` and the summary's `accepted` count mean
exactly that. Delivery to a phone is verified on devices in Task 6.

**A new terminal version skips backoff.** `syncDesired` clears `next_attempt_at`
when the snapshot becomes terminal, and a failure racing such a version doesn't
reimpose it, so the end is sent on the next run. Non-terminal monitoring
updates keep the backoff; they arrive every 15 minutes and would otherwise defeat it.

**Logs and storage.** Tokens, signing material and APNs response bodies are
never logged or stored. `last_error` holds only Apple's reason string
(`[A-Za-z]{1,64}`), `http_<status>`, or a local tag (`timeout`, `transport`, …).
Database errors are logged with `activityErrorTag`.

## Payload contract (content-state schema 1)

`event: "update"` (priority 5, outside the hourly ActivityKit budget) while the
hold is active; `event: "end"` (priority 10) with the final state once it is
restored or cancelled. The APNs `timestamp` is the snapshot's data time
(`max(created_at, monitoring.checked_at, restored_at)`), not the send time, so an
older version delivered late can't replace a newer one. Updates carry
`stale-date = next_check_at + 10 min`. `apns-expiration` is the registration's expiry.

`content-state` keys are camelCase and dates are **seconds since
2001-01-01T00:00:00Z**, because ActivityKit decodes with Swift's default
`JSONDecoder` (`Date` = `timeIntervalSinceReferenceDate`):

```json
{ "schema": 1, "holdId": 7, "status": "active", "mode": "auto", "phase": "load_running",
  "originalReserve": 20, "targetReserve": 100, "estimatedLoadW": 7200,
  "startedAt": 813751200, "safetyExpiresAt": 813780000, "checkedAt": 813752102,
  "nextCheckAt": 813753000, "endedAt": null, "restoreReason": null, "cancelledObservedReserve": null }
```

`phase` is passed through from the monitor (`restoring` included). Task 6 owns
how "active with a restore in progress" is presented.

## APNs key setup

1. In the [Apple Developer portal](https://developer.apple.com/account/resources/authkeys/list)
   (team `6HQGHHRK87`), go to **Certificates, Identifiers & Profiles → Keys → +**.
2. Name it (for example, "PWUsage APNs") and enable **Apple Push Notifications
   service (APNs)**. Under Configure, choose **Sandbox & Production** so one key
   serves TestFlight/App Store builds and Xcode development builds. Continue and
   register.
3. **Download `AuthKey_<KEYID>.p8`.** Apple lets you download it only once. Store
   it in your password manager; don't commit it.
4. Note the 10-character **Key ID** shown with the key, and the Team ID `6HQGHHRK87`.
5. Confirm the App ID `fm.rodeo.pwusage` has the **Push Notifications**
   capability. Task 6 adds the entitlement and ActivityKit to the app; the
   server needs nothing more.

## Vercel environment variables

| Variable | Value |
| --- | --- |
| `APNS_KEY_ID` | The 10-character Key ID |
| `APNS_TEAM_ID` | `6HQGHHRK87` |
| `APNS_PRIVATE_KEY` | The full `.p8` PEM, including the BEGIN/END lines. Real newlines or `\n` escapes both work. |
| `APNS_BUNDLE_ID` | Optional; defaults to `fm.rodeo.pwusage`. The topic is `<bundle id>.push-type.liveactivity`. |

From `cmd/next-app` (Vercel stores Production and Preview values as sensitive by default):

```bash
vercel env add APNS_KEY_ID production --value "<KEYID>" --yes
```

```bash
vercel env add APNS_TEAM_ID production --value "6HQGHHRK87" --yes
```

```bash
vercel env add APNS_PRIVATE_KEY production --yes < ~/path/to/AuthKey_KEYID.p8
```

Repeat with `preview` instead of `production` to let beta send **sandbox**
pushes to Xcode builds. Beta can never send production pushes:
`allowedApnsEnvironments()` allows production only when
`VERCEL_ENV === 'production'`, both at registration and again at claim time,
and the dev database copy deletes every `BatteryHoldActivity` row
(`sanitize-dev-copy.sql`). Redeploy after changing variables. Without them,
the route stays a no-op.

## Schedule and rollout

Migration `20261015124607_battery_hold_activity_delivery_cron.sql` schedules
`battery-hold-activity-delivery-trigger` every 5 minutes at :02, :07, :12, …
(`2-59/5`). Each run lands about 2 minutes after a 15-minute monitor run
(:00/:15/:30/:45, up to about 60 s), so monitor updates and automatic ends go out
about 2 minutes after the check. A manual stop waits at most 5 minutes; a stop
made in the iOS app can end the activity locally (Task 6). Every 2.5 minutes
can't be written as one cron expression. If manual-stop latency matters, send
from the stop path rather than running the cron more often.

Egress: an idle run (keys set, nothing pending) measured 342 bytes of query
results on local Postgres. Each run also reconnects through the pooler, because
the app pool closes idle connections after 30 s; TLS plus auth is estimated at
about 5 KB. That is roughly 40–60 MB a month at this cadence, versus 200–300 MB
at once a minute. Each pending registration adds about 0.5 KB.

It derives
the URL from the existing `battery_restore_cron_target_url` Vault secret, so
prod calls pwusage and the dev copy calls pwusagebeta. If that secret ever stops
ending in `/api/cron/restore-reserve`, the job calls nothing. The route allows 30 s;
pg_net allows 35 s.

**CI runs migrations on merge to main, so merging turns on this production
schedule.** Without the APNs variables a run is one authorized HTTP request
that returns at once, with no database or Apple work. They are now set in
Production and Preview, so each run reconciles and claims; Apple is contacted
only once activities are registered (Task 6). Merging needs the
owner's explicit approval (the plan does not authorize production schedules).
To pause it later: `SELECT cron.unschedule('battery-hold-activity-delivery-trigger');`.

Verified on the Supabase image (`public.ecr.aws/supabase/postgres:17.11.0.004`):
the activity migrations and this schedule apply twice cleanly. One run queues
`GET https://<host>/api/cron/battery-hold-activity-delivery` with the cron bearer
token and a 35000 ms timeout. An unexpected target URL queues nothing.

## Tests

- `npx vitest --run src/lib/battery-hold-apns.test.ts`: JWT (ES256, kid/iss/iat,
  30-minute reuse), payload compatibility, headers, endpoints, response
  classification, deadlines and reconnects, against a local HTTP/2 mock.
- `src/lib/battery-hold-activity-delivery-service.test.ts` and the route test:
  no-op paths, backoff, credential surfacing, bounded parallelism and budget,
  and no tokens or keys in logs.
- `npm run test:hold:postgres` (local disposable Postgres): claim conditions,
  environment gate, access recheck, overlap, owner-conditioned advance-only
  acknowledgement, mid-delivery desired state, terminal backoff bypass, invalid-
  and rotated-token handling, lease recovery. End to end against a mock APNs:
  update then end, accepted vs delivered, transient and authentication failures,
  overlapping runs, and ten holds × three phones against failing and hung Apple
  endpoints. A concurrent monitor run finishes normally, in its usual time.
