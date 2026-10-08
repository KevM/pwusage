# Archive coverage and summary billing checkpoint

## Behavior

Opt-in EnergyRepo readers now provide archived-aware daily coverage and data-existence queries. Coverage reports observed counts, first/last timestamps and maximum interior gap using the same site-local-day and half-open range semantics as existing raw SQL. Existing gap-planner tests show that complete archived days do not cause refetches, and real holes remain visible. No automatic repair or Tesla call was added.

The additive metadata migration stores first/last timestamps, maximum interior gap and a SHA-256 digest alongside each archive revision. The digest covers site/day identity, attribution state, sample count, coverage and all tariff/schedule summaries. Existing revisions have null metadata and retain detailed decoding; finalization rebuilds their metadata on retry. The migration neither rewrites archives nor touches raw rows.

Complete modern days use only verified scalar metadata and summaries. The SQL query omits archive payloads and excludes overlapping raw rows in a repeatable-read snapshot. A separate payload query fetches only partial-day boundaries and legacy revisions; it is still issued even when it returns no rows. The reader verifies metadata before using totals, rejects corrupt or duplicate summaries, and refuses incomplete tariff attribution for billing. Coverage remains available for incomplete tariff days. Partial-day bills still decode and filter samples. Raw-only days still aggregate samples.

The previous raw-mutation and timezone triggers are load-bearing: they invalidate an affected archive atomically under the shared site lock. A repair therefore makes the next reader use corrected raw samples until a new revision is finalized. Privileged trigger bypass/replication mode breaks this protocol and is not a supported application write path.

Whole-day summary billing deliberately has an integrity boundary independent of the compressed chart payload. A corrupt chart payload does not prevent a bill when its separately checksummed scalar summaries remain valid; chart and partial-day requests fail. Tests prove this behavior, digest corruption rejection, null-metadata compatibility, archived-only coverage/existence and mixed ranges.

## Validation

Applied both generated migrations to a fresh isolated PostgreSQL 18.6 fixture restored from the user's October 2 production backup. As in the previous checkpoint, only energy/site/tariff tables and relevant application schema were restored; this does not substitute for complete Supabase restore rehearsal or migration CI.

Across **30 sites / 77 stored days / 20,256 samples**, archive recovery, daily totals and coverage matched the raw source exactly. Complete-day optimized snapshots returned no payloads or raw detail. All 77 retries kept the same revision; all raw rows remained intact. One day retains incomplete tariff attribution and cannot use archived billing.

Allocated archive + summary storage was **409,600 bytes**, approximately **1.94 MB/site/year** when extrapolated from this small sample. Metadata added 8,192 allocated bytes over the previous fixture measurement. This is not a production capacity guarantee: incomplete/non-random days, fixed relation allocation, and no lifecycle bloat remain limitations. The 2–5 MB/site/year planning range remains reasonable.

Synthetic database tests include modern metadata on 23/25-hour DST days, late-repair invalidation, corrupt summaries, unavailable chart payloads, partial reads, legacy fallback and archive-only existence. Archive-only state was modeled by truncating only synthetic raw fixtures; no production raw rows were deleted and no application trimming method exists.

## Remaining work

Default callers still use existing raw SQL. Latest timestamp/sample/SoC queries remain raw-only. Gap planning is now compatible with the optional reader but importer construction and budgeted repair scheduling have not switched. Higher-level multi-call responses still need a coherent revision policy. Full restores, migration CI against a production backup, opt-in app comparison and recovery rehearsal remain rollout gates.

Persisted metadata provides coverage evidence, not permission to erase detail. An approved future trimming path must bypass ordinary mutation invalidation only after verifying archive+summaries together; no such bypass is implemented. No deployment, default reader activation, Tesla fetch, tier change, cleanup change, notices or PR #126 change occurred.

## Verification

All 21 local database integration cases passed. Full suite with integration enabled: **1,069 tests passed, one existing skipped**. Lint, TypeScript checking and the production build passed. Independent review found no blocking issues; its suggested DST and late-repair tests were added and passed. Diff checks passed. The disposable local database was stopped and its restored/extracted production data removed. The user-provided backup remains intact.
