# Postmortem: Supabase DB egress 10× spike

- **Date of writeup:** 2026-07-19
- **Detected:** Mid-July 2026, via a Supabase notice that DB egress had exceeded the free-tier limit
- **Window of regression:** ~2026-06-15 → 2026-07-15 (egress climbed ~10× month over month)
- **Fix:** PR #108 (`fix(db): cut Supabase egress on hot site-query and TRMNL markup paths`), merged 2026-07-18
- **Status:** Resolved; root cause confirmed at the DB layer via `pg_stat_statements`

## Summary

Database egress rose roughly 10× in a month while the active-user count grew only
~40%. The growth was almost entirely **bytes per request**, not request volume: a
single fetch of a site's data was transferring on the order of 10× the bytes it
needed, and that fetch sat on the most frequent query path in the system — TRMNL
device polls, which run about every 15 minutes per installed device (~96/day
each), around the clock.

Because the cost was per-request rather than per-user, modest user growth produced
a wildly disproportionate egress increase.

## Root cause

One fetch path multiplied wide/blob columns across a one-to-many join, on a hot,
cache-bypassed path. Three independently reasonable decisions combined into the
regression:

1. **Blob columns selected through a join fan-out.**
   `SiteRepo.loadSitesFromDB` fetched the site *and* its full tariff tree in a
   single flat join: `Site × Tariff × TariffSeason × TariffSchedule`. Postgres
   repeats every site-level column on every row of that join, so a tariff with
   (e.g.) 2 seasons × 6 schedules returned the site's columns **~12 times per
   fetch**. This pattern predated the incident and was cheap — as long as the
   site columns were narrow scalars.

2. **PR #81 (2026-07-01) widened those columns without anyone noticing the multiplier.**
   It added `live_status_cache` (a Tesla live-status JSON blob, rewritten every
   ~14 min) to the default site column set, and forced `includeJson: true` on the
   TRMNL markup path — pulling the full `EnergySiteInfo` blob (tens to hundreds
   of KB) when the route only needed the currency symbol. Each of the ~12
   duplicated join rows now carried hundreds of KB of blob plus the Tesla tokens.

3. **The cache that used to absorb the polls stopped applying.**
   The markup route requests `includeTokens: true` to read a fresh `auth_status`,
   and the cache layer deliberately bypasses both the in-memory and DB-backed
   site caches for token requests. So the 15-minute site cache that had made
   repeat polls nearly free no longer covered the hottest path. PR #95
   (2026-07-03) compounded this: `claimLiveRefresh` and `updateLiveStatusCache`
   both invalidate the cache and run every ~14–16 min per site, purging entries
   about as fast as they filled — so even *other* paths reverted to DB hits.

A smaller, fourth leak on the same route: with load-timing enabled, the markup
handler re-ran the entire site + tariff + aggregate + raw-row fetch a second time
in the same request via `getUsageByTOU`.

Net effect: a poll that used to be a cache hit became ~1 MB+ of DB egress, ~96
times a day per device.

## The fix (PR #108)

- **Split `SiteRepo.loadSitesFromDB` into two queries** — one row per site for the
  scalar/blob columns, and a separate skinny query for the tariff tree. Wide
  values now transfer once per site instead of once per schedule row.
- **Stopped shipping `Site.json` on the markup path.** `findByUuidWithSite` no
  longer forces `includeJson`; the route only needed the currency code, now
  extracted in SQL by `SiteRepo.getSiteCurrencyCode` without transferring the
  blob. (Side benefit: preview mode, which never had the blob, previously fell
  back to USD; it now shows the correct currency.)
- **Removed the markup double-fetch.** Load-timing usage is now computed in memory
  from the aggregates and raw rows already fetched in-request, via the extracted
  `EnergyRepo.aggregateUsageByTOU` / `buildTariffLookupMaps` statics, instead of
  re-running the queries through `getUsageByTOU`.

## Confirmation (pg_stat_statements, ~24h after deploy)

`pg_stat_statements` was reset immediately after the deploy and sampled ~24 hours
later. The confirming signal is the site query dropping to **1.0 rows per call**:

| rows/call | calls | query |
|-----------|-------|-------|
| **1.0** | 1557 | `SELECT s.id, s.user_id, ... FROM "Site" ...` (non-token path) |
| **1.0** | 1553 | `SELECT s.id, s.user_id, ... FROM "Site" ...` (token path, `User` join) |
| **1.0** | 1501 | `SELECT json -> $2 ->> $3 AS currency FROM "Site" WHERE id = $1` |
| 7.6 | 3110 | `SELECT t.id AS tariff_id ... FROM "Tariff" t ...` (split-out tariff tree) |

Before the fix, the combined site+tariff join returned ~schedule-count rows per
call, each carrying the `json` blob, tokens, and `live_status_cache`. After: the
blob rides only the 1.0-rows/call site query, the currency comes back as a single
extracted scalar, and the tariff tree is a separate skinny query. The old
high-fan-out statement no longer appears (a new query text = a new pg_stat entry,
which is why the reset gave a clean before/after).

### What leads the board now (all legitimate data movement)

- **Egress leader — `getRawEnergyData`:** 196,441 rows, 126 rows/call. Pulls
  today's raw 5-minute samples; the markup route needs them both to sum today's
  totals and to build the energy chart. Inherent to the product, but now the
  single biggest byte source. Reducible only by a behavior-touching change
  (sum in SQL when the chart component is disabled).
- **Compute leader — `getCycleAggregates`:** 177,257 ms total, ~115 ms/call. It
  aggregates server-side so egress is modest (36 rows/call), but it re-scans a
  full billing cycle of `EnergyData` (~8.5k raw 5-min rows/site) on every markup
  poll. A latency/compute-cost issue, not an egress one. The `(site_id,
  timestamp)` composite index that would normally address this **already exists**
  (`idx_energy_site_ts`), so the remaining lever is a pre-aggregated daily rollup
  rather than an index. Tracked in `TODO.md`.
- **Latent risk — `getExistingTimestamps`:** 1,089 rows/call, but only 18 calls
  in the window, so near-zero impact today. Exactly the scaling hazard already
  noted in `TODO.md`: each `/api/sync` step drags ~1,100 single-column rows to
  plan an import. Low egress now (one narrow column), but a per-day-aggregation
  candidate before sync volume rises.

## Why it slipped through

- **Each PR was locally reasonable.** Adding a cache column, reading fresh auth
  status, caching live status — all individually defensible. The cost lived in
  the *interaction* (wide column × join fan-out × cache bypass), which no single
  diff reveals.
- **High churn masked a gradual regression.** 28 PRs landed in 12 days
  (2026-07-01 → 2026-07-12) after three quiet weeks.
- **No egress signal existed.** We had per-query row-count logs but nothing
  watching bytes or cost, so a 10× drift ran for a month before Supabase's
  free-tier notice surfaced it.

## Action items / prevention

1. **Never select wide/blob columns through a one-to-many join.** Standing rule:
   if a `SELECT` joins a child table, it must not also select a JSONB or token
   column — fetch site scalars/blobs one-row-per-site and join children
   separately. Good review-checklist item.
2. **Extract, don't ship, when you need one field from a blob.** The currency fix
   (`json -> ... ->> 'currency'` in SQL) is the pattern: pull the scalar in the
   query rather than transferring the whole document to read one key.
3. **Treat cache bypass as a load-bearing decision.** `includeTokens` silently
   disabling the poll absorber deserves a comment *and* a metric. A hot path that
   can't use the cache should be a conscious, measured choice.
4. **Put a number on egress.** A weekly `pg_stat_statements` check ordered by
   `rows`, and/or a Supabase egress alert at ~50% of tier, would have caught this
   in days instead of a month. Highest-leverage change here.
5. **Watch blobs that grow forever.** Append-only tariff versions and the
   unbounded `getExistingTimestamps` scan are latent versions of the same
   "bytes creep up quietly" problem — both tracked in `TODO.md`.

## Related

- PR #81 — introduced `includeJson` on the markup path and `live_status_cache` in the default columns
- PR #95 — added `claimLiveRefresh` / `updateLiveStatusCache` cache invalidation
- PR #108 — the fix
- `TODO.md` — remaining egress/compute reduction candidates
