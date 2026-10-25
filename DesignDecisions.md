# Design Decisions — Why Things Are The Way They Are

Read this before "simplifying" anything it describes. Each item below looks like
it could be shortened, generalized, or deleted — and each one is load-bearing.
`CLAUDE.md` and `Agents.md` tell you *how* to work in this repo; this doc records
*why* a handful of non-obvious decisions were made, so a well-meaning refactor
doesn't quietly reintroduce a bug that was already paid for.

The rationale here originally lived only in plan docs (`docs/superpowers/plans/`,
`cmd/next-app/docs/plans/`) and merged PR descriptions. When you change one of
these areas, update the matching section here too.

---

## 1. Cross-instance claim pattern (billable Tesla calls)

**Decision:** Before making a billable Tesla Fleet API call from a path that can
run concurrently, "claim" the work with an atomic conditional `UPDATE` on a
`Site` column and treat `rowCount` as the verdict. Two live examples:
`acquireImportLock` (used by `refreshTodayData`) and `claimLiveRefresh` /
`releaseLiveRefreshClaim` (used by `refreshLiveStatus`), all in
`src/lib/site-repo.ts` + `src/lib/today-refresh.ts`.

**Why it exists:** The app runs on Vercel serverless. In-process throttles
(`globalThis.__todayRefreshState`, in-memory maps) do **not** span instances, so
two concurrent requests — e.g. a TRMNL markup poll and a web live-page load — hit
a cold/expired cache and each make the same billable Tesla call. The atomic
conditional `UPDATE ... WHERE last_live_refresh_at IS NULL OR <= now - interval`
lets exactly one instance win; losers return `cached`/`throttled`, which is what
they wanted anyway.

**Guardrails — do not "simplify" by:**
- Removing the DB claim and trusting the in-process throttle. That is the exact
  bug this replaced; in-process state is per-instance.
- Reusing the import lock for live-status refreshes. They are deliberately
  separate columns/claims — sharing one would make a live-status refresh block a
  data import (and vice versa).
- Dropping the failure-path release (`releaseLiveRefreshClaim`). It restores the
  pre-claim value via compare-and-set so a failed fetch doesn't lock out retries
  for a full interval, *and* doesn't clobber a fresher write from a `force`
  caller. Tests pin this ("does not report in-flight or lock out cold cache
  retries after a failed fetch").
- Making `force` go through the claim. `force: true` intentionally bypasses it —
  the caller explicitly wants a fresh fetch.

**Known, accepted edge:** the claim advances `last_live_refresh_at` a few seconds
before the fetch completes, so the SoC-age/staleness display can look slightly
fresher than reality for a moment. Judged acceptable versus duplicate billable
calls. (See `docs/superpowers/plans/2026-07-03-live-status-claim-and-token-guard.md`.)

---

## 2. Append-only tariff versioning

**Decision:** `Tariff` rows are append-only. Each save inserts a new version
(`version` + `is_current` on the `Tariff` root, deduped by `content_hash`) and
flips the previous current row to `is_current = false`. There is no
delete-and-reinsert. `EnergyData`'s UNIQUE key is `(timestamp, site_id)` —
**not** `(timestamp, site_id, tariff_id)`. (PR #63; `src/lib/tariff-repo.ts`,
`src/lib/energy-repo.ts`.)

> The authoritative uniqueness key is `(timestamp, site_id)` — see
> `ON CONFLICT(timestamp, site_id)` in `energy-repo.ts`. The `tariff_id`
> *column* is retained for billing aggregation but is not part of the key.

**Why it exists:** The old replace-tariffs-for-site path deleted and reinserted
`Tariff` rows, which caused two real problems:
1. An importer FK race on the changing tariff IDs (which is why the now-deleted
   `remapTariffIds` existed).
2. A latent `ON DELETE CASCADE` that would wipe historical `EnergyData` when a
   tariff row was deleted.
Append-only makes tariff IDs stable forever, so history never dangles. Validated
against the production corpus (PG 17.6): 0 constraint conflicts.

**Guardrails — do not "simplify" by:**
- Reintroducing delete/replace of `Tariff` rows, or adding `ON DELETE CASCADE`
  from `EnergyData` → `Tariff`. History must survive tariff edits.
- Adding an `is_current` filter to the billing name/rate resolution. Historical
  `EnergyData` rows point at *old* tariff versions; billing must resolve names
  and TOU rates across **all** versions or old rows render as "Unknown". This is
  deliberate and commented in `tariff-repo.ts` ("No is_current filter on
  purpose") and `tou-aggregation.ts`. Only the live `Schedule` / `site.tariffs`
  load is current-only.
- Removing `content_hash`. It's the idempotency key — re-saving identical tariff
  content is a no-op instead of a spurious new version. The insert is serialized
  by locking the parent `Site` row to keep the check race-free.

---

## 3. Loose-pending TRMNL installation flow

**Decision:** `POST /api/trmnl/setup` may create a "loose pending"
`TrmnlInstallation` row with **NULL `uuid` and NULL `plugin_setting_id`** — just
`site_id` + the Trmnl access token. The next Trmnl webhook to arrive within a
15-minute window claims it (`getLatestLoosePendingInstallation` →
`claimPendingInstallationById`). See `src/app/api/trmnl/setup/route.ts` and
`src/app/api/trmnl/webhook/route.ts`.

**Why it exists:** At setup time we try three ways to learn the device UUID (OAuth
response fields → JWT decode → Trmnl `/api/me`). All three can fail. When they
do, we still want the install to succeed, so we persist what we have and let the
webhook — which *does* carry `user.uuid` and `plugin_setting_id` — finish the
link. The matching is intentionally loose (most-recent, time-boxed) because the
setup call and the webhook can't always be correlated by ID.

**Why it's safe here:** this is a single-user / sequential-install personal app,
so "the most recent loose pending record within 15 minutes is the one this
webhook belongs to" holds. The 15-minute window and most-recent heuristic bound
the mis-claim risk.

**Guardrails — do not "simplify" by:**
- Deleting the loose-pending fallback because the UUID "should always be
  available." It isn't always; removing it makes installs silently fail when
  UUID resolution fails.
- Widening or removing the 15-minute freshness window, or matching without it —
  that's the safety bound against claiming an unrelated install.
- Assuming this generalizes to multi-tenant. If this app ever becomes
  multi-user, the most-recent heuristic must be replaced with a real correlation
  token; flag it, don't quietly keep it.

The webhook path also still requires the opaque token to match the stored
`access_token` (timing-safe) before claiming — the loose match narrows *which*
row, it does not replace authentication.

---

## 4. Battery provenance = relative flow accounting (no SOC, no genesis seed)

**Decision:** The battery cost-basis "tank" is **relative flow accounting**, not
an absolute state-of-charge gauge. It adds observed charge (valued at the hour's
metered rate), removes observed discharge proportionally, tracks the solar/grid
cost blend, and clamps to non-negative. It never reads absolute battery fullness
(`battery_soc`). One-time genesis seeding (`computeGenesisSeed`) was **removed**
in Phase C2; on-read arbitrage starts from an empty tank.

**Why it exists / why genesis was dropped:** Absolute `battery_soc` fed *only*
the genesis anchor (cost basis for energy already in the battery before the data
window). But `battery_soc` is populated only from Tesla SOE history, and the
`index-history` backfill runs `new Importer(client, { fetchSoe: false })` to
halve Tesla calls and avoid 429s — so every backfilled row has
`battery_soc = null`. Genesis therefore never anchored for the bulk of history;
it was already a no-op. Dropping it removed dead complexity, not real behavior.

**Cost of dropping it:** the only loss is un-attributable early discharges — at
most ≈1 battery-capacity of discharge at the very start of history. It's bounded
and non-accumulating (self-corrects after one charge/discharge cycle).

**Guardrails — do not "simplify" or "improve" by:**
- Re-adding SOC-based cost basis / genesis seeding to "make provenance more
  accurate." It looks like a gap; it's a deliberate no-op removal. If true
  startup attribution is ever genuinely wanted, raw 5-minute `EnergyData` is kept
  forever, so SOE for just the genesis window can be re-fetched — do that, don't
  resurrect the old anchor.
- Feeding `battery_soc` into the tank as if it were reliable. It's frequently
  NULL on backfilled rows.

(See the Phase C2 plan's "Decision: no genesis seeding" section.)

---

## 5. JWKS stale-key serving: a bounded availability trade

**Decision:** The jwks-rsa client is configured with `cacheMaxAge: 10 min` and
`cacheMaxAgeFallback: 60 min`, plus an `onStaleCacheFallback` logger. OIDC
discovery is cached per issuer for 1 hour (`getTeslaJwksUri`), and a failed
discovery **reuses the previously discovered URI** rather than falling back to a
hardcoded one. See `cmd/next-app/src/lib/tesla-auth-service.ts`.

**What it actually costs:** jwks-rsa measures the stale window as
`Date.now() - fetchedAt < cacheMaxAge + cacheMaxAgeFallback`
(`node_modules/jwks-rsa/src/wrappers/cache.js:32`). So the exposure is the
**sum, not the fallback alone: 70 minutes** from the last *successful* fetch, not
60. If Tesla rotates a key and the old one is compromised, that old key stays
trusted for up to 70 minutes. `cacheMaxAge` is therefore not merely a freshness
target — it adds to the window. Do not "tune" `cacheMaxAge` without re-reading
this paragraph.

**Why it exists:** when Tesla's JWKS endpoint is unreachable *and* the normal
cache window has expired, the default behavior is to fail. That means a single
Tesla-side JWKS outage fails **every login** for up to the next successful
fetch. This trades a bounded, observable security exposure for login
availability. The window is sized to *our tolerance for stale keys* — it does not
grow if Tesla's JWKS is down longer, it simply stops helping.

**Observability:** `onStaleCacheFallback` logs on every single degraded serve, so
a prolonged outage cannot pass silently. It does **not** fire on a kid miss, and it
does not fire on jwks-rsa's own internal rate limiter rejecting the request
(`wrappers/rateLimit.js`) — that path never reaches the cache at all. What it does
*not* distinguish is "unreachable" from "reachable but unhappy": the library sets
`isEndpointUnavailable = true` on **every** `getKeys()` failure (`JwksClient.js:49`)
and rejects any non-2xx (`wrappers/request.js:36-38`), so an upstream **429**, a
WAF **403** or an HTML error page all log as "endpoint is unavailable" and each
serves a stale key for up to the full 70 minutes. No security consequence — a stale
key is still a real, verified key, and the window is unchanged — but the
diagnostic is misleading: an operator debugging a 429 reads "unavailable" and goes
looking for a network problem that is not there. Read the `endpointError` field
in the log before concluding the endpoint is down.

**Guardrails — do not "simplify" by:**
- Deleting `cacheMaxAgeFallback` because "the cache already covers it." Without
  it, jwks-rsa skips building the stale-key store entirely
  (`wrappers/cache.js:20`), so the availability guarantee silently evaporates
  while the code still looks configured.
- Widening either window without treating it as a security decision. The sum is
  the exposure; see above.
- Dropping the `if (cached)` reuse branch in `getTeslaJwksUri` in favor of
  falling straight through to `getFallbackJwksUri`. For the `/nts` issuer the
  fallback URI is the wrong key set, so a transient discovery failure would
  downgrade an `/nts` token to the base `/v3` key set and manufacture a
  spurious kid miss. This is the exact bug fixed in Task 2.
- Adding manual validation of Tesla's well-known keys or an eager key-set check.
  This has been attempted a few times, and each attempt hit Tesla-published keys
  and issued-token `kid`s being out of sync. The current refetch-on-miss plus
  bounded stale-cache behavior is the stable path; revisit only with a reproduced
  live mismatch (see `TODO.md`).
- Downgrading `onStaleCacheFallback` to `debug`. It is the only signal that the
  availability trade is actively being paid.

### jwks-rsa internals we depend on (jwks-rsa 4.1.0)

Every item below was verified against `node_modules/jwks-rsa/src/`. Each has
already cost a review cycle; a silent change to any of them is a security
regression, not a refactor.

| Behavior we rely on | Location | What breaks if it changes |
| --- | --- | --- |
| Options named `cacheMaxAgeFallback` / `onStaleCacheFallback` | `wrappers/cache.js:6` | **Silent.** The stale store is only built when `cacheMaxAgeFallback` is truthy, so a rename disables the guarantee with no error. |
| Stale window is `cacheMaxAge + cacheMaxAgeFallback`, not the fallback alone | `wrappers/cache.js:32` | Undocumented 70-minute exposure becomes something else. |
| `onStaleCacheFallback` is called as `(err, kid, staleKey)` | `wrappers/cache.js:35` | Our logger reads `err.message` and `kid`. |
| The fallback triggers **only** when `err.isEndpointUnavailable` | `wrappers/cache.js:30`, set at `JwksClient.js:49` | A kid miss or rate limit could start serving stale keys, and the log would no longer mean "endpoint outage." |
| `SigningKeyNotFoundError` is the only "kid absent" error; transport failures never masquerade as it | `JwksClient.js` | **Security-critical.** See below. |
| `jwksRequestsPerMinute` defaults to 10 | `wrappers/rateLimit.js:6` | We pin 10 explicitly, so behavior is stable. |
| `timeout` defaults to 30000ms | `JwksClient.js:12` | We pin 5000ms. |

**Cooperation with the Task 3 invariant:** `handleTeslaCallback` treats
`KidNotFoundError` as "signature unverifiable" and takes a degraded path that
**bypasses signature verification**. Only a *confirmed* missing key maps to it;
every other error propagates unchanged. Serving a stale key is what keeps a
jwks-rsa outage from manufacturing a spurious `KidNotFoundError` and quietly
opening that bypass — so the availability trade also happens to be a safety
trade. It is not a substitute for the invariant: if jwks-rsa ever started
reporting an unreachable endpoint as `SigningKeyNotFoundError`, this section's
reasoning inverts and the bypass would open.

**If jwks-rsa is upgraded:** re-verify the table above before trusting it. In
particular, a rename of the two cache options fails *silently* — the code
continues to pass tests that only assert the options were passed.

### Verification timeout ownership

**Decision:** no timeout wraps ID token verification as a whole. Each network leg
owns its own bound — `DISCOVERY_TIMEOUT_MS` (5s) on the discovery fetch,
`JWKS_REQUEST_TIMEOUT_MS` (5s) on the jwks client. `handleTeslaCallback` awaits
`verifyTeslaIdToken` directly.

**Why it exists:** 2ca62ef raised the callback route's `maxDuration` to 60s and
raced `verifyTeslaIdToken` against a 3s timer, which had two defects:

- **It mislabeled slow as invalid.** On expiry the race rejected with a plain
  `Error('Verification timeout')`, which is not a `KidNotFoundError`, so
  `handleTeslaCallback` failed closed with `invalid-id-token`. A slow network was
  indistinguishable from a bad token.
- **It leaked.** The `finally` cleared the timer but nothing cancelled the
  in-flight JWKS fetch, so the rejected race left a request running that later
  installed the module-level jwks client.

**Do not reintroduce an outer race by:**

- Asserting that "cached" means non-blocking. A warm *discovery* cache skips only
  the discovery fetch; a cold JWKS fetch can still take the full
  `JWKS_REQUEST_TIMEOUT_MS`. A claim that a warm cache "cannot hang" is true only
  of `getTeslaJwksUri` in isolation, not of the whole verification.
- Expecting the per-request timeouts to improve the login outcome on their own.
  A slow **JWKS** fetch still fails the login with `invalid-id-token`; only the
  cause recorded in the logs changed. The **discovery** path is what started
  succeeding, because a slow or failed discovery falls back to the cached or
  hardcoded issuer URI and the login proceeds (see the fallback note in
  `getTeslaJwksUri`).
- Writing a regression test that injects a `verifyIdToken` dep and expects it to
  be slow. An injected dep takes a separate, untimed branch in
  `handleTeslaCallback`, so such a test passes with or without the race. It must
  drive the real verifier and inject the delay at the fetch boundary.

### Terminal vs transient failures (`isTeslaAuthError` matches substrings)

**Decision:** a refresh failure is "terminal" only if the credential is actually
dead. `isTeslaAuthError` (`cmd/next-app/src/lib/tesla-client.ts:154`) is the
predicate, and it is **broader than it looks**: besides `instanceof TeslaAuthError`
it matches any `Error` whose **message contains** `Tesla API Error: 401`,
`Tesla API Error: 403`, `login_required`, `invalid_grant`, or `invalid
authentication`.

**Why it matters:** `TeslaTokenRepo.getLockedRefreshHandler` treats a terminal
error as proof the refresh token is revoked and, in one atomic write, sets
`auth_status = 'revoked'` and `is_active = false`. That is the correct response to
a real `login_required`. It is catastrophic for anything that merely *looks* like
one.

**Consequences for error construction — do not violate these:**

- A **malformed-but-200** upstream body must throw a plain `Error` whose message
  contains **neither** `login_required` **nor** `invalid_grant`.
  `parseRefreshedTokens` in `src/lib/tesla-auth.ts` does exactly that, and so does
  `calendarTimeSeries` in `src/lib/tesla-client.ts` (it logs the body instead). Echoing
  upstream text verbatim into the message would match the substring test and
  mass-de-authenticate every user during a transient upstream malformation - a
  credential incident with no credential cause.
- Do not throw `TeslaAuthError` for anything that is not an authentication
  rejection. A missing required-env variable (`requireEnv`) is deliberately a
  plain `Error`: a deployment misconfiguration should produce one alert and a
  released lock, not a wave of revoked users.
- Anything genuinely unclassifiable should land on the **non-terminal** side.
  `TeslaTokenEndpointError` (every token host 5xx'd) is a plain `Error` subclass
  and is non-terminal; `TeslaTokenRepo` releases the lock and `tesla-client.ts`
  falls through to the original 401.

**Guardrails — do not "simplify" by:**
- Replacing the substring checks with `instanceof` alone. This is not
  hypothetical. `isTeslaAuthError` has **11 non-test call sites across 6 files**
  (`site-live-data/route.ts` :235, `battery-hold-service.ts` :46/:76/:129/:140,
  `importer/index.ts` :320/:357, `site-service.ts` :160/:178,
  `tesla-token-repo.ts` :72, `user-repo.ts` :184 — counted, not estimated), and
  **none of the six imports `TeslaAuthError`** — they import only
  `isTeslaAuthError`, whose declared return type (`error is TeslaAuthError`) makes
  `instanceof`-only look entirely plausible on a read, with nothing at the call
  site to hint at a substring branch. It is nevertheless **load-bearing**:
  `tesla-token-repo.test.ts`
  rejects with a *plain* `Error('Tesla API Error: 401 Unauthorized invalid_grant')`
  and asserts the atomic `auth_status = 'revoked'` write fires. That test passes
  **only** via the substring branch. Narrowing the predicate silently stops
  users being revoked on a genuine 401. Treat the substring list as part of the
  contract, not as a shortcut.
- Interpolating an upstream response body into an error message on a path whose
  error is inspected by `isTeslaAuthError`. If a body must be quoted, check it
  against the substring list first.
- Deleting the `expect(...).not.toMatch(/login_required|invalid_grant/)`
  assertion in `tesla-auth.test.ts`. It looks redundant next to the
  `not.toBeInstanceOf(TeslaAuthError)` check; it is the only thing guarding the
  substring half of the predicate.

**Pinned by:** `throws a plain, non-terminal error when a 200 response omits the
tokens` in `cmd/next-app/src/lib/tesla-auth.test.ts` (its fixture carries
`error: 'invalid_grant'` precisely so an interpolating implementation fails), and
the `never posts "undefined" as the client secret when the secret env var is
unset` guard for the non-terminal missing-env path. The 400/401 decision table itself is
pinned by `raises TeslaAuthError on a 401 regardless of the response body` and
`does not raise TeslaAuthError on a 400 with a non-trigger body` — before those,
deleting the 401 branch, or widening the 400 branch to bare `status === 400`,
both left the suite green.

### Previously known violations (fixed 2026-10-25)

Two paths broke these rules. Both are fixed; the rules above are enforced again.

1. **`cmd/next-app/src/lib/tesla-auth.ts` — raw body interpolated into a
   non-terminal error.** The refresh fallthrough used to throw
   ``Error(`Failed to refresh token: ${status} ${body}`)``. A 403 body containing
   `login_required`, or a 400 body containing `invalid authentication`, was
   non-terminal to `refreshAccessToken` yet terminal to `isTeslaAuthError`, so
   `TeslaTokenRepo` performed the atomic revoke. It now parses the JSON `error`
   code, treats only 401 and 400 `invalid_grant` / `login_required` as terminal,
   and echoes only that recognized code — never the raw body.

2. **`cmd/next-app/src/lib/tesla-token-endpoint.ts` — transport details folded
   into the thrown message.** `describeError` used to include `err.message` and
   `err.cause.message` verbatim, so a proxy/TLS cause carrying a trigger
   substring made `TeslaTokenEndpointError` classify as terminal. Full details
   now go only to `console.warn`; the thrown summary is the fixed text
   `transport error`, which cannot match a classification substring.

**Pinned by:** the trigger-body table cases in `tesla-auth.test.ts`
(`403 login_required`, `400 invalid authentication`) and
`keeps transport error text out of the thrown message` in
`tesla-token-endpoint.test.ts`. The load-bearing substring list and its
`tesla-token-repo.test.ts` guard are unchanged.

---


`cmd/next-app/docs/plans/2026-05-21-architectural-review.md` is partly generic
boilerplate and contains claims that don't match the codebase. It carries a
supersession banner. **Verify any claim there against current code before acting
on it.**

## Login callback: persist credentials before product import

**Decision:** `TeslaAuthService.handleTeslaCallback` writes the rotated access and
refresh tokens *before* calling `getProducts()`. Product, site-import, and region
failures are returned as explicit `fleet-api-failed` results, never as `success`
with an empty site list.

**Why it matters:** the callback exchange can rotate the refresh token. Fetching
products first meant a transient Fleet failure could discard the new refresh
token, while the old success-shaped result set no web cookie and left the user
looking silently signed out. Admins are the deliberate exception: a product
failure does not block admin access, because recovering partner registration or
a region problem requires an admin session.

**421 has two meanings — do not collapse them.** Tesla also answers 421 with
`Account … must be registered in the current region <host>`, meaning the partner
app is not registered in that region. The named host is usually the current host,
so following it is a no-op. `parseTesla421` classifies the body; only
`out-of-region` answers switch hosts, and `TeslaRegionError` surfaces every other
421 without interpolating the raw body (which `isTeslaAuthError` substring
matching could otherwise misread as a terminal auth failure). The partner case
must be fixed by registering the app for that region, not by retrying the request.
A learned host is persisted for the token owner (or the site's user), so later
clients start from the correct region instead of rediscovering it with a 421.

The authorization-code exchange sends `audience` set to the documented Fleet
host; the refresh grant deliberately omits it. There is no audience environment
variable, so a bad or region-specific value cannot silently break either flow.

**Pinned by:** `tesla-auth-service.test.ts` persistence/product/import-failure
tests, `tesla-region.test.ts` `parseTesla421`, `tesla-client.test.ts`
`TeslaRegionError` cases, and the callback route's explicit `db-error` /
`fleet-api-failed` mappings.

## 6. Billing balances span seasonal rate changes

**Decision:** A bill's energy bucket is keyed by tariff name and TOU period name
for the entire requested billing window. Seasonal boundaries and append-only
versions with the same tariff name do not settle that energy bucket. Different
TOU periods and different tariff names remain separate.

**Why it exists:** Harrison's September–October cycle had 27.471 kWh of summer
On-Peak surplus and 18.243 kWh of winter On-Peak deficit. Pricing those seasonal
balances independently produced $4.55649 owed despite a 9.228 kWh surplus. The
same 4¢ sell rate in both seasons makes the cycle credit $0.36912.

**Rate attribution:** Keep measured energy and historical buy/sell rates in their
original aggregation buckets. Offset opposing bucket balances proportionally;
price only the residual importing or exporting energy at those historical
rates. If several contributing rate buckets remain, this gives their
energy-weighted rate and is independent of input ordering. All-import or
all-export periods retain their original seasonal prices. This is the app's
estimate policy, not a model of additional utility fees or taxes.

**Guardrails:** Both `EnergyRepo.aggregateUsageByTOU` (web/mobile) and
`aggregateUsage` (TRMNL) call `priceBillUsage`. Do not reintroduce separate
seasonal settlement or reprice the entire cycle using today's configured rate.
Keep historical lookup maps across all tariff versions. Presentation layers sum
already-netted costs; they must not price raw seasonal balances themselves.

---

## Battery hold monitor claims and deadlines

`BatteryHold` remains the only hold lifecycle. A processing owner and 120-second
lease serialize monitor/manual restoration for a specific active hold id; Site
import/live claims stay separate. Release and terminal transitions compare the
owner, and restoration re-reads the active hold before touching Tesla. A stale
monitor snapshot must never restore a replacement hold on the same site.

Persist `restore_attempted_at` and the existing `restore_reason` before sending a
restore command. A timeout is an uncertain outcome, even after an abort signal.
Keep that hold active, reconcile the observed reserve on subsequent checks, and
wait at least 15 minutes before a guarded resend when Tesla still reports the
target. An observed user reserve change still cancels automatic restoration.
Never clear uncertainty merely because the HTTP caller stopped waiting.
An explicit typed 401/403 command rejection is different: clear the attempt under
the current active owner so reauthentication permits an immediate retry. Keep
transport failures after token refresh distinct from the original 401; a retry
may have reached Tesla. Failed cleanup leaves the conservative marker intact.

The three-worker monitor uses per-hold clocks and checks deadlines before
history. Only recent valid history (latest sample within 20 minutes, excluding
future samples) can drive an early load-end restoration. Timer/Auto deadline
restoration and pending-command reconciliation do not depend on history.

Request-local I/O deadlines reach Fleet fetch/body reads, token endpoint failover,
refresh lock polling, rate-limit waits, and bounded database connections/queries.
Database timeout scopes use a separate small pool so shorter monitor waits do not
change ordinary queries. Guard connections arriving after cancellation before
issuing SQL. Failure telemetry and lease cleanup each have isolated budgets and
must never reject a worker or starve other sites. Token-refresh lock release and
atomic revocation also get an independent one-second cleanup scope, explicitly
without the aborted parent signal; if cleanup fails, lock expiry is the fallback.

See `docs/battery-hold-monitor-operations.md` for verified runtime/scheduler
configuration and the ten-site capacity measurements.
