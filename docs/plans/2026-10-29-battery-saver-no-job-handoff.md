# Battery Saver No-Job Handoff Plan

**Goal:** Finish and verify the change that turns off auto-detect Battery Saver after two reliable checks find no job.

**Architecture:** The existing monitor records no-job checks alongside its monitoring snapshot and restores the prior reserve through the existing guarded restore path. A detected increase keeps the session in normal auto-detect mode; fixed-duration sessions are unaffected.

**Tech stack:** TypeScript, Vitest, Next.js, Swift, Swift Testing, PostgreSQL.

**Current state:** Draft PR [#255](https://github.com/KevM/pwusage/pull/255), branch `fix/battery-saver-no-job`. The web suite passed (1,741 passed, 161 skipped), as did `npm run lint` and `npm run build` in `cmd/next-app`. The duplicate Swift variable was renamed and the two targeted iOS suites passed (26 tests). The original implementation commit is unsigned because the configured 1Password signing agent failed.

## 1. Review the behavior

- [ ] Inspect `cmd/next-app/src/lib/battery-hold-monitoring.ts` and `battery-hold-monitor-service.ts`, plus their tests. Confirm two separate monitoring checks require fresh, advancing post-start samples; repeated checks and missing or stale readings must not count.
- [ ] Confirm a previously detected increase remains remembered even if later history is missing, and that fixed-duration sessions do not use the no-job decision.
- [ ] Verify the restoration still honors the existing guard against overwriting reserve changes made in Tesla, and that failed or uncertain restoration is retried using the existing reconciliation path.
- [ ] Review the iOS wording and the `no_load_detected` Live Activity reason in `cmd/ios-app/PWUsage/Views/BatteryHold/` and `cmd/ios-app/Shared/BatteryHold/`. Correct any issue found, adding a focused failing test before changing behavior.

## 2. Verify on the local Mac

- [x] Rename the newly added `waiting` string in `cmd/ios-app/PWUsageTests/battery-hold-tests.swift` and its assertion to avoid the existing local variable of the same name.
- [x] Run `cd cmd/ios-app && ./run-tests.sh BatteryHoldActivityPresentationTests BatteryHoldTests`. Both suites passed, with 26 tests executed.
- [ ] Run `swiftlint --strict` from the repository root. The repository has existing baseline violations; confirm no new violations arise from the changed lines.
- [ ] If code changes are necessary, rerun the affected tests and run `npm test -- --run`, `npm run lint`, and `npm run build` from `cmd/next-app`.

## 3. Finish the draft PR

- [ ] Inspect the checks on PR #255 and resolve any failures attributable to this change.
- [ ] Commit and push any necessary fixes. If signed commits are required, resolve the 1Password signing issue and replace or sign the existing commit as appropriate.
- [ ] Update the PR description with actual verification results and any remaining limitations. Keep it in draft unless the user requests otherwise.
