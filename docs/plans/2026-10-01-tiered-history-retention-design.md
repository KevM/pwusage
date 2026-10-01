# Tiered history retention design

Approved by the user on 2026-10-01, including manual extended-history assignment and
a 30-day downgrade grace period. The user subsequently deferred premium-tier UX
and monetization; the first version uses internal settings only. This is a design, not a deployed policy.

## Policy

- Default accounts retain 90 days of five-minute energy readings.
- Existing accounts currently receive 365-day retention. The first rollout must
  give them notice and a 30-day transition window before trimming to 90 days.
  New accounts after the announced policy starts receive 90 days immediately,
  with that limit disclosed. A database default alone does not grant existing
  users a transition window; bootstrap their grace expiry explicitly.
- Accounts explicitly granted extended history retain 365 days. Assignment is
  manual through an internal database setting or maintenance script.
- The account retention setting applies to all sites owned by that account.
- Removing extended history immediately changes the setting to 90 days, but preserves the 365-day
  retention window for 30 days. Repeated 90-to-90-day saves must not extend
  the grace period. Regranting extended history clears pending downgrade expiry.
- Granting extended history does not promise that deleted data immediately reappears. Explicit
  history requests can backfill within the newly allowed window, subject to
  existing Tesla throttling, import locks, and request budgets.
- Tariff, TariffSeason, and TariffSchedule records are never deleted by retention,
  including versions with no remaining energy references. Do not delete parent
  User or Site records as a shortcut: cascading deletes can destroy tariffs.
- LoadTag records expire when their end_time precedes the same site cutoff.
  Account settings, site settings, TRMNL installations, and battery holds are
  outside this cleanup's scope.

## Architecture

Store history_retention_days (90 or 365), downgrade-grace expiry, and
history_retention_transition_pending on User. The migration marks only existing
accounts pending; while pending, their effective window remains 365 days. New
accounts inserted by old code also default to pending=true, bridging the
migration-to-deployment interval. New auth code explicitly sets pending=false
only after HISTORY_RETENTION_POLICY_START_AT has been disclosed and reached. Notice bootstrap clears pending and seeds
grace; granting 365 clears pending as an explicit exception. This protects
existing users before notice/bootstrap even though their configured default is 90.
Default existing and new accounts to 90; grant known exceptions before enabling
deletion. No new admin screen, tier-selection API, payment integration, upgrade
prompt, or premium-facing interface is included.
Read entitlement from the database, not stale JWT claims. Keep paid billing out
of this version. Keep the existing authentication roles separate from tiers.

One retention policy helper computes the effective days and cutoff from configured retention days,
grace expiry, site timezone, and a captured clock. Align to site-local midnight
so Tesla day-sized requests and cleanup agree. Document that this can preserve
less than one additional local day beyond the nominal rolling period.

Invalid retention settings or failed entitlement reads must abort destructive cleanup rather
than silently choosing the shorter period. Unowned sites are skipped and reported
until ownership is resolved. No inactivity-based deletion is included here.

## Enforcement

### Compatibility with landed sync-egress work

PR #125 (e9ca3f241aecbf362a666c7e8fe96f6851bfbf3c), merged 2026-10-01,
replaces getExistingTimestamps with getDailyCoverage: the SQL query returns one
coverage summary per site-local day, and auditDays/planImport consume those
summaries. This is query-time aggregation, not a persisted rollup table, and
does not itself reduce stored EnergyData. Start implementation from a revision
containing that change; the checkout used for the initial plan predates it.

Clamp the retained range before BOTH getDailyCoverage call sites:
ensureDataForRange and auditRange. Apply the identical clamped range to
planImport/auditDays/generateDayWindows so deliberately expired days never become
empty-day repair candidates. Return an explicit terminal retention result for
fully expired requests; callers must not repeatedly retry them as busy/partial
imports. Preserve the strict >30-minute hole threshold, site-local keys,
installation-date clipping, effective end-of-today, and 23/25-hour DST windows.
Never reintroduce raw timestamp enumeration for coverage or retention metadata.

Read compact retention fields alongside existing authorized account/site reads
where practical, with request-level reuse. Do not fetch full User rows, tokens,
or the tariff tree just to decide retention. Account-setting mutations must
invalidate any entitlement caches; grace expiry is evaluated with the current
clock. Pin query counts and returned row counts for repeated sync attempts,
including expired and cutoff-crossing requests, and preserve existing live/bill
egress baselines. Re-run the real-Postgres differential gate if the coverage SQL
changes; a mocked unit test cannot verify that SQL.

Daily cleanup deletes only eligible EnergyData and LoadTag rows in bounded batches.
Historical sync and import paths clamp their requests to the same cutoff before
planning Tesla calls. All persistence paths apply the cutoff again, including
requests crossing local midnight, forced imports, and long-running imports during
a downgrade. Never treat deliberately expired days as gaps needing repair.

History responses expose the earliest allowed date and whether a requested
period is outside retention or only partially retained. Web navigation respects
that boundary. Existing mobile consumers must not mistake missing history for a
complete zero-usage bill; review the response contract and native UI before rollout.
The current billing cycle fits inside 90 days; the oldest available historical
cycle may be incomplete and must be labelled accordingly.

Keep historical tariff resolution across all versions. Reconcile the obsolete
"raw history kept forever" statement in DesignDecisions.md without changing the
no-SOC/no-genesis battery provenance decision.

## Capacity and rollout

The 2026-10-01 read-only audit measured production at about 289 MB, with 836,586
EnergyData rows occupying about 265 MB including 165 MB of indexes. These allocated
sizes are estimates, not compacted row-size guarantees. At this observed allocation,
18 continuously updating sites project to about 148 MB for 90 days or 600 MB for
365 days, excluding other database overhead. Each extended-history site adds roughly 25 MB
over default. Extended-history growth therefore still needs a storage budget.

First produce a read-only dry-run showing configured days, cutoff, eligible row counts, and
estimated retained rows per site. Preserve a recoverable backup before the initial
production trim. Validate imports, billing boundaries, tariff preservation, and
deletion behavior in dev, then activate production cleanup. Re-measure actual
database/table/index sizes after cleanup; deletion alone does not guarantee an
immediate reduction in allocated files. Any blocking compaction is a separately
planned operation, with disk headroom and downtime assessed first.

Before enabling the new cleanup policy, establish the existing-account cohort,
assign manual 365-day exceptions, publish the retention notice, and initialize
each remaining existing account's grace expiry to 30 days after its notice.
Reuse the same effective 365-day window during this transition for imports,
history availability, and cleanup. Make bootstrap idempotent: rerunning it must
not extend expiry, and it must not shorten a later legitimate grace period.
Keep cleanup disabled until all affected accounts have a recorded transition
window and the notice has been delivered. Notice delivery is separate work;
this plan does not authorize sending messages to users. After expiry, only old
energy readings and associated expired tags are eligible for deletion.

Dev's obsolete rollup/history jobs have already been removed and their history
cleared. Because Supabase rejects the cron.log_run configuration override, a
dev-only daily job truncates cron.job_run_details at 03:07 UTC. This operational
cleanup is separate from account retention. Dev filtering and log-ingestion
monitoring remain separate workstreams, not bundled into this implementation.

## Verification

Test retention defaults, manual assignment safeguards, grace expiry and repeated
downgrade saves, timezone/DST boundaries, import refusal outside retention, forced
imports, exact cutoff preservation, and partial historical billing. Run a dev
integration fixture with expired readings and unreferenced historical tariffs;
cleanup must remove only eligible readings/tags and leave every tariff version,
season, and schedule byte-for-byte intact. Verify migration applicability using
the repository generator and dev workflow. Run lint, full unit tests, and build.
