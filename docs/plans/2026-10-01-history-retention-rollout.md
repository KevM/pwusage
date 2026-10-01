# History retention rollout report

Prepared 2026-10-01. Code is on `codex/history-retention`, based on `origin/main`
`e9ca3f24` (including PR #125). Production cleanup is disabled by default.
No production history has been deleted, notices sent, migrations persisted,
exception assignments applied, or backup/restore performed by this implementation.

## Read-only production snapshot

Supabase project `gaflounoibsubfoducqz`, measured 2026-10-01 18:02–18:04 UTC in
`BEGIN READ ONLY` transactions with a 25-second statement timeout. Production
still lacks the entitlement columns, so these are hypothetical uniform-policy
counts, not an entitlement-aware activation preview. Re-run the maintenance audit
after the migration and cohort bootstrap, and again immediately before activation.

| Measurement | Value |
| --- | ---: |
| Database allocated bytes | 289,713,299 (289.7 MB) |
| EnergyData allocated bytes | 265,445,376 (265.4 MB) |
| EnergyData heap / indexes | 100,425,728 / 164,954,112 bytes |
| Energy rows, slightly later count | 837,803 |
| Retained rows if all owned sites use 90 days | 445,106 |
| Eligible rows under that hypothetical policy | 392,697 |
| Eligible LoadTags | 5 |
| Users / sites with samples in the last 7 days | 22 / 22 |
| Inactive-account energy rows / eligible at 90 days | 69,146 / 69,145 |
| Permanent tariff versions / seasons / schedules | 52 / 98 / 465 |

All energy in the earlier per-site snapshot was within 365 days. The observed
allocated energy cost is approximately 317 bytes/row including indexes. Counts
and sizes came from successive read-only snapshots while ingestion continued;
they are estimates, not a transactionally consistent backup inventory.

| Scenario | Approximate energy allocation | Plus current non-energy allocation |
| --- | ---: | ---: |
| Current rows retained with uniform 90 days | 141.0 MB | 165.3 MB |
| Same, with Harrison kept at 365 days | 149.3 MB | 173.6 MB |
| 18 continuously updating sites, mature 90 days | 147.8 MB | 172.1 MB |
| 18 continuously updating sites, mature 365 days | 599.5 MB | 623.8 MB |
| 22 continuously updating sites, mature 90 days | 180.7 MB | 204.9 MB |
| 22 continuously updating sites, mature 365 days | 732.7 MB | 757.0 MB |

Mature estimates assume 288 five-minute rows/site/day, the observed bytes/row,
and today's non-energy overhead. Each mature 365-day exception adds about
25.1 MB above 90 days. Permanent tariffs and other overhead can grow too.
Deleting rows makes space reusable; these estimates do **not** promise that
allocated database files immediately shrink. No blocking compaction is included.

No extended-history exceptions have been assigned. Harrison is an illustrated
candidate, not an approved production assignment. Its observed additional retained
rows would be 26,190 (approximately 8.3 MB today). Confirm explicit account IDs for
any exceptions before the first trim. Inactive accounts follow the same history
policy; User/Site parents and all tariff versions remain untouched. A separate
inactive-account purge and dev-copy filtering are outside this change.

## Safe cutover order

1. Keep `RETENTION_CLEANUP_ENABLED` unset/false in every target environment.
   Complete PR production-backup-to-dev migration verification before deployment.
   That existing workflow replaces dev's public schema/data and invalidates dev
   TRMNL installations; coordinate the run with other dev work.
2. Apply the generated migration before deploying code that reads the new columns.
   It marks every existing account transition-pending, preserving 365-day access.
   The pending=true database default also protects signups made by the old code
   between migration and deployment. It neither deletes history nor changes User
   RLS/grants. No new tables exist.
3. Deploy code with `HISTORY_RETENTION_POLICY_START_AT` absent, or set to a future
   zoned ISO timestamp for an agreed announcement/disclosure cutover. New Tesla
   signups before that timestamp also remain pending with effective 365-day access.
   Repeat logins preserve the stored entitlement. An invalid configured timestamp
   fails validation instead of silently reducing history.
4. Publish/disclose the 90-day policy for new accounts at the configured start time.
   After that timestamp, new accounts start at 90 days without a grace period.
   Confirm that every instance uses the same timestamp; do not move it backward
   before disclosure. This timestamp is distinct from cleanup activation.
5. After the cutover, enumerate **all** pending accounts, including accounts with no
   sites and accounts created between migration and announcement. Deliver the
   approved notice through a confirmed channel. Suggested channel: manual email
   to each account's verified contact address. Accounts without a deliverable
   address require a separately confirmed contact method. Keep them pending until
   notice is confirmed. Do not infer delivery from an attempted send.
6. Prepare an explicit JSON array of notified account IDs. Use the internal tool
   in preview mode with the actual notice timestamp. For a group, use the latest
   confirmed delivery time so everyone receives at least 30 days. Review the
   preview, then apply with `--apply --notice-delivered`. Apply any approved 365-day
   exceptions manually; these clear pending without a downgrade. Bootstrap is
   idempotent, preserves later grace, and excludes post-cutover new accounts.
7. Keep cleanup disabled through the notice/grace period. Imports and reads use
   effective 365 days during pending/grace; they switch to 90 exactly at expiry.
   Run the read-only audit with an `--as-of` after grace expiry to review the future
   trim. Verify no pending site accounts remain and all exception IDs are correct.
8. Before any trim, make and rehearse a recoverable backup as described below.
   Take a fresh entitlement-aware production audit and record eligible rows/tags,
   tariff inventory, database/table/index sizes, and backup checksum. Present that
   concrete preview and recovery evidence for first-trim approval.
9. Only after that approval, set `RETENTION_CLEANUP_ENABLED=true`. The existing
   daily cron processes bounded batches, prioritizes backlogs, and returns progress
   plus `workRemaining`. Pending site transitions block activation. Unknown policy
   aborts, unowned sites are skipped, and ownership/entitlement is rechecked under
   locks in each transaction. Disable the flag immediately if validation fails.
10. Recheck expired import requests cannot refill data, every tariff full value is
    unchanged, current-cycle billing still works, and the read-only audit converges
    to no eligible rows. Compare actual allocated sizes before/after; review any
    desired compaction separately.

## Notice draft — review before delivery

Channel proposed: manual account email. Dates and contact method must be filled
in before the notice is considered ready to send. This implementation sends none.

> We're updating how much energy history PWUsage keeps so the service can continue
> to run within its database limits. The standard history window will be 90 days.
> Your existing one-year history window will remain available until [grace end,
> including timezone], at least 30 days after this notice. After that date, energy
> samples and load tags outside the 90-day window will be removed. Older bills may
> show partial or unavailable history. All tariff versions will remain stored.
> If you need longer history, contact [confirmed contact method] before that date
> so we can review an extended-history exception. This change introduces no charge.

## Backup and recovery rehearsal — required before activation

The existing main-branch migration workflow creates a roles/schema/data archive
and uploads it to the configured backup storage. That migration-time archive is
not sufficient evidence of a fresh, tested pre-trim backup. No such backup has yet
been created or restored during this task.

For the first trim, schedule a maintenance window, keep cleanup off, and pause
history writers while taking a consistent application-data inventory and dump.
Use an explicitly verified production connection; never print the URL or commit
the dump (User rows contain credentials). Store the archive privately with a
checksum, timestamp, schema/migration version, record counts, and a tested path to
retrieve it. Separate captures assume no concurrent schema changes.

Installed CLI help and current [Supabase dump documentation](https://github.com/supabase/cli/blob/develop/apps/cli/docs/supabase/db/dump.md)
confirm these commands. They are instructions for the approved maintenance window,
not commands executed during implementation:

```sh
supabase db dump --db-url "$RETENTION_PROD_DATABASE_URL" --role-only -f roles.sql
supabase db dump --db-url "$RETENTION_PROD_DATABASE_URL" -f schema.sql
supabase db dump --db-url "$RETENTION_PROD_DATABASE_URL" --data-only --use-copy -f data.sql
supabase db dump --db-url "$RETENTION_PROD_DATABASE_URL" --data-only --schema supabase_migrations -f migration-history.sql
```

Supabase dumps exclude managed schemas by default. This is recovery coverage for
the application/public schema and migration state, not a complete Auth/Storage
platform backup. Keep any additional platform backup requirements separate.
Rehearse the restore into an isolated disposable database or explicitly approved
dev target; never test a restore on production. Use the existing CI restore
workflow as the starting point, make restore errors fatal, preserve/recheck the
original RLS/grants, and verify full FK relationships, row counts and tariff values.
Before restoring to a new Supabase project, prevent unintended default anon and
authenticated table grants as documented by Supabase. Existing data/API grants
must match the backup after restore. Record the successful rehearsal and checksum.

Recovery: first disable cleanup and pause writers. Restore into an isolated target,
validate it, and agree on restoring the removed EnergyData/LoadTag rows without
losing newer production data. A full database rollback can discard post-backup
writes and requires separate review. Granting 365 alone cannot restore deleted
history; Tesla may be unavailable and import retention prevents unrestricted refill.
Do not delete tariff records, accounts, or sites as part of recovery.

## Verification and outstanding operational checks

Local full-suite, lint and production build results are recorded in `task.md`.
Boundary tests cover current/partial/expired bills, extended history, grace expiry,
browser/site timezone crossing, zero-work expired analysis and bounded navigation.
The actual cleanup repositories passed rollback-only temporary FK fixtures: three
energy rows/three tags deleted, exact cutoffs kept, orphan skipped, failed batch
rolled back, idempotence verified, every tariff/parent full value unchanged.
The migration itself passed rollback-only checks against dev. No public rows or
schema changed. Those fixtures do not replace production-backup migration CI.

The opted-in dev egress trace covers six cold/warm web/mobile-live and mobile-bill
passes, preserving PR #125 query-summary parity. Its refresh mocks keep it read-only;
background imports are outside that trace. Imports now read one compact configured
policy/account/importer, evaluate grace with a fresh clock, and recheck policy in
bulk SQL writes. Web historical pages and analysis add one compact policy read.
Coverage still returns one aggregate/day, with no raw timestamp enumeration.

Pending before rollout: production-backup migration CI (requires a pushed draft PR),
real restored-schema FK validation, exception IDs, disclosure/notice delivery,
cohort bootstrap, a fresh recoverable backup and successful restore rehearsal,
fresh activation preview and first-trim approval. Cleanup stays disabled until then.
No native code was changed: the native bill endpoint requests only the current
cycle, whose at-most-31-day range fits within either retention entitlement.
