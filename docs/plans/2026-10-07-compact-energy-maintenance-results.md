# Compact maintenance validation and operating guide

Measured October 7, 2026 against the supplied October 2 production backup, restored only into a private local PostgreSQL 18.6 fixture. No live production connections, Tesla calls or remote changes. The maintenance benchmark retained raw samples. A separate trim/recovery rehearsal below temporarily removed selected samples and restored them exactly.

## Operator workflow

From `cmd/next-app`, the CLI loads `.env` first. It uses that configured database, so verify the intended environment before any invocation. The site ID must be explicit; dates are site-local, `--from` inclusive and `--before` exclusive.

```sh
npx tsx scripts/maintain-compact-history.ts \
  --site-id SITE_ID --from 2026-09-01 --before 2026-10-01
```

Preview makes no writes. It returns day counts, expected five-minute counts, existing verified archive status, billing attribution when known and repair warnings. No sample arrays or account/site IDs appear in output. `needsRepair` includes count mismatches, the existing importer's start/end/interior gap warnings and known incomplete tariff attribution. It is an operator warning, not permission to fetch Tesla data. Matching sample count alone is not proof of a complete regular time axis.

After reviewing a preview, explicitly apply a small chunk:

```sh
npx tsx scripts/maintain-compact-history.ts \
  --site-id SITE_ID --from 2026-09-01 --before 2026-10-01 \
  --max-days 2 --apply
```

The date window is capped at 31 local days, including DST boundaries. Each apply attempts at most seven days (configurable downward) and checks a 45-second **soft** elapsed budget between days. Each finalization has statement/lock timeouts; it can exceed the remaining elapsed budget, so this is not a hard invocation deadline. Two most recent completed local days and the open day stay outside maintenance. This buffer keeps recent refresh/monitoring consumers on raw samples while production pruning remains disabled.

Repeated invocations of the same range skip modern archives only after database-side summary/coverage, latest-projection and compressed-payload checks. They fetch scalar metadata, not chart payloads. Legacy projections/checksums are upgraded through finalization. Apply returns resulting tariff attribution for newly finalized/unchanged days. Empty days create no archive. Busy claims stop the run and remain in `remaining`; count/time limits also return the remaining local dates. Integrity errors stop the run; earlier day transactions remain committed and all original samples remain recoverable.

For a damaged archive with retained raw samples, preview then apply the same bounded window with explicit `--rebuild`. Rebuild bypasses existing archive verification and reconstructs every selected nonempty day from raw data; it still verifies lossless decode, summaries and historical attribution before atomically replacing a revision. It does not infer missing tariff IDs, fetch missing samples, erase raw rows or touch tags. Follow with an ordinary preview and relevant chart/bill comparison.

## Measured response transfer and storage

Three selected sites, 30 completed days each: 90 days finalized in 15 bounded invocations. All raw row counts stayed unchanged; repeats performed no finalizations. Seventy-five day windows had strict sample-count or coverage warnings, while all 90 archived days had complete historical tariff attribution. These warnings were preserved and did not trigger paid repair. A separate 30-site/150-window validation finalized 77 nonempty days with 20,256 samples, exact chart/summary/coverage recovery and 77 unchanged retries. One day remained explicitly incomplete for tariff attribution.

| Operation | Mean database response bytes | SELECTs |
| --- | ---: | ---: |
| 30-day initial preview, one site | 3,359 | 3 |
| Apply chunk (seven-day cap, last chunk smaller) | 193,140 | 51 |
| 30-day repeat after completion, one site | 4,800 | 3 |

Initial apply across 90 days transferred 2,897,104 response bytes, about 32.2 KB/day. This is a one-time finalization cost plus repeated scalar previews; retries of already verified archives avoid raw/chart transfer. Large backfills must be budgeted and divided into explicit cohorts. No claim about available hosted quota is made. Synthetic regression tests additionally bound one-day maintenance preview below 2,500 response bytes even when its chart archive is larger than 5,000 bytes.

The fresh 90-day fixture allocated 385,024 bytes to `EnergyDayArchive` and 155,648 to `EnergyDaySummary`, including indexes/TOAST: **540,672 bytes**, extrapolated to **2.19 MB/site/year**. This measured the five-migration schema before the pruning marker and recovery lifecycle. It includes coverage metadata, latest power/charge projections, payload checksums and indexes; the six-migration lifecycle needs a fresh storage measurement. The sample is nonrandom and small, has partial days and fixed allocation overhead, and excludes lifecycle bloat, other application tables, replicas and backups. Retaining raw data means this checkpoint frees no storage.

These are warmed, serialized, local plaintext PostgreSQL backend protocol response measurements, including transaction/control framing. They exclude TLS/TCP, provider-specific accounting, site/auth/endpoint work and browser transfer. The local fixture's running time is not a hosted latency forecast.

## Rollout and rollback gates

1. Keep compact reads unset/disabled; do not schedule a maintenance cron or automated Tesla repair. Confirm migration CI on the future draft PR and the migration-before-deployment order. All six compact migrations applied successfully to the isolated source-table fixture; hosted CI remains separate evidence.
2. Deploy migrations and cleanup safeguards before separately authorizing the first production archive. Cleanup and finalization serialize with a shared/exclusive maintenance claim, so first finalization cannot race deletion. Archive presence prevents old cleanup from resuming after read-switch rollback. Preserve this guard during rollback; do not redeploy a pre-guard cleanup route while archives exist.
3. Preview a small explicit site/date cohort, review incomplete counts and tariff attribution, estimate total one-time transfer against the actual hosted egress allowance, then apply only the separately authorized cohort. Verify selected charts, totals, bills, coverage and freshness with archive reads enabled in a controlled environment.
4. Paid gap recovery needs an explicit per-site/day/API budget and re-audit using the existing sync mechanism; this PR only reports warnings and rebuilds stored archives. No navigation-triggered historic repair is introduced when compact reads are enabled.
5. Production raw samples and historical LoadTags remain retained. Internal trim/recovery primitives are tested, but no trim CLI, cron or route is exposed. Activation still requires recent raw-only consumer review, an operator workflow and recovery budget, a fresh recoverable backup, a full restore rehearsal and explicit first-trim approval. Ordinary EnergyData mutations invalidate unpruned archives and must never be used as pruning.

## Internal trim and recovery rehearsal

The six-migration implementation adds a pruning marker and bounded internal methods, with no operator trimming command or activation. Trimming requires the exact reviewed archive revision, local-day bounds outside the recent buffer, complete tariff attribution, verified lossless chart/summaries/coverage/latest projections and exact raw parity. PostgreSQL computes the raw parity digest over the canonical binary samples, preserving Float64 signed zero and null fields; only a checksum and count leave the database. Fractional-millisecond source timestamps and more than 4,096 samples are refused. Marker and raw deletion commit together under maintenance/site claims.

Pruned days remain authoritative and can be read/finalized without replacing them with empty raw data. Direct raw corrections and timezone changes fail closed. With compact reads explicitly enabled, batch imports restore every touched pruned day before applying partial changes in the same transaction, preserving untouched samples and the existing null-SOC merge rule. Recovery is bounded to seven archive days; larger/wider batches must be divided into deliberate chunks. `--rebuild` refuses pruned days: restore the reviewed day first. Maintenance reports whether its inputs include pruned days and never performs deletion itself.

A separate nonrandom sample of five backup sites, two days each, recovered 2,859 samples across ten days. Charts, billing inputs and coverage were exact after trimming; restoration recovered every original sample and the same chart checksum. Partial late corrections preserved untouched samples and SOC. The total raw row count was restored after the rehearsal.

| Operation | Mean database response bytes | SELECTs |
| --- | ---: | ---: |
| Verified one-day trim | 6,825 | 6 |
| Verified one-day restoration | 6,809 | 6 |

The initial raw-reread implementation used about 34.4 KB/day for each operation; database-side parity reduced this by about 80%. A synthetic full-precision 288-sample day also remains below a 35 KB response bound for each operation. Costs include fetching/verifying the compressed chart and summaries, and use the same local protocol limitations above. Writes and provider-specific ingress are not measured. This is a source-table/sample recovery rehearsal, not a fresh whole-production backup/restore rehearsal.

Before rolling back readers or deploying pre-guard code after any future trimming, restore **all** pruned days through the reviewed, bounded protocol and verify raw parity. Keep the current database guards and cleanup guard until that completes; raw-only readers cannot serve pruned days. A timezone change likewise requires restoring all pruned days for that site first. There is no automatic mass restoration or fallback to Tesla.
