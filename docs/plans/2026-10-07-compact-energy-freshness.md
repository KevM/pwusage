# Compact history freshness and request reuse implementation plan

**Goal:** Preserve the latest energy timestamp when history is archived, and avoid duplicate tariff/today reads in the live page totals helper.

**Architecture:** Optional repository/reader freshness delegation uses a repeatable-read local store query for one raw timestamp and one most recent completed archive. Modern archives verify scalar metadata inside PostgreSQL; legacy archives decode only the selected day. Defaults remain SQL. The cycle/today helper shares site/tariff context and today's raw samples within its request, preserving separate pricing calculations.

**Tech stack:** TypeScript, pg, Vitest; existing archive schema and checksums.

1. Add failing delegation and PostgreSQL tests: archived-only timestamp, raw/archive order, future rows, empty sites, corrupt summaries, legacy fallback and scalar transfer bounds.
2. Implement optional timestamp delegation and repeatable-read source selection. Do not fetch modern chart payloads or traverse history for freshness.
3. Add failing cycle/today tests proving identical independent netting with one site/tariff/today fetch. Preserve clamped ranges and arbitrary historical helper calls.
4. Share request inputs, run focused and full tests, lint, build and independent review. Use disposable synthetic PostgreSQL only for this checkpoint; remove it after validation.
5. Record transfer scope and remaining application activation/maintenance gates, commit; no PR, deployment, trimming or Tesla requests.

## Staged caller integration

Add `src/lib/energy-repo-factory.ts` with exact server-only `COMPACT_HISTORY_READS_ENABLED=true` opt-in; unset/false remain existing raw SQL. Connect mobile bill-summary, web usage and importer coverage audits using each already-loaded site's timezone. Preserve injected importer repositories when disabled. Test disabled defaults and enabled routing. This is a partial caller integration: live charts, TRMNL, analysis and setup paths still require mapping before activation. Do not set the switch in any environment yet. Full reader activation and raw trimming remain blocked on complete consumer/repair and egress validation.

## Checkpoint results

Implemented scalar freshness through the repository/reader/store. The store selects the newest completed archive and latest nonfuture raw timestamp in one repeatable-read transaction. Modern metadata is verified inside PostgreSQL, and no chart payload is returned. Legacy metadata decodes the selected day only. Corruption throws rather than supplying misleading freshness.

A synthetic archived-only test uses a full day with varying values, confirms the chart payload exceeds 1,500 bytes, and measures the complete freshness operation below 1,500 backend protocol bytes with two SELECT operations. This is an integrity/transfer regression bound, not a production traffic projection. Synthetic raw deletion is privileged fixture setup, not a production trim protocol.

Cycle/today calculations fetch site and historical tariff context once and share today's raw read. Costs still net independently. Tests compare the old independent calculations with the shared-input helper for normal site-local, historical, future, identical and reversed ranges.

The staged factory and importer tests prove default/raw compatibility, explicit opt-in routing, zero imports for complete archived coverage, and failure before imports on corruption. Remaining readers, long coverage ranges (the store currently caps requests at 366 days), maintenance/repair budgets and verified trim/recovery remain mandatory before enabling the switch. Both setup/has-data and stale power/SoC consumers still need mapping.

Independent review found no blocking issues. Validation passed: 1,094 tests (one skipped), lint, TypeScript check and production build. The disposable synthetic cluster was stopped and removed. No PR, production switch, production data mutation, Tesla call or deployment occurred.
