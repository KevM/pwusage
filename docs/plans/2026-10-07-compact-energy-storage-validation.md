# Compact Energy Storage Validation Plan

**Goal:** Broaden read-only sampling and measure actual archive/rollup heap, index and TOAST allocation in a disposable local PostgreSQL cluster.

Continue the existing prototype worktree. Source reads remain bounded with timeouts; no Tesla calls or remote writes. Default configured source is development. New tables are benchmark fixtures, not deployment migrations. Local cluster uses a private Unix socket, no TCP listener, and is shut down after measurements.

1. Add failing tests for attribution audit: preserve recorded schedules, infer null schedules only using the referenced historical tariff version, identify unresolved/foreign schedules, and count unique economic buckets without merging different prices or versions.
2. Implement pure audit. Group equivalent schedule definitions by historical tariff ID + TOU name + effective buy/sell rate for a candidate billing summary; preserve original IDs in the lossless archive. Compare inferred summaries against existing billing; report differences rather than changing stored data.
3. Expand read-only selection to all sites up to an explicit cap, recent days, 30/90/180-day offsets, and DST dates. Fetch historical seasons for timestamp-based attribution. Record anonymous per-site summaries, null IDs, distinct schedules, unique economic periods, gaps and compression results.
4. Initialize a private disposable local PostgreSQL cluster. Create role-restricted archive, original-schedule rollup and canonical-period rollup fixtures plus a raw-row baseline with documented indexes. Enable RLS and revoke public/anon/authenticated rights; grant service_role. Insert only the selected samples, no remote application writes.
5. Read stored archives back and verify checksums and exact recovery. Measure pg_total_relation_size, heap/index/TOAST bytes, row counts and per-site-year extrapolations. Include server version and schema/index assumptions; compare both summary designs. Stop the local server after measurement.
6. Record results, limitations and next production gates. Run full tests, lint, build and diff checks; commit verified changes. Do not wire readers, deploy migrations, finalize/delete source rows, change tiers, close PR #126 or alter its reminder.
