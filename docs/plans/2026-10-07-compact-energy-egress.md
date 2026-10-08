# Compact history egress implementation plan

**Goal:** Remove routine dual-source transfer and measure actual PostgreSQL protocol response bytes for representative reads against an isolated production archive.

**Architecture:** Default detail snapshots exclude raw rows covered by archives. An explicit bounded verification snapshot retains overlap for local reconciliation. Aggregate snapshots fetch boundary archive detail instead of overlapping raw samples. A local Unix-socket forwarding meter counts database response traffic around serialized read operations; no production connections or external proxy.

1. Write failing local integration tests for normal versus verification detail snapshots and partial-day source exclusion; preserve correction invalidation and corruption failures.
2. Implement source exclusion while retaining repeatable-read consistency and explicit verification. Update the backup-validation script to request verification explicitly.
3. Build a private local protocol meter and bounded benchmark: raw detail versus archived daily/monthly charts, raw-only versus summary bills/coverage, partial bills and combined bill+coverage requests. Count query operations and returned bytes, including metadata/protocol framing; report tariff lookup cost separately.
4. Compare outputs before comparing transfer sizes; keep missing/unresolved data explicit. Reuse aggregate snapshots for related bill/coverage inputs within a request, without a cross-request cache or stale revisions.
5. Restore only relevant production-backup tables locally; run bounded measurements, review, full checks; remove restored data and commit. Do not activate application callers, deploy, change cleanup/tier policy, or delete raw application rows.

Remaining gates include freshness readers, importer/repair integration and actual hosted egress allowance. Local plaintext protocol counts exclude TLS/TCP transport overhead and provider-specific billing; do not call them billed bytes.

## Measured results — 2026-10-07

The private production-backup restore supplied five sites, 150 completed local days and 42,605 samples. All chart samples matched exactly, coverage matched, and billing inputs matched within 1e-9 relative tolerance. Raw row counts were preserved. The anonymous report is `2026-10-07-compact-energy-egress-results.json`.

Mean backend response bytes per window, including transaction/control framing:

| Read | Raw baseline | Compact | Result |
| --- | ---: | ---: | --- |
| Daily chart | 27,753 | 5,704 | 79.4% less |
| 30-day chart | 817,862 | 135,735 | 83.4% less |
| 30-day coverage | 3,063 | 3,093 | 1.0% more |
| 30-day billing inputs | 6,832 | 7,072 | 3.5% more |
| Partial-day billing boundaries | 6,832 | 16,542 | 142% more |

Combined bill + coverage uses one coherent snapshot: 9,925 bytes and three SELECT operations versus 10,165 bytes and four SELECT operations separately. Existing historical tariff lookup adds 2,054 bytes and two SELECT operations on average, independently measured. Compact detail uses three SELECT operations versus one raw query; scalar reads use two versus one. Lower transfer does not imply lower query count.

The initial client-side metadata verification transferred about 27 KB for each monthly scalar read. Verification now runs within the database and returns only the requested billing or coverage fields. A mandatory verification result is evaluated before projecting summaries, including when all summaries are missing; corruption fails explicitly. The server function uses invoker permissions, a fixed search path and restricted execution.

Canonical metadata version 2 hashes `CEM2`, UTF-8 site ID with a signed 32-bit byte length, signed 64-bit UTC millisecond day bounds, one attribution flag byte, signed 32-bit sample count, signed 64-bit first/last timestamps, signed 32-bit maximum gap and summary-row count. Each tariff/schedule-sorted row contains signed 32-bit tariff ID, schedule presence byte and signed 32-bit schedule ID (zero when absent), eight big-endian Float64 energy totals and signed 32-bit sample count. Node and PostgreSQL use identical network-order bytes. Version 1 remains readable through the detail fallback; finalization retries rebuild metadata as version 2.

Full local-day scalar reads transfer no chart payloads. Partial-day boundaries require lossless chart decoding and therefore have higher transfer; ordinary calendar billing-date changes still use complete local days. Normal detail reads exclude raw samples covered by an archive. Explicit bounded verification reads include both sources for reconciliation. Legacy archives take the detail path.

These measurements exclude site/auth/endpoint reads, browser transfer, TLS/TCP overhead and provider accounting. The billing baseline uses matching local-day groups rather than the existing UTC-day SQL grouping. Five sites are a bounded sample, not a capacity forecast. Maintenance/freshness workloads and actual hosted quotas remain activation gates. No production connections, Tesla calls, caller activation, raw-data deletion or deployment occurred.

Independent review found and verified the fix for a possible empty-summary verification bypass. Validation passed: 1,078 tests, lint and production build (one unrelated test skipped). Function execution privileges were also checked directly. The temporary restored cluster and extracted data were removed; the user-provided backup zip was preserved.
