# TODO

Cross-session work that didn't fit the current focus. Pull from this list when picking up new work.

## How to use this list

When starting fresh work in this repo, check this file. If a session begins something here, leave a short note (date + branch/PR) under the item so the next session knows it's in flight. Once landed, delete the item.

## Egress Reduction — Phase 2 (Structural Optimization)

**Approach:** Batch tariff loading in `getSite()` with JOIN queries + aggressive caching

- Replace N+2+N queries (site → user → tariffs → seasons → schedules) with single JOIN
- Introduce dedicated `getSitesWithTariffs(siteIds[])` method for batch operations
- Cache results with 5-15 min TTL
- Expected savings: ~20-30% for dashboard-data and admin panels; ~5% app-wide
- Complexity: Medium; requires SQL JOIN refactoring and careful testing

## Egress Reduction — Phase 3 (Aggressive + Opinionated)

**Approach:** Phase 1 + Phase 2 + cycle aggregation + polling optimization

- Do Phase 1 + Phase 2 first
- Introduce `getLatestBillingCycleAggregates()` returning pre-aggregated data for entire current cycle
- Replace polling endpoints with smarter caching (e.g., `/api/site-live-data` caches for 30s)
- Expected savings: ~40-50% app-wide reduction
- Complexity: High; requires behavior changes and more validation
- Timeline: 6-8 hours

**Status:** Deferred for future discussion (2026-04-29, after PR #44)
