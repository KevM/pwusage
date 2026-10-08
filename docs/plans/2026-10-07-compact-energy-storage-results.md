# Broader compact energy sampling and PostgreSQL storage results

Measured October 7, 2026. This completes the broader-sampling and isolated-storage milestone. The source was the configured **development** database, queried read-only. No Tesla calls, remote writes, production migrations, deletion, tier changes or reader changes occurred.

## Sample

A cap of 30 sites produced nonempty data from 27 development sites: 107 site-local days and 28,183 five-minute samples. Selection covered the latest three completed days per site, offsets of 30/90/180 days from each site's latest sample, and two DST dates when available. Date boundaries were deduplicated. Eighteen days had a complete regular grid; the others were partial. These are available development records, not a random or representative production cohort. Definition/rate diversity was broadened, but future real production validation remains necessary.

Binary Brotli archives ranged from 582 to 2,478 bytes per sampled day. All binary gzip/Brotli sample roundtrips and existing web/TRMNL grouped billing calculations passed. The complete 288-sample days averaged 1,717 bytes of binary Brotli payload. Synthetic high-precision cases from the first report remain a useful upper stress case (~9–10 KB/day); do not replace them with an assumption that every future site will compress to this development average.

## Attribution investigation

The original 47-schedule day has **47 distinct period names and 47 distinct buy/sell rate pairs**. Timestamp resolution within its referenced tariff agrees with the recorded schedule IDs. Those are distinct economic buckets, not duplicate schedule definitions we can merge safely. The prototype can consolidate equal tariff/version + period name + effective rates, but cannot collapse differing rates.

The two null-schedule days account for 576 samples. Historical tariff definitions are present, but no period in the referenced version matches those timestamps. Neither today's tariff nor a daily midpoint can establish their historical prices. The audit therefore infers zero IDs for these cases and marks them unresolved. It preserves their energy in both the archive and an explicitly unpriced summary with null period/rates; unknown energy is never dropped to make storage smaller. Source records are untouched.

No recorded non-null schedule disagrees with timestamp resolution in this selection. Unit fixtures additionally verify inference where a historical version does cover the timestamp, rejection of current replacements for missing historical versions, rejection of foreign schedules, and preservation of different rates.

This remains a rollout gate: infer only from the exact historical version when it covers the timestamp; otherwise keep incomplete billing attribution. Matching the existing calculation is not proof that its midpoint fallback is correct.

## Actual PostgreSQL allocation

A fresh isolated PostgreSQL **18.6** cluster used a private 0700 Unix-socket directory with no TCP listener. It received only the selected samples. All fixture tables had RLS enabled, no public/anon/authenticated grants, and service_role access. No schemas were created in the source database. These fixtures are intentionally not deployment migrations.

| Representation | Rows | Heap bytes | Index bytes | TOAST/other bytes | Total bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| Lossless day archives | 107 | 122,880 | 16,384 | 163,840 | 303,104 |
| Schedule-ID daily totals | 293 | 32,768 | 32,768 | 32,768 | 98,304 |
| Economic-period daily totals | 267 | 40,960 | 40,960 | 32,768 | 114,688 |
| Five-minute raw baseline | 28,183 | 3,284,992 | 5,185,536 | 32,768 | 8,503,296 |

Archive payloads are bytea with STORAGE EXTERNAL to avoid recompressing already compressed bytes, plus format/codec/checksum/count/coverage metadata and a (site,day) primary key. Each rollup contains four signed energy totals and sample count. The economic-period design also stores period name and effective buy/sell rates in its unique key; unknown attribution has explicit nulls. The original-schedule design references schedule IDs instead. The raw baseline has an integer ID primary key, unique (timestamp,site), (site,timestamp), tariff and schedule indexes. It does not include application parent tables/FKs or every production index.

The original-schedule representation was slightly smaller than the economic-period representation, despite using more rows. Storing textual names/rates and indexing them adds overhead; economic consolidation is not automatically a storage win. Preserve the simpler historical schedule references for now, with metadata/attribution fixes before production adoption. Keep economic consolidation as an optional, proven optimization.

Every archive was SELECTed back from PostgreSQL and decoded to the exact source samples. Stored economic rollup energy sums and coverage counts reconciled for every day, including both unresolved days. RLS/grants were inspected. Measurements use pg_total_relation_size (including indexes and TOAST), pg_relation_size and pg_indexes_size; TOAST/other is the remaining allocated bytes including auxiliary relation forks. The local cluster was shut down after measurement and its private source-data copies removed.

## Per-site-year extrapolation

Dividing measured allocation by 107 days and multiplying by 365 gives:

| Storage | MB/site/year |
| --- | ---: |
| Archives alone | 1.03 |
| Archives + schedule-ID totals | **1.37** |
| Archives + economic-period totals | **1.43** |
| Local indexed raw baseline | 29.01 |

That is approximately **95% less allocated storage** for the sampled mix, including heap/index/TOAST overhead. It is not a production capacity guarantee. This mix includes incomplete days (263 samples/day on average), non-random development sites, fixed small-table allocation overhead, and only one server/version/configuration. Shared application metadata, writes/updates/bloat, additional indexes, replica/backup storage and future precision/rate profiles are excluded. A conservative 2–5 MB/site/year planning range remains sensible until broader production and lifecycle tests.

## Format recommendation and next gates

Use the verified versioned Float64/Brotli archive as the current candidate. It preserves all JS numeric bits, missing slots, exact irregular timestamps, SoC nulls and tariff IDs. Columnar JSON was smaller on these real days, but that candidate has not proved the same numeric fidelity and was larger on the high-precision synthetic days. Do not choose solely by favorable sample sizes.

Next: implement a repository prototype that can read raw rows or archived samples exactly once per day, and query tariff-period rollups for historical bills. Verify 15-minute chart bucketing and all web/mobile/TRMNL/analysis readers. Then add claimed, transaction-safe finalization and late-correction rebuilding, bounded gap repair, actual production sampling/schema migration verification and recovery-tested rollout gates. The application still reads existing data; no finalization/deletion is enabled.

## Reproduce

From the prototype branch's cmd/next-app, configure the desired read-only source in .env. Initialize a new disposable cluster in a private directory matching `/private/tmp/compact-energy-pg-<suffix>`; start it on Unix socket port 55439 with `-h ''`. Then:

```sh
node --import tsx scripts/prototype-compact-energy.ts --database --sites 30 \
  --storage-socket /private/tmp/compact-energy-pg-<suffix> \
  --output /tmp/compact-expanded.json
```

The CLI rejects remote/non-private storage targets. It writes only benchmark fixtures in that local cluster. Stop the cluster and remove its private data copies after inspection. Reports are anonymous; do not commit raw history or logs containing connection details. Relation-size/TOAST definitions were checked against [PostgreSQL 18 documentation](https://www.postgresql.org/docs/18/functions-admin.html) and [TOAST storage documentation](https://www.postgresql.org/docs/18/storage-toast.html).

## Verification

Full application suite: 1,028 tests passed, one existing test skipped. Lint, TypeScript checking and the production build passed. The local storage benchmark verified archive reconstruction, rollup energy/sample-count reconciliation, and table access restrictions. The disposable PostgreSQL cluster was stopped and its private data copies removed.
