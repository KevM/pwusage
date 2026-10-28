# Automatic history onboarding: agreed direction and open design

Discussion recorded October 27, 2026. This document captures product direction;
no new automatic backfill worker is implemented in this change.

## What exists today

- Today refresh fetches today and, while necessary, yesterday's tail.
- The scheduled gap healer normally checks the last 14 complete local days.
  After re-authentication it can reach back to the recorded loss day, and an
  idle recovered site qualifies without another dashboard visit. Recovery gets
  a 14-day retry window after access returns, with the existing per-site window
  cap and shared invocation deadline. It does not refill every site's older
  history or automatically revisit settled `gapped` records.
- `/api/sync` imports missing data for a requested range through the importer.
  Viewing history can therefore import older missing days on demand; it is not
  an installation-to-present background crawl.
- `scripts/backfill-compact-from-tesla.ts` is an operator-run day importer. It
  takes an explicit range and fetches energy plus SOE. Its existing skip rule
  covers settled empty days; it is not yet a fair, budgeted onboarding worker
  that skips every already-stored day and tracks progress automatically.

## Agreed goals

1. Include **both new and existing sites** with missing older history.
2. Prioritize the **latest N days** so new users get useful recent history and
   forecasting quickly, then work backward toward installation.
3. Eventually attribute the site's whole stored history to tariff schedules.
4. For now, use the **currently configured tariff's rules at each sample date**.
   This does not assert that a newly imported tariff is the historically correct
   price for every old date. Effective-date UX and historical tariff uploads do
   not exist yet. When added, they should trigger bounded re-attribution of the
   affected records from stored samples, without refetching Tesla data.
5. Keep open the option of monthly/yearly derived rollups as the user count and
   long-range read cost grow.

## Proposed implementation to discuss

Use one background onboarding flow with two priorities: recent missing days,
then older missing days, newest first within each phase. A proposed default is
**N = 28**, matching Smart Shift's household-history input; the final N and the
global request budgets remain implementation decisions. Account for the current
billing cycle if it starts before that recent window.

The worker should select only sites with usable auth, resume across runs, and
share request and wall-clock budgets across all sites rather than multiplying
a per-site allowance by the number of new users. Energy plus SOE typically
means two history requests per fetched day. Respect existing import/mutation
locks, stop/back off on throttling, and pause unavailable sites until recovery.
Returning auth must resume progress rather than restart a large crawl.

Use stored day records as the source of truth for what exists. Skip already
fetched settled days and settled empty days; leave retrying recent open days to
gap healing so the workers do not duplicate paid work. Honor `installed` and
`history_backfill_from` as lower bounds. The latter records the confirmed empty
pre-provisioning stretch; do not repurpose it as a moving progress cursor.

Fetching missing samples and repairing attribution on existing samples are
different work queues. The latter needs DB work only, with revision guards and
per-day atomic summary/checksum replacement. Both should expose progress and
pause reasons in monitoring. History onboarding need not block sign-in.

## Rollups

Day-level per-tariff summaries already exist in `EnergyDaySummary`. First measure
whether those serve long-range reads cheaply enough. Monthly/yearly summaries
would be derived caches for charts and totals, not the only copy of history.
Keep the day payloads so future tariff corrections can be applied losslessly.
Re-attribution must invalidate/rebuild affected derived rollups.

Preserve tariff/version boundaries and the billing netting rules when designing
larger rollups. Monthly totals alone cannot replace the time-of-day inputs used
for forecasting; a rolling recent history or separate slot-level features still
need to support those reads. Choose larger rollups from measured costs rather
than forcing that schema change into the first onboarding worker.
