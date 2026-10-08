# Compact energy prototype results

Measured October 7, 2026. Prototype only: no application readers, schema, Tesla calls, deletion, deployment, or account policy was changed. The approved direction and implementation plan are alongside this report.

## What was built

`src/lib/prototypes/compact-energy.ts` preserves the existing application's seven numeric fields, including tariff/schedule IDs and nullable SoC, using column-major Float64 arrays. A shared site-local day boundary and five-minute slot indices preserve gaps; exact offsets preserve irregular timestamps. Payloads are versioned, compressed with gzip/Brotli, checksummed and decoded with a 1 MiB limit. Rollups group signed energy quantities by original historical tariff and schedule IDs. The existing billing calculation still operates on demand.

This is a sample-level archive, not a pre-rendered chart. Optional presentation fields (database row IDs, 15-minute bucket sample counts/timestamps) are outside the raw-sample projection. Existing analysis inputs are identical after decoding. The live chart readers have not yet been wired to archives or browser-tested.

## Real data measurements

The configured target was **development**, not production. Bounded read-only queries selected up to three completed recent days and two DST dates from each of three sites. Nine nonempty days were available: 2,557 samples, including one 23-hour DST day. No raw history, site identity or credentials are committed; the accompanying JSON contains anonymous size/timing/validation results only.

| Format | Observed compressed bytes/day |
| --- | ---: |
| Columnar JSON + gzip (size candidate only) | 1,683–2,057 |
| Columnar JSON + Brotli (size candidate only) | 1,242–1,592 |
| Float64 columns + gzip (verified lossless) | 1,947–2,399 |
| Float64 columns + Brotli (verified lossless) | 1,582–2,090 |

All gzip/Brotli binary payloads reconstructed samples exactly. Existing web and TRMNL energy/cost aggregation agreed with rollups for all nine days within relative/absolute tolerance `1e-9 * max(1, |a|, |b|)`. A separate fixture preserves the seasonal-rate regression (27.471 kWh export, 18.243 kWh import yields $0.36912 credit). Matching current behavior does not certify unresolved tariff attribution.

Measured one-day binary decode CPU time: roughly 0.13–1.09 ms. Combined gzip/Brotli encode CPU time divided by two: roughly 0.30–3.66 ms. These are single-process exploratory timings, include a cold first call, and exclude database/network/browser latency. Production throughput requires a separate benchmark.

## Budget update

Four complete 288-sample days average **1,760 bytes** for lossless Brotli payloads: **0.64 MB/site/year**, excluding archive row/index/TOAST/checksum overhead. Summary counts range from 1 to 47 groups/day, averaging 12.75 across those four days. Using the explicitly unmeasured 600-byte summary-row budget gives **2.79 MB/year** for summaries and **3.43 MB/year combined**, versus the earlier 33.32 MB/year indexed-row estimate. That suggests around 90% reduction before archive overhead, not a measured PostgreSQL storage result.

The sample is small and biased by site-ID order and available development history. Two full days have null schedule IDs (576 samples), so the annual average is not a reliable production-capacity forecast. One day has 47 distinct historical tariff/schedule buckets; potentially equivalent TOU/rate intervals could be consolidated, but only after mapping them safely. Do not silently merge historical rates or assume four groups/day.

Full-precision synthetic waveforms compress less readily: about 9–10 KB/day, or 3.45 MB/year for the complete synthetic day plus 0.44 MB/year summary budget. Real production values and schedule structure must be sampled more broadly before firm capacity claims. JSON was smaller on these real days but larger on these synthetic high-precision days; generic JSON also loses negative zero. The prototype therefore uses Float64 binary for its exact-fidelity proof rather than selecting a final wire format solely on size.

## Coverage and historical attribution findings

- Four real days have a full regular grid. The others contain gaps; one DST day has 271/276 samples. Gap repair/finalization rules remain necessary.
- Two days have null tariff schedule IDs. Existing code uses a midpoint/current-schedule fallback for those historical aggregates. Exact archive recovery cannot make that fallback accurate. Reconstruct schedule attribution from historical definitions while timestamps still exist, or explicitly mark attribution unresolved before approving summary-based billing.
- All non-null schedule IDs in this selection resolve. One day has 47 distinct buckets; investigate parser schedule granularity/versioning rather than assuming a defect.
- Stored grid and battery measurements are already net within an interval. Positive/negative splits in the rollup represent signed sample splits, not recoverable original Tesla gross flows.
- EnergyData.timestamp is timestamptz following migration 20260211191000. Query the stored instant directly; converting it to a naive UTC timestamp before pg Date parsing would shift it on a non-UTC host. The benchmark uses explicit timestamptz bounds.

## Recommended next production steps

1. Broaden the read-only production sample with explicit target selection, representative tariffs/precision and known DST/repair cases. Test additional codecs if justified; compare final framing overhead fairly.
2. Generate archive/rollup migrations with the repository generator, enabling RLS and service-only grants. Measure actual heap/index/TOAST bytes in an isolated database. Avoid base64 storage when binary bytea will suffice.
3. Specify a normalized historical billing bucket, units, null/missing semantics, format evolution, timestamp convention and integrity checksum. Retain original schedule IDs in the archive. Resolve attribution before finalization.
4. Implement bounded gap repair plus claimed, revision-aware finalization. Persist archive and totals atomically; verify before deletion. Specify incomplete-day status, late-correction rebuilds and a short editable buffer.
5. Add repository readers that choose raw or archived samples once per day, reconstruct existing 15-minute chart buckets in memory where needed, and query local-day summaries for billing. Verify web/mobile/TRMNL/analysis/load planning and preserve tags.
6. Keep retention/access/backfill policy separate. Premium history retrieval needs API authorization, deduplication and global cost budgets. This prototype does not decide tier policy or retire PR #126.
7. Require a recovery-tested backup, reconciliation preview and explicit rollout approval before activating deletion. Until then the current application stays unchanged.

## Reproduce

Run from this branch's `cmd/next-app` with its dependencies and chosen `.env`:

```sh
node --import tsx scripts/prototype-compact-energy.ts --output /tmp/compact-synthetic.json
node --import tsx scripts/prototype-compact-energy.ts --database --output /tmp/compact-database.json
npm run test -- --run src/lib/prototypes/compact-energy.test.ts
```

`--database` opts into bounded database reads only; no Tesla requests. Keep local logs/reports private. This is not a production data cleanup command.

## Verification

Full suite: 1,021 tests passed, one existing skipped test. Lint passed without warnings. Production build passed. Focused prototype tests cover eleven cases, including lossless recovery, both DST transitions, missing/irregular samples, invalid input, checksum/corruption, analysis-adapter equivalence and seasonal billing.
