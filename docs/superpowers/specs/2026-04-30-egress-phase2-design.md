# Egress Reduction Phase 2 — Structural Query Optimization

**Date:** 2026-04-30  
**Status:** Approved  
**Scope:** `src/lib/energy-repo.ts` + `src/lib/energy-repo.test.ts`

## Problem

`EnergyRepo.getSite()` makes 3–N sequential database queries per site on a cold cache:

1. `SELECT {columns} FROM "Site" WHERE id = $1`
2. `SELECT access_token, refresh_token, auth_status FROM "User" WHERE id = $1`
3. `SELECT * FROM "Tariff" WHERE site_id = $1`
4. For each tariff: `SELECT * FROM "TariffSeason" WHERE tariff_id = $1`
5. For each season: `SELECT * FROM "TariffSchedule" WHERE season_id = $1`

A site with 1 tariff, 2 seasons, 3 schedules each = 1 + 1 + 1 + 2 + 6 = 11 queries. Phase 1 (PR #44) introduced request-scoped and 15-minute cross-request caches, so cache hits are free — but the cold-cache path still issues this waterfall.

Expected savings: ~20–30% reduction in database egress for dashboard and admin requests.

## Solution

Replace the sequential queries with a single LEFT JOIN query. Add a public `getSites(siteIds[])` batch method. Callers are unchanged.

## Architecture

### Single JOIN query

```sql
SELECT
  s.id, s.user_id, s.name, s.utility, s.updated, s.installed,
  s.timezone, s.billing_start_day, s.timezone_display_mode,
  u.access_token, u.refresh_token, u.auth_status,
  t.id         AS tariff_id,
  t.name       AS tariff_name,
  t.updated    AS tariff_updated,
  t.site_id    AS tariff_site_id,
  ts.id        AS season_id,
  ts.name      AS season_name,
  ts.from_month, ts.from_day, ts.to_month, ts.to_day,
  ts.buy_rate  AS season_buy_rate,
  ts.sell_rate AS season_sell_rate,
  sch.id       AS schedule_id,
  sch.name     AS schedule_name,
  sch.buy_rate AS schedule_buy_rate,
  sch.sell_rate AS schedule_sell_rate,
  sch.from_day_of_week, sch.from_hour, sch.from_minute,
  sch.to_day_of_week,   sch.to_hour,  sch.to_minute
FROM "Site" s
LEFT JOIN "User"          u   ON u.id          = s.user_id
LEFT JOIN "Tariff"        t   ON t.site_id     = s.id
LEFT JOIN "TariffSeason"  ts  ON ts.tariff_id  = t.id
LEFT JOIN "TariffSchedule" sch ON sch.season_id = ts.id
WHERE s.id = ANY($1::text[])
```

The `includeJson` option appends `s.json` to the SELECT list.

The `ANY($1::text[])` parameter works for both single-site and batch calls — no separate query variants needed.

### Row assembly

The JOIN returns one row per schedule (or a single row with all-null tariff/season/schedule columns if the site has no tariffs). Rows are folded into the nested `SiteWithTariffs` structure in JS using three `Map` accumulators keyed by `site.id`, `tariff.id`, and `season.id`. Null `tariff_id` in a row → site has no tariffs (tariffs array stays empty). Null `season_id` → tariff has no seasons. Null `schedule_id` → season has no schedules.

### Public API changes

**New method:**

```ts
async getSites(siteIds: string[], options?: SiteQueryOptions): Promise<SiteWithTariffs[]>
```

- Checks both caches per ID; only fetches uncached IDs from the DB.
- Populates both caches for all fetched sites.
- Returns results for all requested IDs (cache hits + fresh fetches).
- Returns an empty array if `siteIds` is empty (no query issued).

**Changed method (same signature, new internals):**

```ts
async getSite(siteId: string, options?: SiteQueryOptions): Promise<SiteWithTariffs | undefined>
```

- Checks caches as before.
- On cold cache: delegates to `getSites([siteId])` and returns the first result.

**Unchanged:** `invalidateCache()`, all cache TTLs, all callers.

### No new files, no new abstractions

All changes are inside `energy-repo.ts`. A `SiteRepo` class was considered and rejected — it doesn't fit the existing "catch-all repo" pattern and `SiteService` already covers site authorization. The join query logic lives as a private method `loadSitesFromDB(ids, options)` called by `getSites()`.

## Data flow

```
getSite(id)
  → request-cache hit? return
  → module-cache hit? return
  → getSites([id])
      → loadSitesFromDB([id])  ← 1 query
      → assemble rows
      → populate both caches
      → return first result

getSites([id1, id2])
  → filter already-cached ids
  → loadSitesFromDB(uncachedIds)  ← 1 query (or 0 if all cached)
  → assemble rows
  → populate both caches
  → merge with cached results, return all
```

## Testing

Tests are written first (TDD). Implementation follows green tests.

### Tests to update

`energy-repo.test.ts` — existing `getSite` tests currently assert `queryMock` is called 3 times (Site + User + Tariffs) with sequential call signatures. These will be updated to:
- Assert exactly 1 query call
- Mock a single batch of denormalized rows matching the JOIN column aliases
- Keep all behavioral assertions (slim columns by default, json only when requested, etc.)

The request-scoped cache test currently asserts `callCountAfterFirst === 3`. This becomes `=== 1`.

### New tests

1. **Assembly — site with no tariffs**: JOIN returns one row with `tariff_id = null`; result has `tariffs: []`.
2. **Assembly — tariff with no seasons**: row has `season_id = null`; tariff has `seasons: []`.
3. **`getSites()` batch**: two site IDs → one query call with both IDs in the param; returns two `SiteWithTariffs` objects.
4. **`getSites()` partial cache**: one ID cached, one cold → query is issued for only the cold ID; both are returned.
5. **`getSites()` all cached**: no query issued at all.
6. **`getSites()` empty input**: returns `[]` without querying.
7. **`getSite()` delegates**: on cold cache, calls `getSites([id])` (verified via query count = 1).

## Out of scope

- Changes to callers (routes, pages, importer) — they work as-is
- Phase 3 (polling optimization, billing-cycle aggregates)
- Admin panel batch loading (no `getSite` calls found there)
