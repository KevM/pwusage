# Compact energy history design

## Agreed direction
Keep five-minute fidelity without retaining one indexed database row per historical sample. An open site-local day uses ordinary EnergyData rows. A finalized day has a lossless compact time-series archive and queryable daily energy totals per historical tariff version/schedule. Bills are calculated on demand, with existing cross-season/version netting. This supersedes the proposed 90/365-day raw retention policy; PR #126 remains unmerged. Premium access/backfill is a separate policy decision, not necessary to prove storage feasibility.

## Archive
Version the format. Store the UTC instant of local midnight, next local midnight, units (Wh for the existing *_power energy measurements; SoC in percent), and shared time-axis metadata. Regular samples use five-minute slot indices (missing indices mean absent samples); irregular samples use exact millisecond offsets, without rounding. Preserve every numeric value, nullable SoC, original tariff and schedule IDs, timestamps, and zero values. Decode into the existing EnergyData shape. Compare columnar JSON compression against column-major Float64 buffers, with gzip and Brotli. Bound payload sizes and include a checksum. Binary payloads could eventually use bytea; benchmark actual PostgreSQL heap/index/TOAST overhead before claiming database savings. No schema changes in the prototype.

## Daily totals
Group by site-local day + tariff_id + tariff_schedule_id. Sum home, solar, signed grid and signed battery energy. Also retain positive/negative sample splits and sample counts. IMPORTANT: the importer already nets grid import/export and battery charge/discharge within each interval; these splits cannot recover original Tesla gross flows that have already been discarded. Do not describe them as utility gross meter measurements. Coverage metadata must retain expected slots, observed/missing slots, and irregularity.

Tariff definitions remain append-only. Unresolved/null historical schedule IDs must be reported; do not assume midpoint fallback proves accurate tariff attribution. Prototype billing parity uses the existing calculation, not a new pricing formula. Changing the billing start day selects a different range of local-day totals.

## Finalization and repair (future implementation)
Reuse gap audit/sync with bounded retries and an API budget. Audit, repair, re-audit, produce archive+totals, verify lossless recovery and billing/energy reconciliation, atomically persist both before deleting rows. Use a database claim/revision to prevent races with late imports, make retries idempotent, and update archive+totals together for corrections. Explicitly incomplete days retain coverage status after bounded repair. Keep a short editable buffer if measurements justify it. Readers merge raw and finalized days once, with no double counting; do not trigger automatic costly historic backfills on page navigation. Missing historic detail is unavailable until approved/budgeted recovery succeeds. Preserve LoadTags separately as they can still be useful with archived sample fidelity.

## Prototype scope and gates
A pure codec/rollup module, focused tests, and a read-only benchmark CLI. No Tesla calls, migrations, deletions, live reader changes, tier changes, deployments, or closing PR #126. Fetch bounded database samples in a read-only transaction; report anonymous aggregate sizes/timing and validation only, never store credentials or raw user history in committed files. Use synthetic DST, gap, irregular-time and tariff-change cases alongside real samples.

Before rollout: validate sample timing/coverage semantics (including first/last interval convention), real storage overhead, decode latency, chart adapter parity, all reader/analysis consumers, late corrections, historical tariff ID completeness, failure recovery, and backup/notice requirements. Storage totals must distinguish measured payload bytes from projected row/index overhead.

## Database egress constraint — confirmed 2026-10-07

Database egress is very limited. Treat transferred bytes as a first-class acceptance criterion alongside storage and correctness. Small stored archives alone do not establish low egress.

- Billing, coverage, existence and freshness queries must select only the scalar fields they need; never retrieve chart payloads for whole-day totals or metadata.
- Chart/detail reads must retrieve compressed payloads only for requested days. Decode on the application server. Exclude overlapping raw rows from normal archived-day reads; reserve dual-source reconciliation for explicit bounded verification jobs against a local restore.
- Partial-day billing may decode boundary archives; complete days use verified summaries. Missing data must not trigger broad database scans or automatic Tesla backfills.
- Reuse coherent per-request snapshots and fetched tariff metadata across consumers. Avoid fetching the same day or billing range repeatedly in one response. Any cache must respect site authorization and revision/invalidation semantics; cached stale billing is unacceptable.
- Before default activation, measure returned database bytes and query counts for representative daily/monthly charts, full and partial bills, coverage/gap audits, freshness and repair/finalization jobs. Include pg bytea wire representation, scalar metadata and tariff queries, not only compressed payload lengths or disk allocation. Record database-to-app and app-to-browser egress separately.
- Keep remote validation bounded; prefer the supplied production backup restored locally for large comparisons. No numeric egress allowance has been supplied, so do not invent a budget or promise savings without measurement.

Activation gate: remove routine archive/raw dual reads, verify payload-free scalar query paths, and review measured egress per request before switching application callers. Future repair scheduling must budget both API cost and database transfer volume.
