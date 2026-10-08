# Compact history remaining consumer implementation plan

**Goal:** Stage remaining application history readers and support bounded multi-year scalar coverage/billing without costly implicit historical recovery.

**Architecture:** Keep the exact server opt-in disabled. Each application consumer uses the already-loaded site's timezone. Scalar ranges split at site-local midnight into windows of at most 360 days, with a maximum of 32 windows per request checked before querying. Each window has its own coherent repeatable-read snapshot; long reads are not one cross-window snapshot. Detail reads retain the 366-day bound. Completed historical analysis dates do not implicitly fetch Tesla when archive reads are enabled; explicit force requests and current-day refresh retain the existing path.

1. Failing reader tests for multi-year coverage, billing and combined reads, DST-aligned contiguous windows, no duplicate dates, oversized/invalid ranges and failure propagation.
2. Implement scalar partitioning and preserve single-window behavior, metadata verification and limited projections.
3. Failing policy tests for disabled compatibility, current-day refresh, explicit force and historical no-fetch. Wire analysis, live, TRMNL, mobile planning and setup/has-data consumers behind the existing switch. Preserve auth checks and injected repositories.
4. Focused tests, review, full suite, lint and build. Document remaining stale-power/SOC, maintenance/repair and trimming gates. Commit without PR or environment changes.

## Verified checkpoint

The remaining history-consuming application views now use the opt-in factory, including SiteService setup checks and both live and historical analysis paths. Existing authorization precedes site data reads. Live-data requests preserve existing off-path parallelism; enabled reads reuse the already-loaded site's timezone. The switch remains unset.

Scalar ranges exceeding 366 elapsed days split into contiguous windows of at most 360 site-local days. A preflight maximum of 32 windows is a per-request work bound, not a retention cutoff. Intermediate boundaries are local midnights, so summaries and coverage dates occur once. Single-window reads preserve existing behavior. Every window has its own repeatable-read snapshot; corrections can happen between windows. An integrity failure rejects the entire operation without returning partial results. Large/legacy workload transfer still needs measurement before activation.

When enabled, completed historical and wholly future analysis days do not create a Tesla client or call ensureDataForRange merely because the page was opened. Current-day overlap and explicit force requests retain the existing sync path. Disabled mode preserves existing auto-sync behavior. Policy and route tests cover old/current/future/force cases and rejection before data access for unauthorized callers.

Validation passed: 1,111 tests (one skipped), lint and production build. PostgreSQL integration confirms multi-year reads preserve the archived day. Independent review found no blocking issues. The synthetic fixture was stopped and removed. No PR or deployment occurred.

Before enabling reads or trimming: finish stale-power/SOC boundary handling, replace the old cleanup endpoint with verified archival maintenance, preserve historical LoadTags, measure maintenance/repair and larger scalar workload transfer, bound repair/API costs, and verify recovery with backups. The current cleanup job deletes raw rows and invalidates corresponding archives; it must not be used as an archive-preserving trim protocol. Raw-only today refresh and battery monitoring remain deliberate current-data consumers while their boundary handling is evaluated.
