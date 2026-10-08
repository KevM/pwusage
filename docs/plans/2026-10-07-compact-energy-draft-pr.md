# Draft PR: Add opt-in lossless energy history archives and bounded maintenance

Historical energy currently uses one indexed row per five-minute sample. This change adds a versioned lossless daily chart archive, historical tariff-period energy summaries for on-demand billing, and opt-in history readers across web, mobile and TRMNL. Existing chart fidelity, original timestamps and tariff identities are preserved. Complete-day billing, coverage and freshness use small verified projections; chart payloads are transferred only when needed.

A preview-by-default maintenance command builds archives for an explicit site/date window, with 31-day range and seven-day apply limits, an editable recent-day buffer, contention handling and resumable reports. It reports missing samples and incomplete pricing without paid Tesla recovery. Finalization reconciles raw samples, chart decode and summaries before atomically storing a revision. Mutation locks and invalidation protect corrections; cleanup pauses once archives exist, including read-switch rollback and first-finalization races.

**This is a staged, raw-retaining change.** `COMPACT_HISTORY_READS_ENABLED` remains unset. No scheduled rollup, raw trimming, billing tiers or production rollout is enabled. Internal reviewed-revision trimming and lossless correction recovery are implemented and tested, but no trim command or route is exposed. Storage reclamation requires the remaining operator, backup and activation gates. Historical LoadTags remain retained once archives exist.

## Validation

- 1,166 tests passed / one existing test skipped, including isolated PostgreSQL persistence, corruption, concurrency, access-control and response-transfer tests. Lint and production build passed.
- All six migrations applied against an isolated source-table restore of the supplied October 2 production backup. Hosted migration CI is still required on the future PR.
- Separate backup parity validation: 30 sites, 150 windows, 77 nonempty archived days / 20,256 samples; exact chart, summary and coverage recovery, 77 unchanged retries, raw row count retained. One day remained explicitly incomplete for tariff attribution.
- Bounded maintenance sample: three sites / 90 days finalized, no raw deletion or Tesla calls. The pre-recovery-marker archive+summary allocation extrapolates to about 2.19 MB/site/year. Initial rollup response transfer averaged about 32.2 KB/day; completed 30-day repeat was about 4.8 KB/site.
- Measurements are bounded, nonrandom local fixtures, not hosted quota or capacity guarantees. Partial-day billing costs and maintenance transfer remain documented.
- Recovery rehearsal: five backup sites / ten days / 2,859 samples; exact chart, billing-input, coverage, restoration and late-correction checks. Database-side parity limits trim/restore response transfer to about 6.8 KB/day; no live production or Tesla access.
- Whole-branch persistence, reader and billing reviews found no blocking issues. Branch includes current `origin/main`.

## Reviewer focus and rollout

Review lossless format bounds, summary pricing parity and metadata digests; site/global lock order, invalidation and cleanup rollback; factory defaults and authorization; bounded maintenance, incomplete attribution and database egress.

See [maintenance results and operating guide](2026-10-07-compact-energy-maintenance-results.md) for commands, measured costs and activation gates. Verify hosted migration CI before merge, preserve the cleanup guard on rollback, budget a small explicit cohort before production archive creation, and prove controlled reader parity before enabling reads. Keep raw samples until correction restoration, recent raw-only consumers, trim integrity, paid repair budgets, backup/restore and first-trim approval are complete.
