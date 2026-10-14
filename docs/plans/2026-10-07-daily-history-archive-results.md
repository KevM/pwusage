# Daily archive validation

## Hosted Dev rehearsal

Applied the generated control/retry migration to PWUsage Dev only. Dev and Prod
both report PostgreSQL 17.6; transaction-wide timeout support was verified against
PostgreSQL 17 documentation. No production data, switches or migrations changed.

The dotenv-first rehearsal refuses production by checking the known Dev project
reference. Selected one previously archived, raw-retained Harrison day: August 1,
2026 (site-local), 288 samples. Exercised the new daily job service and repository
using an explicit one-site/one-day cohort and a one-day/45s/4MiB admission budget.

- Archive finalization and exact reviewed-revision trim succeeded.
- Chart samples, tariff-period billing inputs and coverage matched the baseline.
- Historical tags remained identical.
- A repeat found no pending day; persisted pause prevented subsequent work.
- Whole-day restoration recovered all 288 original samples exactly.
- A second trim followed by a one-row correction restored untouched samples and
  preserved SoC; the correction was then reverted to the original values.
- Restored/rebuilt the archive and left the control paused, trim disabled, cohort
  empty. Final database check confirmed **zero pruned days** in Dev.
- No Tesla calls. Admission reservation: 821,074 bytes. This is an estimate, not a
  measurement of hosted provider network accounting.

CLI: `npx tsx scripts/rehearse-history-archive.ts SITE_ID 2026-08-01 2026-08-02`.
A paused initial control and retained raw samples are required. Connection details
and source samples are not emitted or committed. The rehearsal executes the same
service/repository used by the cron; HTTP authentication is covered by route tests.
No production activation or preview-reader environment mutation was performed.

## Private PostgreSQL verification

Disposable synthetic PostgreSQL 18 fixture, private Unix socket, never falls back
to DATABASE_URL. Tested exact gap/sample/chart/billing/coverage recovery, tags and
tariffs, explicit site/date cohorts, ownership, retention/DST boundaries,
concurrent claims, default pause, transfer admission, archive-only repeats,
persistent exponential retry, daily-cadence fresh/retry fairness and waiting-retry
rotation. A deliberately delayed archive insert exercised whole-transaction
termination: no partial archive committed and all raw samples survived. Connection
termination is handled without an uncaught error.

Protocol-meter integration checks actual local backend response bytes for a
288-sample daily archive/trim against the conservative reservation, and bounds a
completed repeat below 32KiB. This includes the local response protocol and
connection setup observed by the meter, excluding TLS/provider accounting.

Independent code review found and prompted fixes for retry starvation at daily
cadence, missing deadline admission checks, and missing date-option values that
could broaden an operator cohort. Regression tests cover those cases.

## Activation limits

The job is disabled by default in deployments and paused/empty by default in the
migration. Hosted CI/preview checks are separate from these local/Dev results.
CI restores production into Dev when migration files change, so future CI runs
reset this Dev cohort. A fresh backup, hosted egress-budget review, controlled
reader verification and explicit first production trim approval remain rollout
steps. This change does not implement account-specific 90/365-day tiers.

Final local verification: 1,197 tests passed, one existing test skipped; lint and
production build passed. Follow-up independent review found no merge blockers.

CI follow-up: test fixtures now use explicit result types and `NODE_ENV` with
the locked dependency versions. The preview project enforces a 60s function
limit, so the route and claim timeout now use 60s with a 30s admission budget
(the earlier Dev rehearsal used 45s). Local verification with locked dependencies
passed: 1,131 tests, 68 skipped without the disposable PostgreSQL socket, lint,
type checking and production build. Hosted migration verification also passed.
