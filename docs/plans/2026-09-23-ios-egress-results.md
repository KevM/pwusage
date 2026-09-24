# iOS Database Egress Measurement

## Result status

This is an exploratory measurement, not proof that the mobile feature adds no appreciable database egress. Route-trace bytes below are UTF-8 lengths of JSON-serialized node-postgres rows; the older Task 1 figures are post-repository-mapping byte proxies. Neither measures PostgreSQL wire bytes. Actual monthly egress acceptance remains unproven.

### Route traces

An opt-in route trace harness is checked in at `cmd/next-app/scripts/mobile-route-egress-trace.test.ts`. The following read-only traces were run with the checked-in harness against the confirmed development database. `refreshLiveStatus` is stubbed, so the trace makes no Tesla calls. Before each cold route, the harness clears both the site and cycle-rollup caches; warm is the immediate repeat. This describes application cache state, not guaranteed PostgreSQL cache state.

| Snapshot (UTC) | Web live cold | Web live warm | Mobile live cold | Mobile live warm | Bill cold | Bill warm |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Current, 2026-09-23 23:15 | 7 / 4,633 B | 2 / 22 B | 7 / 4,633 B | 2 / 22 B | 9 / 4,694 B | 7 / 1,280 B |
| Populated, 2026-08-27 22:25 | 7 / 30,736 B | 2 / 20,951 B | 7 / 30,736 B | 2 / 20,951 B | 9 / 50,856 B | 7 / 47,442 B |
| Late cycle, 2026-07-11 04:55 (July 10 local) | 7 / 41,763 B | 2 / 27,389 B | 7 / 41,763 B | 2 / 27,389 B | 9 / 67,964 B | 7 / 64,550 B |

Each cell is `query count / JSON-row byte proxy`. The two historical populated snapshots returned respectively 70 buckets, 34 cycle aggregates, and 209 raw-today rows; and 92 buckets, 64 aggregates, and 272 raw-today rows. Current energy rows were empty. All routes included authorization and site/config queries in their measured counts. The harness prints the per-query categories and row counts for each run.

The web and mobile live response paths use the same database query set; mobile changes only response shaping. Bill summary is a separate, slower request: it reads exact TOU energy for the billing cycle and a latest-energy timestamp. The bill endpoint does not enforce a 30-minute cadence. The native client/coordinator must request it no more often than every 30 minutes. No cache header is used because the route is authenticated, site-specific, and force-dynamic; a server cache hint would not enforce client polling cadence or establish safe shared caching.

### Task 1 bill-period response verification

After adding `currentBill.periods` to the HTTP response, the guarded route trace was rerun on the same populated late-cycle development snapshot (2026-07-11 04:55 UTC). Bill cold remained 9 SELECT queries / 353 returned rows / 67,964 JSON-row proxy bytes; bill warm remained 7 SELECT queries / 346 returned rows / 64,550 bytes, matching the pre-change figures above. Per-query row counts were unchanged: the cycle aggregate query returned 64 rows, the raw-today query returned 272 rows, and the latest-timestamp query returned 1 row. The new period array is mapped from the already-loaded `getUsageByTOU` rows, so it adds HTTP response content without adding SQL queries or result rows. The trace proxy excludes the HTTP response itself and is not a PostgreSQL wire-byte measurement.

The live bucket query now also returns `MAX(timestamp)` per group so freshness reflects the newest represented sample rather than the 15-minute bucket start. This adds one timestamp field to each returned bucket row; at Task 1's 70-row snapshot that means 70 additional timestamp values. The egress estimator includes this field, and the route totals above were collected after it was added. Its isolated byte increment cannot be determined from these runs; the older Task 1 mapped-value figures below predate this addition.

Using the late-cycle warm JSON-row proxies (27,389 B live every five minutes and 64,550 B bill every 30 minutes), the modeled monthly total is `(12 × 27,389 + 2 × 64,550) × active hours/day × 30`:

| Active hours/day | One phone | Four phones |
| ---: | ---: | ---: |
| 1 | 13.733 MB/month | 54.932 MB/month |
| 8 | 109.864 MB/month | 439.457 MB/month |
| 24 | 329.593 MB/month | 1.318 GB/month (26.37% of 5 GB) |

This is a scenario from one dev site's late-cycle snapshot, not a production forecast or actual PostgreSQL egress. Each additional phone issues its own requests and adds database load. Web and mobile live have equal per-request query cost in the trace; each additional mobile request still adds the cost of another request relative to no request. Cold-call frequency and production row volumes remain unknown.

TRMNL query counts and database egress have not been compared with these routes. A TRMNL egress comparison remains pending; existing TRMNL correctness tests do not establish query counts or bytes. Cold calls and production traffic may differ materially.

The current dev snapshot returned no energy rows, while the two historical snapshots returned populated data. These differing row counts show why current development data is not an upper bound for production. Do not infer production egress from this development database.

Measurements were run read-only against the confirmed development database on 2026-09-23. The selected site in `America/Chicago` had 35,305 stored energy rows, with its newest row at 2026-08-27 22:20 UTC, about 27 days before measurement. The historical snapshot below was used so the query-shape and row-size proxies had representative nonempty energy data. This is a development snapshot, not current production traffic, and its stale dataset cannot establish current production row counts.

The route trace byte proxy JSON-serializes node-postgres result rows, including JavaScript date serialization. It excludes PostgreSQL protocol framing, TLS framing, HTTP response JSON, and database traffic outside the traced route queries. It is not comparable to the earlier repository-mapped proxy, which formats and selects fields after repository mapping.

The five-minute path does not add full-cycle aggregate or raw-today reads. It uses the existing bucket query, with exact cycle billing isolated to the slower bill endpoint. Existing website/TRMNL correctness tests cover timezone billing-cycle boundaries, DST, and historical tariff version resolution; the bill route uses the shared `EnergyRepo.getUsageByTOU` calculation. Those tests do not compare TRMNL query counts or egress. This change does not introduce a separate bucket-based bill estimator.

## Task 1 repository-mapped query-set measurements

These earlier figures are a separate metric from the route trace above. They count selected values after repository mapping, and the bucket query figures predate the added `sample_timestamp` field. They are retained as historical context only.

The setup query read the site's user ID, timezone, and billing start day: 1 row, about 69 mapped-value bytes, 611.2 ms. The snapshot's site-local date was 2026-08-27 and its billing cycle day was 17.

| Query | First rows | First proxy bytes | First ms | Repeat rows | Repeat proxy bytes | Repeat ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Existing live 24-hour buckets (before sample timestamp field) | 70 | 5,950 | 134.3 | 70 | 5,950 | 76.6 |
| Completed-cycle aggregates | 34 | 1,571 | 197.2 | 34 | 1,571 | 66.1 |
| Today's raw energy rows | 209 | 11,729 | 66.7 | 209 | 11,729 | 67.1 |
| Latest energy row as of snapshot | 1 | 37 | 65.7 | 1 | 37 | 62.9 |
| Tariff versions | 1 | 54 | 69.0 | 1 | 54 | 59.8 |
| Schedule versions | 6 | 139 | 77.3 | 6 | 139 | 60.3 |
| Active-user authorization lookup | 1 | 4 | 67.3 | 1 | 4 | 61.1 |
| **Total mapped-value proxy for query set** |  | **19,484** |  |  | **19,484** |  |

The setup query took 611.2 ms and includes initial connection effects. “First pass” and “repeat pass” describe run order only; the first pass is not a guaranteed cold database-cache measurement. Durations include repository mapping time around each query. The latest-row read is bounded by `timestamp <= 2026-08-27T22:25:00.000Z`, so all EnergyData rows belong to the same time window. Historical energy windows still use the site's currently stored timezone and billing-day settings. Tariff versions, schedule versions, and user authorization state are also read as currently stored; the script does not reconstruct historical configuration or auth state.

## Re-running

From `cmd/next-app`, set `DEV_DATABASE_URL` and `EGRESS_SITE_ID` in the ignored local `.env`, then run:

```sh
npx tsx scripts/measure-mobile-egress.ts --site "$EGRESS_SITE_ID"
```

That uses the current time. To measure a stored historical day, pass its end instant with `--at`:

```sh
npx tsx scripts/measure-mobile-egress.ts --site "$EGRESS_SITE_ID" --at 2026-08-27T22:25:00.000Z
```

For the route harness, set `DEV_DATABASE_URL` and `EGRESS_SITE_ID` in the ignored local `.env`, then run `NODE_ENV=development npx vitest run scripts/mobile-route-egress-trace.test.ts`. It requires both values, refuses production, replaces `DATABASE_URL` with the guarded development URL before importing the routes, invokes the real web/mobile live and bill GET handlers, and intercepts SELECT query results. It prints query counts and UTF-8 lengths of JSON-serialized node-postgres result rows. These bytes are a transparent row-value proxy; PostgreSQL wire bytes still require database/network-level instrumentation. The test's only setup query reads the guarded site's linked user ID to create an authorization token. Its route queries are read-only.

The separate historical query-set estimator above is still available as `npx tsx scripts/measure-mobile-egress.ts --site "$EGRESS_SITE_ID" --at <ISO timestamp>`; it has the same dev URL/site/production guards and performs no Tesla calls. A site-local date with no matching history will return zero for energy results; choose a populated historical instant when the dev database has no recent energy rows. Never put credentials in this document or command history.
