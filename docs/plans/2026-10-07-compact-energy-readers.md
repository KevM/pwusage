# Compact Energy Readers Implementation Plan

**Goal:** Prove existing repository chart, analysis and billing methods can consume mixed raw/archive history without enabling finalization or deletion.

**Architecture:** Add an explicit optional historical-reader dependency to EnergyRepo. A prototype reader consumes one coherent snapshot from an injected store, reconstructs detail, and uses verified daily summaries for whole-day billing. Partial days are decoded and filtered. No SQL archive backend or default route activation yet.

**Tech Stack:** TypeScript, existing Float64/Brotli codec, Vitest, existing pricing and chart consumers.

1. Write failing tests for mixed days, half-open ranges, identical overlap deduplication, conflicting overlap rejection, tenant/bounds validation, checksum failures, missing days, DST and partial-day billing.
2. Implement the snapshot reader. Validate archive identity/bounds and reconcile summary rows against decoded samples before trusting totals. Fail on stale summaries or conflicting late rows; never discard or double-count energy. Keep missing data absent. Reject unresolved schedule attribution for billing rather than invoking midpoint pricing.
3. Add an opt-in EnergyRepo dependency for detail, cycle aggregates and 15-minute buckets. Test real downstream web/TRMNL billing, chart and analysis parity, and changed billing ranges.
4. Record limitations: prototype decodes to verify summaries; production must supply immutable verified revisions and coherent snapshots to avoid decoding for billing. Coverage/latest-data queries, SQL backend, claims, late corrections, repair budgets, migrations and rollout are follow-ups.
5. Run full tests, lint, build, diff check and commit. Do not activate the reader by default, fetch Tesla, delete rows, deploy or change tiers/PR #126.
