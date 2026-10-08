# Compact coverage and summary billing implementation plan

**Goal:** Let opt-in coverage/gap auditing and existence checks recognize archives, and calculate whole-day billing from verified summaries without retrieving archive payloads or overlapping raw samples.

**Architecture:** Add checksummed day metadata via a generated migration. Finalization persists coverage boundaries/gaps plus a digest of summary and coverage metadata. A repeatable-read billing snapshot uses verified summaries for complete days and decodes only partial-day boundaries. Existing archive snapshots remain the detailed integrity path. No default activation, importer behavior change, cron, repair fetch or deletion.

1. Write failing tests for archive coverage/gap-planner parity, no unnecessary refetch, real holes, partial ranges, DST, timezone mismatch and existence; add optional EnergyRepo delegates.
2. Generate additive metadata migration. Existing revisions with null metadata retain the decode path; finalizer retries rebuild metadata. Test digest corruption and archived-only full-day bills without payload decoding.
3. Implement checksummed metadata, summary-only billing snapshots, full/partial mixed ranges and source exclusion. Validate same local-day/site/version, summary counts and finite values in a coherent snapshot; preserve incomplete-attribution failures.
4. Run local synthetic integrations (raw rows retained; archive-only state simulated only in disposable synthetic fixtures), review, full suite/lint/build and commit. Document remaining production, repair, freshness and trimming gates.
