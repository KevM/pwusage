# Daily archive operations

The `/api/cron/cleanup` URL and daily schedule are retained, but the legacy energy
and LoadTag deletions are permanently retired. The replacement requires both
`HISTORY_ARCHIVE_JOB_ENABLED=true` in the deployment and an unpaused database
control. The migration starts paused with an empty site cohort. No production
switches were changed during implementation.

## Controls

From `cmd/next-app`, these commands load `.env` before database imports. Verify
that `.env` points to the intended environment. Cohorts are explicit (1–100 owned
site IDs); changing mode replaces the cohort. Optional paired `--from` and
`--before` local dates bound the cohort; the end is exclusive. Missing or
malformed date arguments fail before database access. There is no public mutation API.

```sh
npx tsx scripts/control-history-archive.ts status
npx tsx scripts/control-history-archive.ts pause
npx tsx scripts/control-history-archive.ts archive SITE_ID
npx tsx scripts/control-history-archive.ts trim SITE_ID --from 2026-08-01 --before 2026-08-02
```

`archive` verifies and retains raw samples. `trim` additionally requires
`COMPACT_HISTORY_READS_ENABLED=true` locally and in the running deployment.
The rollout switch also selects the bounded archive-aware write path. With this safety follow-up, a pruned site always uses archive-aware reads and writes even when the rollout switch is off. Backend selection and raw operations share a per-site transaction lock, so even the first trim cannot race a flag-off read or write. That protects against empty history and failed corrections; turning off the switch is still not a storage rollback. Pause stops further
phases; an already-running transaction can finish. Each phase locks and verifies
the full control row revision, including cohort and date edits. A control edit
waits for the admitted phase, and the next phase stops with `control-changed`. A deployment flag change
requires a deployment; the DB pause is observed by running jobs between phases.

The report stores each bounded run's outcomes and transfer reservations in
HistoryArchiveControl; failed-day reason codes, attempts and next retry persist
in HistoryArchiveRetry. No SQL errors or raw samples are logged. Daily cron logs
only aggregate outcomes. A failed day is delayed 15 minutes initially, doubling
to a maximum 24 hours. Fresh days and due retries alternate slots, falling back
to the other class when empty. Due retries are ordered by retry deadline,
so reattempted permanent failures move behind other waiting retries. With a one-day budget fresh days get priority;
use at least two slots to make retry progress during a continuing fresh backlog.
Busy days are retried rather than making Tesla requests. Incomplete attribution
is archived losslessly and retains raw samples until attribution can be resolved.
Gaps remain explicit and do not block preservation of the available samples.
An oversized day is recorded for retry and stops that run with `byte-budget`.
If claim cleanup fails, the connection is discarded and a generic warning is
logged; saved progress or the original work error remains the result.

## Budgets and cutoff

- DATA_RETENTION_DAYS: positive integer, default 365, maximum 36500.
- HISTORY_ARCHIVE_MAX_DAYS: default 2, maximum 7 attempted days.
- HISTORY_ARCHIVE_MAX_TIME_MS: default/max 30000 milliseconds.
- HISTORY_ARCHIVE_MAX_ESTIMATED_BYTES: default 4194304, maximum 67108864.

The cutoff is site-local midnight minus the configured calendar days. Only whole
days ending at or before it qualify. A two-completed-day recent buffer always
applies, even with a shorter configured retention. Unowned sites are excluded.
Archived history has no automatic expiry. Tags and tariff versions are preserved.

Time is a phase-admission budget, checked after discovery/preflight and before
finalization/trimming. Dedicated discovery/control statements time out at 15s;
archive and trim transactions have a **whole-transaction 15s timeout** as well as
existing statement/lock timeouts. The job may exceed the elapsed budget while an
admitted phase and final progress reporting finish; the route allows 60s to fit
the project's current Hobby deployment limit. The 30s admission budget leaves
room for an admitted 15s transaction and progress reporting. Pool
connection/network delays remain outside a guaranteed wall-clock deadline.
This requires PostgreSQL 17+. Verify per environment rather than assuming; the
preflight below also confirms `transaction_timeout` is actually settable through
the pooler, which a version check alone does not prove:

```sh
npx tsx scripts/check-archive-preflight.ts
DATABASE_URL='<prod-url>' npx tsx scripts/check-archive-preflight.ts
```

It is read-only and checks the server version, that `SET LOCAL transaction_timeout`
applies inside a real transaction, that `pg_try_advisory_xact_lock` survives
Supavisor transaction pooling, that the archive tables and control row exist, and
how many days are already pruned. It exits non-zero if any check fails.
See [transaction timeout documentation](https://www.postgresql.org/docs/17/runtime-config-client.html).

Transfer is a conservative **admission estimate**, not a provider-network hard
cap. Discovery sends only one candidate, and preflight sends scalar sizes of
raw samples, existing archives/summaries and the site's tariff tree. Reserve
32KiB per attempted day for control/progress plus 64KiB, twice the textual source
sizes and 2048 bytes per sample for archive/summary/framing work. Source growth
between preflight and mutation, connection setup, TLS/provider overhead and
external callers can exceed reservations. A day larger than the entire budget
gets a safe retry record so it does not monopolize discovery. No sample or chart
payload is fetched by preflight. At most 4096 raw samples are admitted per day.

## Dev lifecycle and production activation

Apply the generated migration before enabling the deployment switch. CI's
migration gate restores production into Dev, invalidating previous Dev fixtures;
wait for that gate before creating a cohort. Preview a selected cohort using the
existing `maintain-compact-history.ts` CLI. Then enable archive-only for that Dev
site, invoke the authenticated cleanup route, and inspect progress/retries and
exact chart, coverage and billing parity. Repeat to confirm successful days skip.

Enable compact reads only in Dev, select trim mode, invoke the route and verify
raw removal with exact archive-backed parity. Rehearse pause, resume, delayed
retry, partial late corrections and exact whole-day restoration. Pause the job
and restore pruned Dev days before changing reader flags or discarding fixtures.
Do not use the old cleanup methods to prune.

Production: finish that hosted rehearsal, review the actual hosted egress budget,
preserve a fresh recoverable backup, select a small explicit cohort and obtain
first-trim approval. Deployment alone leaves this job disabled and paused.
Subsequent expansion and any change to retention settings are separate operator
choices; this does not enact the previously deferred 90/365-day account tiers.

Raw-only consumer review: web/mobile/TRMNL history, analysis, billing, load
planning and importer coverage use the compact repo factory when enabled.
Today refresh and battery monitoring intentionally use recent raw rows and are
protected by the buffer. Admin UserRepo.last_data_import still reflects the last
raw import and can become null for an inactive site fully archived; this is an
admin timestamp limitation, not a history reader. Restore all pruned days before
disabling readers or deploying pre-guard code; restore through the reviewed
revision protocol, never direct insert/delete.

The run-wide claim lives inside a read-committed transaction, pinning the
backend through Supabase transaction pooling. Its reads see committed pause
changes. Retry/progress writes use separate short transactions, so rollback of
the claim on release does not undo progress. The claim transaction times out
after 60 seconds; a disconnected worker releases the lock automatically.


## Retention transition and capacity gate

Deploying this replacement intentionally stops legacy deletion immediately,
even when the new job remains disabled. `DATA_RETENTION_DAYS=180` was observed
in the reviewer's local `.env`; that is not evidence of production settings.
Record the actual production value before choosing any cutoff. The unset default
is 365 days. No account-tier retention change is included here. LoadTags and
all historical tariff versions remain permanent; summary FKs intentionally
prevent deletion of tariffs used by history. Normal tariff saves append versions.

Archive-only adds archives but does not reduce raw storage. Disabled/paused or
undersized jobs do not enforce a storage ceiling. The once-daily cron processes
**two site-days total** by default, at most seven, with retries sharing those
slots. A cohort of N continuously reporting sites produces about N eligible
site-days per day after the retention window. Effective successful trims/day
must exceed N to drain an existing backlog; matching N only maintains it.
The 30s/byte budgets can make actual throughput smaller than the day limit.
For example, 22 reporting sites cannot be maintained by this single daily job
at its current maximum. Do not expand to that cohort without measured capacity
and an additional reviewed execution schedule/worker design. Selected one-day
canaries and manually invoked bounded catch-up runs are appropriate during
rehearsal; they do not prove fleet-wide sustainability.

Before activation record eligible backlog, oldest eligible day, incoming
site-days/day, successful archives/trims/day, retries by reason, measured egress
and database/index size. Inspect `last_report`, not only HTTP 200: an individual
failed day is persisted and can coexist with a successful route response.
Alert when backlog age or storage grows across daily runs, a day keeps failing,
or the run regularly hits a budget. PostgreSQL deletion need not immediately
shrink the allocated database file; measure both retained rows and allocation.

## Reviewed bounded recovery and rollback

The recovery command loads `.env` before database access. Check the environment
identity, pause the job and keep an archive-compatible deployment throughout
recovery. Preview is read-only and returns at most seven explicit revisions:

```sh
npx tsx scripts/control-history-archive.ts pause
npx tsx scripts/restore-history-archive.ts preview SITE_ID > restore-plan.json
# Review site IDs, UTC day starts and revision IDs in restore-plan.json.
npx tsx scripts/restore-history-archive.ts apply restore-plan.json
```

For a complete storage rollback, use `preview --all` and review/apply each
bounded batch until `remainingPrunedDays` is zero. Preview output can be passed
unchanged to apply. An empty preview is the completion check, not an apply plan.
Every apply validates all plan entries before mutation, requires a paused DB
control inside each transaction, and calls the revision-checked lossless restore
protocol. Changed/missing revisions or corrupt payloads fail closed. Busy days
or the 30s phase-admission budget stop the batch with exit code 2; earlier
successful days remain committed. Obtain a fresh preview before retrying,
because restored archives are removed. Each admitted transaction has a 15s
whole-transaction limit. Resume/control edits serialize with recovery.

Before the first trim: pause and turn off the rollout switch if needed; raw
history remains available. After any trim: pause, keep archive-compatible code,
restore all pruned days and verify exact chart/coverage/billing parity plus
`remainingPrunedDays=0` before deploying raw-only/older code. Disabling the
switch on this version preserves archive access for pruned sites; it does not
remove archives or substitute for restoration. Do not bypass raw mutation guards.

Archive-aware imports retain the existing 4096-row, seven-site, seven-day
transaction bounds, including when pruned sites force this path. Importer day
windows fit these bounds. Larger external maintenance batches must be explicitly
split into bounded requests; integrity errors must not fall back to raw writes.
Late added samples restore the whole pruned day atomically with the correction,
invalidate its old archive, and can be finalized/trimmed again.

## Missing pricing

An archived day with incomplete historical tariff attribution remains losslessly
readable and is never trimmed. Billing returns explicit pricing unavailability
for the requested period: web usage shows an explanatory state, mobile summary
returns `currentBill.status=incomplete-attribution`, null `estimatedCost`, empty
periods and null load timing, and TRMNL keeps its live/charts while showing `--`
and “Pricing unavailable” when its bill component is selected. No numeric partial
bill is presented as complete. Integrity/checksum errors remain errors: all full-day metadata and partial-day payloads are validated before missing pricing is reported. A missing-pricing day cannot mask corruption elsewhere in the same requested window.
Correct the historical source attribution explicitly; never invent tariff IDs
or loosen trim eligibility to clear a retry.

## Required release sequence

1. Deploy with job disabled and DB control paused. Require the complete synthetic
   PostgreSQL test suite in CI (`npm run test:compact`); do not accept skipped
   losslessness tests as evidence. The runner uses a private 0700 Unix socket,
   PostgreSQL 17+, synthetic data and no TCP listener or hosted credentials.
2. After the prod-to-dev migration gate finishes, rehearse archive-only, mixed
   complete/missing pricing, retained/raw parity, cohort edits, late insertion,
   corruption rejection, trim and reviewed restore in Dev.
3. Confirm production retention setting, fresh recoverable backup, storage and
   egress headroom, and successful throughput for the proposed cohort. Start
   production archive-only for one explicit old day; retain raw and compare.
4. Enable the rollout switch and validate all web/mobile/device/import consumers
   for 24–48 hours, including missing pricing. Measure the additional bounded flag-off storage-selection transactions and lock contention; raw queries execute on the same connection as their selection lock, avoiding pool exhaustion. Drain older deployments before
   trimming; this safeguard cannot retrofit already-running pre-guard code.
5. Obtain the separately required first-trim approval for one site/day. Trim,
   pause, compare every consumer and restore the reviewed revision. Only expand
   after recovery and sustained capacity are demonstrated.

No hosted activation or production trimming was performed by this follow-up.
