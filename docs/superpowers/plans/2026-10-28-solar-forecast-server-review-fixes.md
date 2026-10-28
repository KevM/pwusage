# Solar forecast server review fixes — implementation handoff

Date: 2026-10-28
Status: ready for implementation; no fixes have been applied by this plan.
Suggested executor: GPT Sol 6.1, medium reasoning. Execute sequentially; no subagents required.

## Goal and scope

Fix three correctness issues in merged PR #244, reconcile its parity evidence with the original plan, and make the Dev smoke test reproducible. Keep the existing detector algorithm, authorization model, mobile version-1 response shapes, and provider-independent geometry contract.

Reviewed baseline: PR #244 merge `156004996811ccacde5254d701326667a883246a`.
Review evidence: 66 tests across 12 targeted files passed; the fractional-offset date bug and false-complete-hour bug were independently reproduced. Private research parity and deployed smoke tests were not rerun. Those passing tests do not cover the reported regressions.

Read before editing:
- Root `AGENTS.md`, `Authentication.md`, and `docs/voice-and-terms.md`.
- `docs/superpowers/specs/2026-10-27-auto-solar-forecast-design.md`.
- `docs/superpowers/plans/2026-10-27-auto-solar-forecast-server.md`.
- PR #244 description for reported parity results and deviations.
- PR #247's latest iOS plan for the consuming contract; it is on a separate PR branch and may not yet be on main.

Do not implement the iOS plan, add providers, tune fitting thresholds, change forecast correction, grant production roles, or enable production rollout in this task. Do not treat research data as fixtures. Use synthetic data only in committed tests.

## Execution and completion rules

- Start a new branch/worktree from current main. Inspect existing work first; do not reset, stash or overwrite unrelated changes. Reconfirm that the affected functions have not changed since review.
- Active app is `cmd/next-app`; paths below are relative to it unless marked repo-root.
- Work through Tasks 1–5 in order. For each code fix, write the regression first, demonstrate failure, implement the smallest fix, then demonstrate success.
- Use explicit types; no TypeScript `any`. Reuse the project's repository and test conventions.
- No schema change is expected. If one becomes necessary, use `npm run db:migration:create <name>`; do not hand-create a migration.
- Commit verified changes with conventional messages and open a draft implementation PR. Distinguish code verification from uncompleted private-data/deployment checks.
- Missing research data or Dev credentials blocks only the corresponding validation step, not the local fixes. Never claim that blocked validation passed.

## Task 1 — Retry insufficient-history sites after 24 hours

**Files:** `src/lib/solar-layout-repo.ts`, `src/lib/solar-layout-repo.test.ts`; add a disposable-Postgres behavior test/harness using the patterns in `scripts/dev-copy-scripts.test.ts` and `scripts/test-dev-copy-scripts.sh`.

**Problem:** `saveResult` stamps `detected_at` for `not-enough-history`, and `listDue` then excludes the site for 30 days. Checking a site at 41 producing days delays eligibility until approximately day 71.

**Chosen policy:**
- A `not-enough-history` row is eligible once its last attempt is at least 24 hours old, regardless of `detected_at`.
- A successful detection retains the existing 30-day refresh cadence.
- Keep the existing cadence for `low-confidence`; do not silently expand this fix to daily expensive retries of all results.
- Preserve pending-location handling, failure retention, beta-owner gating, coordinate guards, limit/order and attempt throttling.
- Prefer a status-aware `listDue` predicate over redefining historical timestamps: include `status = 'not-enough-history'` in the existing detection-age disjunction, with the attempt-age condition still applying to every result.
- Apply the rule to existing insufficient-history rows too; no backfill or re-posted location should be necessary. Define the 24-hour boundary inclusively and test it.

Checklist:
- [ ] Add failing tests with a fixed evaluation time: insufficient history at 23h59m is not due; at 24h and 25h is due even with recent `detected_at`.
- [ ] Successful/low-confidence rows with recent `detected_at` remain excluded; old successful results obey both age gates.
- [ ] Missing location and non-beta owner remain excluded; same-location POST does not bypass throttling.
- [ ] Exercise the repository's actual SQL against a disposable local Postgres instance. Mock assertions that only match SQL strings are not enough to prove scheduling behavior. Use synthetic minimal Site/User fixtures and isolated teardown; never redirect this harness to an existing Dev/production DB. Standalone scripts must load dotenv before application imports, while explicitly choosing the disposable DB.
- [ ] Change the predicate and run the regression suite. Add a runner/service regression showing a subsequent attempt can replace insufficient history with a detected result.
- [ ] Update schedule comments in the original plan and operational documentation; do not edit already-applied migration SQL just to change a comment.
- [ ] Commit: `fix(solar): retry insufficient history after one day`.

## Task 2 — Make hourly completeness represent actual interval coverage

**Files:** `src/lib/solar-layout/hourly-actuals.ts`, `src/lib/solar-layout/hourly-actuals.test.ts`, `src/app/api/mobile/solar-actuals/route.test.ts`.

**Reproduction:** Eleven samples at 15:00, 15:05, …, 15:50 plus a sample at 15:00:01 currently return `complete: true` and count both readings near 15:00, despite no 15:55 interval.

**Chosen policy for this correction endpoint:**
- Keep UTC-hour buckets and interval-start semantics.
- Complete means exactly the 12 expected aligned five-minute slots contain usable finite, nonnegative solar Wh.
- Do not round an off-grid timestamp into a valid slot or infer missing energy. Off-grid rows mark their containing hour incomplete and contribute no energy to this endpoint's validated partial sum.
- Exact timestamp duplicates with identical valid values contribute once. Conflicting duplicates invalidate that slot and mark the hour incomplete; exclude the conflicted slot from the partial sum. The result must not depend on input order.
- Invalid finite-time measurements (negative, NaN, Infinity) mark their hour incomplete and contribute no energy. A zero is valid.
- Reject invalid Date timestamps explicitly rather than emitting an invalid hour key or silently manufacturing completeness. Use the existing route error handling; do not change the public response version.
- `wh` for incomplete hours is the sum of validated, unambiguous slots only. Document this meaning; the correction consumer must ignore incomplete hours. Never replace invalid values with a measured zero.

Checklist:
- [ ] Add the concrete 11-slots-plus-off-grid regression; expect incomplete and 1100 Wh for 100 Wh per valid slot.
- [ ] Test valid 12 slots, missing slot, identical duplicate, conflicting duplicate in both input orders, invalid measurement, valid zero and invalid timestamp.
- [ ] Test :55 stays in its UTC hour and the next :00 starts a new hour; verify separate UTC hours across a fall-back transition.
- [ ] Implement slot/quality tracking without changing history storage or shared archive decoding.
- [ ] Route test proves an incomplete aggregate remains incomplete in JSON and beta/auth/cache-control behavior is unchanged.
- [ ] Commit: `fix(solar): validate hourly actual coverage`.

## Task 3 — Correct local-day grouping in fractional-offset zones

**Files:** `src/lib/solar-layout/selection.ts`, `src/lib/solar-layout/selection.test.ts`; add detector-level coverage only if needed.

**Reproduction:** Process samples from 2026-10-27T18:00Z through 18:55Z in Asia/Kolkata. The UTC-hour date cache labels 18:30Z as October 27, although it is local midnight on October 28.

**Chosen fix:** Remove the UTC-hour date cache and format each regular five-minute series timestamp with the already-reused Intl formatter. Preserve interval-start local dates and midpoint sun calculations. If profiling shows meaningful cost, optimize using correct date boundaries or grid-slot keys; never assume midnight or offset changes align with a UTC hour.

Checklist:
- [ ] Add failing checks immediately before/at local midnight for Asia/Kolkata (+05:30) and Asia/Kathmandu (+05:45).
- [ ] Include America/St_Johns (negative fractional offset) and Australia/Lord_Howe (half-hour DST transition). Derive expected dates from explicit known boundaries or direct Intl formatting, not the helper under test.
- [ ] Preserve the existing Chicago spring/fall day counts and year-wide detector expectations. Test a partial input range so cache behavior cannot depend on its first timestamp.
- [ ] Implement, run selection and detector tests, and record the existing year-fixture runtime before/after on the same machine. Treat this as a regression comparison, not deployed timing evidence.
- [ ] Commit: `fix(solar): group samples by correct local dates`.

## Task 4 — Reconcile parity and the documented design

**Repo-root files:** original server plan and design spec; add a concise review/validation note in `docs/` if the evidence does not fit cleanly there. Use the implementation PR description for results.

The published PR reports one medium-confidence site (Rancho Palos Verdes) with Python one plane versus TypeScript two, despite the original gate requiring equal plane counts. Reported calibrated hourly error improves from 16.0% to 15.3%. That is evidence for considering an exception, not evidence that the existing gate passed.

Checklist:
- [ ] Mark original parity as partially met, with the exact plane-count exception and the fact that Python confidence was calculated using the TS rule. Label figures as reported by #244 unless actually rerun.
- [ ] Retain the original acceptance gate; do not retroactively mark it passed or silently weaken it. Record owner acceptance of an exception as pending unless explicit approval exists.
- [ ] If private research inputs are available, run the existing parity script locally following its README, then the existing independent backtest workflow. Report plane count, confidence, error and runtime. Do not commit inputs, household coordinates or raw captures.
- [ ] If evidence is unavailable, document the missing input and leave that gate pending; do not reconstruct research fixtures.
- [ ] Keep the disclosed 3° edge-midpoint location check and fitting-rule deviations visible. This fix task does not retune those choices.
- [ ] Update the original plan to match the new retry and completeness policies. Keep the detector's output provider-independent; no Forecast.Solar convention conversion on the server.
- [ ] Commit: `docs(solar): reconcile server parity and review fixes`.

## Task 5 — Dev smoke-test runbook and deployment evidence

**Deliverable:** repo-root `docs/solar-forecast-dev-smoke-test.md`, with commands adapted to existing guarded Dev tooling and placeholders for secrets/user/site IDs. Any standalone helper loads dotenv first and never logs secret values.

Create the complete runbook even if the connected environment cannot execute it. Use existing authorization for Dev actions when available. If deployment, role mutation or live calls require additional approval, prepare the exact Dev target and reversible changes first; do not touch production.

Runbook sequence:
1. Verify the target deployment contains the fix commit, the DB is the intended Dev DB, required migrations are applied, and the cron target points to Dev. Capture identifiers without credentials.
2. Choose an authorized test account/site with sufficient history and a known approved approximate location. Snapshot any role/layout state that will be changed. Never use the agent's or an arbitrary phone's current location.
3. Establish the site's owner beta role using approved Dev tooling. Verify signed-out, wrong-site and non-beta cases with appropriate test sessions.
4. POST the rounded location and GET layout. For a new/changed location expect pending. An unchanged existing location intentionally does not force re-detection; use a fresh test fixture or a documented Dev-only reset rather than falsifying the location.
5. Trigger one authenticated Dev cron request, or observe the scheduled run. Record HTTP result, per-site outcome, elapsed time, persistence and deployed commit. Confirm the chosen site was actually due and processed; the cron processes at most five sites, so an empty/success response alone is not proof.
6. GET layout and actuals through the mobile routes. Confirm scope, beta flag, private/no-store, returned geometry/confidence or an honest reason, finite Wh and complete-hour semantics. Compare selected returned hours with independently computed raw Dev samples.
7. Demonstrate insufficient-history retry behavior using the disposable DB tests, not a 24-hour wait or production timestamp changes. Confirm the deployed query matches the tested fix.
8. Remove only the temporary beta role if added, restore only deliberately modified Dev fixture state, and verify disabled responses. Record cleanup and anything intentionally retained.
9. Record measured server timing and available egress evidence separately from the PR's laptop/runtime estimates. Successful detection is required to validate the full deployed path; low-confidence or insufficient-history is valid behavior but leaves that path unproven.

Acceptance: every step is either supported by recorded evidence or explicitly pending with a blocker. Do not enable broad beta/production rollout as part of the smoke test.

## Final verification and handoff

From `cmd/next-app`:
```sh
npm test -- --run src/lib/solar-layout src/lib/solar-layout-repo.test.ts src/lib/solar-forecast-beta.test.ts src/app/api/mobile/solar-layout src/app/api/mobile/solar-actuals src/app/api/cron/detect-solar-layouts
npm run lint
npm test -- --run
npm run build
```

Also run the new disposable-Postgres harness and `git diff --check`. Use an isolated worktree/build output so the user's development server is not disrupted. No native iOS code is changed, so no iOS test run is needed.

The draft implementation PR must contain:
- Concrete before/after behavior for all three fixes.
- Test results, database behavior-test evidence, and any environment blockers.
- Explicit parity status and whether the plane-count exception has owner approval.
- Dev smoke-test status with deployment commit and cleanup result, or a runnable runbook and precise blockers.
- Remaining rollout gates from the original design, including the independent day-ahead provider evaluation; server fixes do not satisfy that forecast-accuracy gate.

Done means the three code fixes and regression tests are complete and the documentation/runbook is accurate. Parity acceptance and live validation can remain explicitly blocked; they must never be represented as passed.
