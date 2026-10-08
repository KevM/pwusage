# Compact Energy Prototype Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Measure lossless daily archives and tariff-period totals without modifying application data or live behavior.

**Architecture:** A prototype module packs a site's local day into a shared time axis and columnar measurements, then compresses it. A standalone read-only CLI measures database days, validates round trips and existing web/TRMNL bill calculations, and writes an anonymous report. Production adoption is a subsequent effort.

**Tech Stack:** TypeScript, Node Buffer/zlib/crypto, Vitest, existing pg pool/date utilities/billing aggregators.

---

### Task 1: Capture the approved design
Files: `docs/plans/2026-10-07-compact-energy-design.md`, this plan, `task.md`.
Record open-day rows, historical archives, local-day tariff totals, no billing snapshots, bounded gap repair and future tier/backfill policy. Explicitly separate prototype from deployment and PR #126 retirement.

### Task 2: Lossless archive and reconciliation tests
Create `cmd/next-app/src/lib/prototypes/compact-energy.test.ts`.
1. Write failing tests importing encodeDay/decodeDay/rollupDay before implementation.
2. Include ordinary 288-slot days, 276/300-slot DST days, null SoC/schedule, holes, zero and negative values, decimal precision, tariff changes, irregular timestamps, empty days, corrupt buffers, invalid values, duplicates, and samples outside the day.
3. Check all codec round trips reconstruct EnergyData exactly; preserve timestamp offsets rather than rounding.
4. Compare tariff-period energy sums and existing billing costs for raw grouped data versus proposed rollups across seasons/versions using EnergyRepo.aggregateUsageByTOU and aggregateUsage.
Run `npm run test -- --run src/lib/prototypes/compact-energy.test.ts`; confirm failures before adding codec.

### Task 3: Implement the bounded prototype codec
Create `cmd/next-app/src/lib/prototypes/compact-energy.ts`.
Implement `encodeDay(rows, start, end, codec)` and `decodeDay(archive)` with a versioned header, gzip or Brotli, finite numeric validation, nullable fields, exact timestamp metadata, limits and checksum. Column-major Float64 values avoid quantizing precision. Compare compressed columnar JSON as a benchmark baseline. Implement `rollupDay` by original tariff/schedule IDs; retain signed totals, sample sign splits and counts. Run focused tests until passing.

### Task 4: Read-only measurement CLI
Create `cmd/next-app/scripts/prototype-compact-energy.ts`.
1. Load dotenv at startup. Default to synthetic mode; require `--database` for read-only real-data capture. Allow `--output <path>` for an anonymous JSON report.
2. Use the configured DATABASE_URL and existing pool; BEGIN READ ONLY; statement timeout; bounded site/day selections. Query completed local days with exact UTC timestamp interpretation. Include DST dates when source data exists.
3. Compare JSON row bytes, compressed columnar JSON, Float64 gzip/Brotli bytes; record encode/decode CPU time separately from database latency.
4. Assert decoded samples equal input and billing/energy totals agree within a documented floating-point tolerance. Test same inputs through existing web and TRMNL pricing. Report unresolved tariff schedules.
5. Estimate annual payloads from representative complete days separately from partial/empty days. Show assumptions for 317-byte historical row allocation and 600-byte summary row budget; never represent these as measured new-schema allocation.
6. No writes, Tesla fetches, raw-data exports or credentials in the report. Roll back/close connections in finally; redact errors that might contain connection strings.

### Task 5: Record findings and verify
Create `docs/plans/2026-10-07-compact-energy-prototype-results.md` with measured sample counts/sizes, DST/irregular/missing-ID findings, codec recommendation, limitations and production follow-up tasks.
Run `npm run test -- --run`, `npm run lint`, `npm run build`, and `git diff --check`. Build may require permission to open a local worker port. Commit verified prototype and documentation with a conventional commit. No push/PR is needed to begin this exploration.

### Follow-up production work (not implemented here)
Generate archive/rollup migrations using `npm run db:migration:create`; RLS/revoke client grants/service_role permissions. Measure actual stored relations/indexes, implement transaction-safe finalization and late-correction revisioning, refactor historical billing/chart/analysis readers, preserve annotations, enforce budgeted historical retrieval and any approved premium access at APIs, and retire PR #126 plus its reminder when explicitly directed. Prove rollback/recovery before enabling deletion.
