# Compact archive boundary and maintenance implementation plan

**Goal:** Read latest power/charge across archived boundaries without chart egress, and make legacy cleanup safe while compact reads are staged.

**Architecture:** Add a tiny independently checksummed latest-sample/last-nonnull-SOC projection on each archive. It is derived from the same verified lossless samples and binds site/day bounds/archive checksum. Normal freshness transfers scalar metadata; as-of within a day or legacy power needs at most two candidate day archives. SOC legacy metadata must be rebuilt rather than scanning archives. Preserve source timestamps so stale SOC stays stale in existing consumers. Finalizer writes projection atomically and repairs it on retries. Keep archive mode off; legacy cleanup skips destructive energy/tag deletion when archive reads are enabled or any archives exist. A shared global maintenance claim in finalization and an exclusive claim around cleanup guard/deletions protect first-finalization races and read-switch rollback.

1. Generate migration; tests for projection integrity and repository delegates before implementation.
2. Store projected latest sample and SOC with archive finalization; query raw and archive candidates in repeatable-read transactions, honor as-of/since bounds and nulls, verify checksums, measure scalar transfer on private synthetic PostgreSQL.
3. Test cleanup authorization/default compatibility and compact-mode no-deletion; add guard. No raw trim or Tesla repair activation in this checkpoint.
4. Review, full tests, lint, build and local fixture cleanup; commit without PR or environment changes. The next maintenance stage remains bounded raw-retaining finalization/repair and verified trim/recovery protocol.

## Boundary checkpoint behavior

Latest power and last known battery charge now have a small JSON projection on each archive, independently protected by a canonical CEL1 binary digest. The digest binds site, day bounds and archive checksum, then fixed-width sample timestamp/values and nullable charge fields; JSON key order does not affect it. Chart samples remain lossless. The latest sample may have null charge, while the last known charge retains its original timestamp so existing freshness rules still apply.

Modern latest-power queries transfer at most two candidate projections and one raw sample. Historical as-of boundaries or legacy projections can decode at most two candidate days. Candidate selection does not trust unverified first-sample coverage metadata. Last-known-charge queries verify every relevant projection inside PostgreSQL before selecting by its indexed charge timestamp; only the chosen projection is transferred. Legacy charge projections require finalization rebuild before activation, rather than scanning chart archives. Finalization retry upgrades missing or corrupt projections while raw data remains available.

Synthetic full-day tests with a chart archive larger than 5,000 bytes bound latest-power transfer below 3,000 backend protocol bytes / two SELECTs and last-known-charge below 3,000 bytes / three SELECTs. These are local regression bounds, excluding hosted accounting, transport overhead and endpoint work. New projection/index storage overhead has not yet been measured against the production archive; earlier per-site storage estimates require remeasurement.

The cleanup route skips when compact reads are enabled. Otherwise its transitional store operation takes a nonblocking exclusive transaction-level maintenance claim, checks archive existence and deletes legacy energy/tags together only if no archives exist. Finalization takes the corresponding shared claim before its site claim, so first finalization and cleanup cannot race. Once any archive exists, cleanup stays paused even if reads are switched off. Busy maintenance also skips safely. Missing migration tables or errors fail closed and roll back deletions. This does not implement archive-preserving trimming or a recurring rollup job.

Next: bounded raw-retaining finalization/repair with maintenance egress measurements; preserve useful historical LoadTags; then verified trimming, recovery rehearsal and activation review.

Validation: 1,127 tests passed / one skipped, lint and production build passed. Review findings (unverified as-of coverage predicate and first-finalization cleanup race) were reproduced/fixed and independently re-reviewed. Disposable synthetic cluster removed; supplied backup zip retained. No PR or environment/deployment changes.
